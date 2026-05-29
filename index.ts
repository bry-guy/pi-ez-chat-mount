import type { CommandContext, ExtensionAPI, NotifyLevel } from "./src/pi-types.js";
import { deriveGuestPath, normalizeUnmountName } from "./src/mount-name.js";
import { getPersistedConversationId } from "./src/conversation.js";
import { equalMount } from "./src/validate.js";
import { loadMountStore, readLastApply, saveMountStore } from "./src/storage.js";
import { CONFIG_JSON_PATH, MOUNTS_JSON_PATH } from "./src/paths.js";
import { tryInstallRuntimeWrapper } from "./src/wrapper.js";
import { matchSlashCommand } from "./src/match.js";
import { loadConfig } from "./src/config.js";
import { parseMountTarget, type MountTarget } from "./src/target.js";
import { resolveCurrentRepoHostPath, resolveTargetHostPath } from "./src/resolve.js";
import { scheduleCurrentTmuxPaneRespawn } from "./src/restart.js";
import type { MountEntry, MountMode } from "./src/types.js";

type CommandResult = { message: string; level?: NotifyLevel; changed?: boolean };

type MountArgs = {
  mode: MountMode;
  force: boolean;
  sourceDir?: string;
  forge?: string;
  target?: MountTarget;
  rawTarget?: string;
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
  const parsed: MountArgs = { mode: "rw", force: false };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--read-only") parsed.mode = "ro";
    else if (token === "--force") parsed.force = true;
    else if (token === "--source-dir") parsed.sourceDir = tokens[++i];
    else if (token.startsWith("--source-dir=")) parsed.sourceDir = token.slice("--source-dir=".length);
    else if (token === "--forge") parsed.forge = tokens[++i];
    else if (token.startsWith("--forge=")) parsed.forge = token.slice("--forge=".length);
    else if (token === "--update") throw new Error("--update has been removed; manage repository state with git from inside the mounted VM.");
    else if (token.startsWith("-")) throw new Error("Usage: /chat-mount [repo-name|owner/repo|repo-url] [--read-only] [--force] [--forge github|gitlab|bitbucket] [--source-dir <dir>]");
    else positional.push(token);
  }
  if (positional.length > 1) throw new Error("Usage: /chat-mount [repo-name|owner/repo|repo-url] [--read-only] [--force] [--forge github|gitlab|bitbucket] [--source-dir <dir>]");
  parsed.rawTarget = positional[0];
  return parsed;
}

function reloadHint(changed: boolean): string {
  if (!changed) return "";
  return "\n\nGondolin VM must be restarted.";
}

async function resolveMountHostPath(args: MountArgs, ctx: CommandContext): Promise<{ hostPath: string; resolutionMessage?: string }> {
  const resolved = args.rawTarget
    ? await resolveTargetHostPath(args.rawTarget, ctx, { force: args.force, sourceDir: args.sourceDir, forge: args.forge })
    : await resolveCurrentRepoHostPath(ctx);
  return { hostPath: resolved.hostPath, resolutionMessage: resolved.message };
}

async function resolveUnmountGuestPath(raw: string, ctx: CommandContext): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) {
    const current = await resolveCurrentRepoHostPath(ctx);
    return deriveGuestPath(current.hostPath);
  }
  if (trimmed.startsWith("/")) return normalizeUnmountName(trimmed);

  const config = await loadConfig(undefined, ctx.cwd);
  const target = parseMountTarget(trimmed, config.defaultForge);
  if (!target) return normalizeUnmountName(trimmed);
  return `/${target.slug.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")}`;
}

