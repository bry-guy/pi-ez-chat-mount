import { homedir } from "node:os";
import { sep } from "node:path";
import type { VmCreateOptionsLike } from "./types.js";

const WORKSPACE_SUFFIX = `${sep}workspace`;

export function conversationIdFromWorkspaceHostPath(hostPath: string, home = homedir()): string | undefined {
  const normalized = hostPath.split(/[\\/]+/).join(sep);
  const root = `${home}${sep}.pi${sep}agent${sep}chat${sep}accounts${sep}`;
  if (!normalized.startsWith(root) || !normalized.endsWith(WORKSPACE_SUFFIX)) return undefined;
  const rest = normalized.slice(root.length, -WORKSPACE_SUFFIX.length);
  const parts = rest.split(sep);
  const channelsIndex = parts.indexOf("channels");
  if (channelsIndex !== 1 || parts.length < 3) return undefined;
  const accountId = parts[0];
  const channelKey = parts.slice(2).join("/");
  if (!accountId || !channelKey) return undefined;
  return `${accountId}/${channelKey}`;
}

export function providerRootPath(provider: unknown): string | undefined {
  if (!provider || typeof provider !== "object") return undefined;
  const value = (provider as { rootPath?: unknown }).rootPath;
  return typeof value === "string" ? value : undefined;
}

export function identifyConversation(opts: VmCreateOptionsLike): string | undefined {
  const workspaceProvider = opts.vfs?.mounts?.["/workspace"];
  const workspaceRoot = providerRootPath(workspaceProvider);
  if (workspaceRoot) {
    const parsed = conversationIdFromWorkspaceHostPath(workspaceRoot);
    if (parsed) return parsed;
  }

  const label = opts.sessionLabel?.trim();
  if (label?.startsWith("pi-chat ")) {
    // This is only a fallback. Prefer the workspace path because the label is a display name.
    const suffix = label.slice("pi-chat ".length).trim();
    if (suffix.includes("/")) return suffix;
  }
  return undefined;
}

export function getPersistedConversationId(ctx: { sessionManager: { getEntries(): unknown[] } }): string | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as Record<string, unknown>;
    if (entry.type !== "custom" || entry.customType !== "pi-chat-state") continue;
    const data = entry.data as { conversationId?: unknown } | undefined;
    if (typeof data?.conversationId === "string" && data.conversationId.trim()) return data.conversationId;
    return undefined;
  }
  return undefined;
}
