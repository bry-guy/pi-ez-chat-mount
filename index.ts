import type { CommandContext, ExtensionAPI, NotifyLevel } from "./src/pi-types.js";
import { deriveGuestPath, normalizeUnmountName } from "./src/mount-name.js";
import { getPersistedConversationId } from "./src/conversation.js";
import { equalMount } from "./src/validate.js";
import { loadMountStore, readLastApply, saveMountStore } from "./src/storage.js";
import { CONFIG_JSON_PATH, MOUNTS_JSON_PATH } from "./src/paths.js";
import { tryInstallRuntimeWrapper } from "./src/wrapper.js";
import { CHAT_VM_RESTART_HINT, matchSlashCommand } from "./src/match.js";
import { loadConfig } from "./src/config.js";
import { parseMountTarget } from "./src/target.js";
import { resolveCurrentRepoHostPath, resolveTargetHostPath } from "./src/resolve.js";
import type { MountEntry, MountMode } from "./src/types.js";

type CommandResult = { message: string; level?: NotifyLevel; changed?: boolean };

type MountArgs = {
  mode: MountMode;
  force: boolean;
  sourceDir?: string;
  forge?: string;
  rawTargets: string[];
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

const MOUNT_USAGE =
  "Usage: /chat-mount [target ...] [--read-only] [--force] [--forge github|gitlab|bitbucket] [--source-dir <dir>]\n" +
  "  each target is a repo-name, owner/repo, or repo-url; with no targets, mounts the current cwd's git repo.";

export function parseMountArgs(args: string): MountArgs {
  const tokens = tokenize(args);
  const positional: string[] = [];
  const parsed: MountArgs = { mode: "rw", force: false, rawTargets: [] };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--read-only") parsed.mode = "ro";
    else if (token === "--force") parsed.force = true;
    else if (token === "--source-dir") parsed.sourceDir = tokens[++i];
    else if (token.startsWith("--source-dir=")) parsed.sourceDir = token.slice("--source-dir=".length);
    else if (token === "--forge") parsed.forge = tokens[++i];
    else if (token.startsWith("--forge=")) parsed.forge = token.slice("--forge=".length);
    else if (token === "--update") throw new Error("--update has been removed; manage repository state with git from inside the mounted VM.");
    else if (token.startsWith("-")) throw new Error(MOUNT_USAGE);
    else positional.push(token);
  }
  parsed.rawTargets = positional;
  return parsed;
}

function reloadHint(changed: boolean): string {
  if (!changed) return "";
  return `\n\n${CHAT_VM_RESTART_HINT}`;
}

type ResolvedMountTarget = { rawTarget?: string; hostPath: string; resolutionMessage?: string };

async function resolveOneMountTarget(rawTarget: string | undefined, args: MountArgs, ctx: CommandContext): Promise<ResolvedMountTarget> {
  const resolved = rawTarget
    ? await resolveTargetHostPath(rawTarget, ctx, { force: args.force, sourceDir: args.sourceDir, forge: args.forge })
    : await resolveCurrentRepoHostPath(ctx);
  return { rawTarget, hostPath: resolved.hostPath, resolutionMessage: resolved.message };
}