async function chatMount(raw: string, ctx: CommandContext): Promise<CommandResult> {
  const args = parseMountArgs(raw);
  const conversationId = requireConversationId(ctx);
  const { hostPath, resolutionMessage } = await resolveMountHostPath(args, ctx);
  const guestPath = deriveGuestPath(hostPath);
  const entry: MountEntry = { hostPath, mode: args.mode };
  const store = await loadMountStore();
  const existing = store[conversationId]?.[guestPath];
  if (existing) {
    if (equalMount(existing, entry)) {
      return { message: `${guestPath} is already configured for ${conversationId}.${resolutionMessage ? `\n${resolutionMessage}` : ""}` };
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
      `${resolutionMessage ? `\n${resolutionMessage}` : ""}`,
  };
}

async function chatUnmount(raw: string, ctx: CommandContext): Promise<CommandResult> {
  const conversationId = requireConversationId(ctx);
  const guestPath = await resolveUnmountGuestPath(raw, ctx);
  const store = await loadMountStore();
  if (!store[conversationId]?.[guestPath]) return { level: "warning", message: `No configured mount ${guestPath} for ${conversationId}.` };
  delete store[conversationId][guestPath];
  if (Object.keys(store[conversationId]).length === 0) delete store[conversationId];
  await saveMountStore(store);
  return { changed: true, message: `Removed ${guestPath} for ${conversationId}.` };
}

async function chatUnmountAll(ctx: CommandContext): Promise<CommandResult> {
  const conversationId = requireConversationId(ctx);
  const store = await loadMountStore();
  const count = Object.keys(store[conversationId] ?? {}).length;
  if (count === 0) return { level: "warning", message: `No configured mounts for ${conversationId}.` };
  delete store[conversationId];
  await saveMountStore(store);
  return { changed: true, message: `Removed ${count} configured mount${count === 1 ? "" : "s"} for ${conversationId}.` };
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
    lines.push(`\nconfigured for next VM reload — ${id}:`);
    const entries = Object.entries(mounts);
    if (entries.length === 0) lines.push("  (no configured mounts)");
    for (const [guestPath, mount] of entries) lines.push(`  ${guestPath} -> ${mount.hostPath} (${mount.mode})`);
  }
  const last = await readLastApply();
  if (last && (!conversationId || last.conversationId === conversationId)) {
    lines.push(`\nactive in current/last VM snapshot for ${last.conversationId} at ${last.at}:`);
    lines.push(`  applied: ${last.applied.map((m) => m.guestPath).join(", ") || "none"}`);
    lines.push(`  skipped: ${last.skipped.map((m) => `${m.guestPath} (${m.reason})`).join(", ") || "none"}`);
  }
  return { message: lines.join("\n") };
}

function fenced(text: string): string {
  return `\`\`\`\n${text.replace(/```/g, "`​``")}\n\`\`\``;
}

function remoteResult(command: string, result: CommandResult) {
  let suffix = reloadHint(result.changed ?? false);
  if (result.changed) {
    const restart = scheduleCurrentTmuxPaneRespawn();
    suffix = `\n\n${restart.message}`;
  }
  return {
    action: "transform" as const,
    text: `The remote /${command} command completed. Reply to the user with exactly this fenced code block and no other text:\n\n${fenced(`${result.message}${suffix}`)}`,
  };
}

function remoteError(command: string, error: unknown) {
  return {
    action: "transform" as const,
    text: `The remote /${command} command failed. Reply to the user with exactly this fenced code block and no other text:\n\n${fenced(error instanceof Error ? error.message : String(error))}`,
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

  pi.registerCommand("chat-unmount-all", {
    description: "Remove every configured pi-chat sibling mount for the connected conversation",
    handler: async (_args, ctx) => {
      try {
        const result = await chatUnmountAll(ctx);
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

  pi.on?.("input", async (event, ctx) => {
    const match = matchSlashCommand(event.text, ["chat-mount", "chat-unmount", "chat-unmount-all", "chat-mounts"]);
    if (!match) return { action: "continue" };
    try {
      if (match.name === "chat-mount") return remoteResult(match.name, await chatMount(match.args, ctx));
      if (match.name === "chat-unmount") return remoteResult(match.name, await chatUnmount(match.args, ctx));
      if (match.name === "chat-unmount-all") return remoteResult(match.name, await chatUnmountAll(ctx));
      return remoteResult(match.name, await chatMounts(ctx, wrapper));
    } catch (error) {
      return remoteError(match.name, error);
    }
  });
}
