import type { CommandContext, ExtensionAPI, NotifyLevel } from "./src/pi-types.js";
import { resolve } from "node:path";
import { deriveGuestPath, normalizeUnmountName } from "./src/mount-name.js";
import { getPersistedConversationId } from "./src/conversation.js";
import { equalMount } from "./src/validate.js";
import { loadMountStore, readLastApply, saveMountStore } from "./src/storage.js";
import { CONFIG_JSON_PATH, MOUNTS_JSON_PATH } from "./src/paths.js";
import { tryInstallRuntimeWrapper } from "./src/wrapper.js";
import { matchSlashCommand } from "./src/match.js";
import { loadConfig } from "./src/config.js";
import { ensureRepoClone } from "./src/clone.js";
import { parseRepoSpec, type RepoSpec } from "./src/repo-spec.js";
import type { MountEntry, MountMode } from "./src/types.js";

type CommandResult = { message: string; level?: NotifyLevel; changed?: boolean };

type MountArgs = {
  mode: MountMode;
  force: boolean;
  update: boolean;
  sourceDir?: string;
  repo?: RepoSpec;
};

function notice(ctx: { ui: { notify(message: string, level?: NotifyLevel): void } }, message: string, level: NotifyLevel = "info") {
  ctx.ui.notify(message, level);
}

function requireConversationId(ctx: Pick<CommandContext, "sessionManager">): string {
  const id = getPersistedConversationId(ctx);
  if (!id) throw new Error("No pi-chat conversation is connected in this session. Run /chat-connect first.");
  return id;
}

function tokenize(raw: string): string[] {
  return raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
}

function parseMountArgs(args: string): MountArgs {
  const tokens = tokenize(args);
  const positional: string[] = [];
  const parsed: MountArgs = { mode: "rw", force: false, update: false };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--read-only") parsed.mode = "ro";
    else if (token === "--force") parsed.force = true;
    else if (token === "--update") parsed.update = true;
    else if (token === "--source-dir") parsed.sourceDir = tokens[++i];
    else if (token.startsWith("--source-dir=")) parsed.sourceDir = token.slice("--source-dir=".length);
    else if (token.startsWith("-")) throw new Error("Usage: /chat-mount [repo-url|owner/repo] [--read-only] [--force] [--update] [--source-dir <dir>]");
    else positional.push(token);
  }
  if (positional.length > 1) throw new Error("Usage: /chat-mount [repo-url|owner/repo] [--read-only] [--force] [--update] [--source-dir <dir>]");
  parsed.repo = positional[0] ? parseRepoSpec(positional[0]) : undefined;
  if (positional[0] && !parsed.repo) throw new Error(`Not a supported repository spec: ${positional[0]}`);
  if (parsed.update && !parsed.repo) throw new Error("--update only applies when mounting a repository spec");
  return parsed;
}

function reloadHint(changed: boolean): string {
  if (!changed) return "";
  if (process.env.PI_EZ_AUTO_RELOAD === "0") return "\n\nReload required: send @bot /new in the chat channel to recreate the pi-chat sandbox.";
  return "\n\nReload required: pi-chat does not expose an extension API for restarting the current sandbox from inside the VM yet. Send @bot /new (or /chat-reload if installed) in the chat channel.";
}