async function resolveAllMountTargets(args: MountArgs, ctx: CommandContext): Promise<ResolvedMountTarget[]> {
  if (args.rawTargets.length === 0) return [await resolveOneMountTarget(undefined, args, ctx)];
  const out: ResolvedMountTarget[] = [];
  const errors: string[] = [];
  for (const target of args.rawTargets) {
    try {
      out.push(await resolveOneMountTarget(target, args, ctx));
    } catch (error) {
      errors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length > 0) throw new Error(`Failed to resolve ${errors.length} target${errors.length === 1 ? "" : "s"}:\n  ${errors.join("\n  ")}`);
  return out;
}

async function resolveUnmountGuestPathFromToken(token: string, ctx: CommandContext): Promise<string> {
  if (token.startsWith("/")) return normalizeUnmountName(token);
  const config = await loadConfig(undefined, ctx.cwd);
  const target = parseMountTarget(token, config.defaultForge);
  if (!target) return normalizeUnmountName(token);
  return `/${target.slug.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")}`;
}

async function resolveAllUnmountGuestPaths(raw: string, ctx: CommandContext): Promise<string[]> {
  const tokens = tokenize(raw);
  if (tokens.length === 0) {
    const current = await resolveCurrentRepoHostPath(ctx);
    return [deriveGuestPath(current.hostPath)];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const guest = await resolveUnmountGuestPathFromToken(token, ctx);
    if (!seen.has(guest)) {
      seen.add(guest);
      out.push(guest);
    }
  }
  return out;
}

type PlannedMount = {
  rawTarget?: string;
  guestPath: string;
  hostPath: string;
  mode: MountMode;
  resolutionMessage?: string;
  existing?: MountEntry;
  status: "added" | "replaced" | "unchanged" | "conflict";
};

async function chatMount(raw: string, ctx: CommandContext): Promise<CommandResult> {
  const args = parseMountArgs(raw);
  const conversationId = requireConversationId(ctx);
  const resolved = await resolveAllMountTargets(args, ctx);

  // Detect duplicate guest paths within this single invocation so we never write
  // a half-applied batch where the last target silently overwrites earlier ones.
  const plans: PlannedMount[] = resolved.map((r) => ({
    rawTarget: r.rawTarget,
    guestPath: deriveGuestPath(r.hostPath),
    hostPath: r.hostPath,
    mode: args.mode,
    resolutionMessage: r.resolutionMessage,
    status: "added",
  }));
  const guestSeen = new Map<string, number>();
  for (const [index, plan] of plans.entries()) {
    const prior = guestSeen.get(plan.guestPath);
    if (prior !== undefined) {
      const a = plans[prior];
      throw new Error(
        `Targets ${a.rawTarget ?? "(current repo)"} and ${plan.rawTarget ?? "(current repo)"} both resolve to guest path ${plan.guestPath}. ` +
          "Rename one of them or invoke /chat-mount separately for each.",
      );
    }
    guestSeen.set(plan.guestPath, index);
  }

  const store = await loadMountStore();
  const existingForConversation = store[conversationId] ?? {};
  for (const plan of plans) {
    const existing = existingForConversation[plan.guestPath];
    plan.existing = existing;
    const entry: MountEntry = { hostPath: plan.hostPath, mode: plan.mode };
    if (!existing) plan.status = "added";
    else if (equalMount(existing, entry)) plan.status = "unchanged";
    else if (args.force) plan.status = "replaced";
    else plan.status = "conflict";
  }

  const writes = plans.filter((p) => p.status === "added" || p.status === "replaced");
  if (writes.length > 0) {
    const next = { ...existingForConversation };
    for (const p of writes) next[p.guestPath] = { hostPath: p.hostPath, mode: p.mode };
    store[conversationId] = next;
    await saveMountStore(store);
  }

  return formatMountResult(plans, conversationId);
}

function formatMountResult(plans: PlannedMount[], conversationId: string): CommandResult {
  const added = plans.filter((p) => p.status === "added");
  const replaced = plans.filter((p) => p.status === "replaced");
  const unchanged = plans.filter((p) => p.status === "unchanged");
  const conflicts = plans.filter((p) => p.status === "conflict");
  const changed = added.length + replaced.length > 0;

  const lines: string[] = [];
  for (const p of added) lines.push(`Configured ${p.guestPath} -> ${p.hostPath} (${p.mode}) for ${conversationId}.`);
  for (const p of replaced) lines.push(`Replaced ${p.guestPath} -> ${p.hostPath} (${p.mode}) for ${conversationId}.`);
  for (const p of unchanged) lines.push(`${p.guestPath} is already configured for ${conversationId}.`);
  for (const p of conflicts) {
    const existing = p.existing!;
    lines.push(
      `Mount ${p.guestPath} already exists for ${conversationId}: ${existing.hostPath} (${existing.mode}). ` +
        `Refusing to clobber it with ${p.hostPath} (${p.mode}) without confirmation. ` +
        `Rerun with --force to replace it.`,
    );
  }
  for (const p of plans) if (p.resolutionMessage) lines.push(p.resolutionMessage);

  let level: NotifyLevel | undefined;
  if (conflicts.length > 0) level = "warning";
  else if (replaced.length > 0) level = "warning";
  return { changed, level, message: lines.join("\n") || `No mounts to configure for ${conversationId}.` };
}

async function chatUnmount(raw: string, ctx: CommandContext): Promise<CommandResult> {
  const conversationId = requireConversationId(ctx);
  const guestPaths = await resolveAllUnmountGuestPaths(raw, ctx);
  const store = await loadMountStore();
  const conversationMounts = store[conversationId];
  const removed: string[] = [];
  const missing: string[] = [];
  for (const guestPath of guestPaths) {
    if (conversationMounts?.[guestPath]) {
      delete conversationMounts[guestPath];
      removed.push(guestPath);
    } else {
      missing.push(guestPath);
    }
  }
  if (removed.length > 0) {
    if (conversationMounts && Object.keys(conversationMounts).length === 0) delete store[conversationId];
    await saveMountStore(store);
  }
  const lines: string[] = [];
  for (const g of removed) lines.push(`Removed ${g} for ${conversationId}.`);
  for (const g of missing) lines.push(`No configured mount ${g} for ${conversationId}.`);
  return {
    changed: removed.length > 0,
    level: removed.length === 0 ? "warning" : missing.length > 0 ? "warning" : undefined,
    message: lines.join("\n") || `No configured mounts to remove for ${conversationId}.`,
  };
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

async function remoteResult(command: string, result: CommandResult, _ctx: CommandContext) {
  const suffix = reloadHint(result.changed ?? false);
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
    description: "Mount this cwd, or one or more git repositories, into the connected pi-chat Gondolin VM after restart",
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
    description: "Remove one or more configured pi-chat sibling mounts by name",
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
      if (match.name === "chat-mount") return remoteResult(match.name, await chatMount(match.args, ctx), ctx);
      if (match.name === "chat-unmount") return remoteResult(match.name, await chatUnmount(match.args, ctx), ctx);
      if (match.name === "chat-unmount-all") return remoteResult(match.name, await chatUnmountAll(ctx), ctx);
      return remoteResult(match.name, await chatMounts(ctx, wrapper), ctx);
    } catch (error) {
      return remoteError(match.name, error);
    }
  });
}