async function resolveMountHostPath(args: MountArgs, ctx: CommandContext): Promise<{ hostPath: string; cloneMessage?: string }> {
  if (!args.repo) return { hostPath: resolve(ctx.cwd) };
  const config = await loadConfig(undefined, ctx.cwd);
  if (args.sourceDir) config.sourceDir = resolve(args.sourceDir.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  const clone = await ensureRepoClone(args.repo, config, { force: args.force, update: args.update });
  return { hostPath: clone.hostPath, cloneMessage: clone.message };
}

async function chatMount(raw: string, ctx: CommandContext): Promise<CommandResult> {
  const args = parseMountArgs(raw);
  const conversationId = requireConversationId(ctx);
  const { hostPath, cloneMessage } = await resolveMountHostPath(args, ctx);
  const guestPath = deriveGuestPath(hostPath);
  const entry: MountEntry = { hostPath, mode: args.mode };
  const store = await loadMountStore();
  const existing = store[conversationId]?.[guestPath];
  if (existing) {
    if (equalMount(existing, entry)) {
      return { message: `${guestPath} is already configured for ${conversationId}.${cloneMessage ? `\n${cloneMessage}` : ""}` };
    }
    if (!args.force) {
      return {
        level: "warning",
        message:
          `Mount ${guestPath} already exists for ${conversationId}: ${existing.hostPath} (${existing.mode}). ` +
          `Refusing to clobber it with ${hostPath} (${args.mode}) without confirmation. ` +
          `Rerun with --force to replace it.`,
      };
    }
  }
  store[conversationId] = { ...(store[conversationId] ?? {}), [guestPath]: entry };
  await saveMountStore(store);
  return {
    level: existing ? "warning" : "info",
    changed: true,
    message:
      `${existing ? "Replaced" : "Configured"} ${guestPath} -> ${hostPath} (${args.mode}) for ${conversationId}.` +
      `${cloneMessage ? `\n${cloneMessage}` : ""}`,
  };
}

async function chatUnmount(raw: string, ctx: CommandContext): Promise<CommandResult> {
  const conversationId = requireConversationId(ctx);
  const guestPath = normalizeUnmountName(raw);
  const store = await loadMountStore();
  if (!store[conversationId]?.[guestPath]) return { level: "warning", message: `No configured mount ${guestPath} for ${conversationId}.` };
  delete store[conversationId][guestPath];
  if (Object.keys(store[conversationId]).length === 0) delete store[conversationId];
  await saveMountStore(store);
  return { changed: true, message: `Removed ${guestPath} for ${conversationId}.` };
}

async function chatMounts(ctx: CommandContext, wrapper: Awaited<ReturnType<typeof tryInstallRuntimeWrapper>>): Promise<CommandResult> {
  const conversationId = getPersistedConversationId(ctx);
  const store = await loadMountStore();
  const ids = conversationId ? [conversationId] : Object.keys(store).sort();
  const lines: string[] = [];
  lines.push(`storage: ${MOUNTS_JSON_PATH}`);
  lines.push(`config: ${CONFIG_JSON_PATH}`);
  lines.push(`VM.create wrapper: ${wrapper.error ? `not installed (${wrapper.error})` : wrapper.installed ? "installed" : "already installed"}`);
  for (const id of ids) {
    const mounts = store[id] ?? {};
    lines.push(`\n${id}:`);
    const entries = Object.entries(mounts);
    if (entries.length === 0) lines.push("  (no configured mounts)");
    for (const [guestPath, mount] of entries) lines.push(`  ${guestPath} -> ${mount.hostPath} (${mount.mode})`);
  }
  const last = await readLastApply();
  if (last && (!conversationId || last.conversationId === conversationId)) {
    lines.push(`\nlast VM apply for ${last.conversationId} at ${last.at}:`);
    lines.push(`  applied: ${last.applied.map((m) => m.guestPath).join(", ") || "none"}`);
    lines.push(`  skipped: ${last.skipped.map((m) => `${m.guestPath} (${m.reason})`).join(", ") || "none"}`);
  }
  return { message: lines.join("\n") };
}

function remoteResult(command: string, result: CommandResult) {
  return {
    action: "transform" as const,
    text: `The remote /${command} command completed. Reply to the user with this result exactly:\n\n${result.message}${reloadHint(result.changed ?? false)}`,
  };
}

function remoteError(command: string, error: unknown) {
  return {
    action: "transform" as const,
    text: `The remote /${command} command failed. Reply to the user with this error:\n\n${error instanceof Error ? error.message : String(error)}`,
  };
}

export default async function (pi: ExtensionAPI) {
  const wrapper = await tryInstallRuntimeWrapper();

  pi.registerCommand("chat-mount", {
    description: "Mount this cwd or a git repository into the connected pi-chat Gondolin VM after restart",
    handler: async (args, ctx) => {
      try {
        const result = await chatMount(args, ctx);
        notice(ctx, `${result.message}${reloadHint(result.changed ?? false)}`, result.level);
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("chat-unmount", {
    description: "Remove a configured pi-chat sibling mount by name",
    handler: async (args, ctx) => {
      try {
        const result = await chatUnmount(args, ctx);
        notice(ctx, `${result.message}${reloadHint(result.changed ?? false)}`, result.level);
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("chat-mounts", {
    description: "List configured and last-applied pi-chat sibling mounts",
    handler: async (_args, ctx) => {
      try {
        const result = await chatMounts(ctx, wrapper);
        notice(ctx, result.message, result.level);
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("chat-reload", {
    description: "Explain how to reload the current pi-chat sandbox",
    handler: (_args, ctx) => {
      notice(ctx, "Reload the pi-chat sandbox by sending @bot /new in the chat channel. pi-chat currently handles reload before extensions run, so /chat-reload cannot restart from inside the VM yet.", "warning");
    },
  });

  pi.on?.("input", async (event, ctx) => {
    const match = matchSlashCommand(event.text, ["chat-mount", "chat-unmount", "chat-mounts", "chat-reload"]);
    if (!match) return { action: "continue" };
    try {
      if (match.name === "chat-mount") return remoteResult(match.name, await chatMount(match.args, ctx));
      if (match.name === "chat-unmount") return remoteResult(match.name, await chatUnmount(match.args, ctx));
      if (match.name === "chat-mounts") return remoteResult(match.name, await chatMounts(ctx, wrapper));
      return {
        action: "transform",
        text: "The remote /chat-reload command cannot restart pi-chat from inside the VM because pi-chat handles /new before extension input hooks run. Reply to the user exactly: Send @bot /new as a separate message to reload this pi-chat sandbox.",
      };
    } catch (error) {
      return remoteError(match.name, error);
    }
  });
}
