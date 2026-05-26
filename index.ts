import type { CommandContext, ExtensionAPI, NotifyLevel } from "./src/pi-types.js";
import { resolve } from "node:path";
import { deriveGuestPath, normalizeUnmountName } from "./src/mount-name.js";
import { getPersistedConversationId } from "./src/conversation.js";
import { equalMount } from "./src/validate.js";
import { loadMountStore, readLastApply, saveMountStore } from "./src/storage.js";
import { MOUNTS_JSON_PATH } from "./src/paths.js";
import { tryInstallRuntimeWrapper } from "./src/wrapper.js";
import type { MountEntry } from "./src/types.js";

function notice(ctx: { ui: { notify(message: string, level?: NotifyLevel): void } }, message: string, level: NotifyLevel = "info") {
  ctx.ui.notify(message, level);
}

function requireConversationId(ctx: Pick<CommandContext, "sessionManager">): string {
  const id = getPersistedConversationId(ctx);
  if (!id) throw new Error("No pi-chat conversation is connected in this session. Run /chat-connect first.");
  return id;
}

function parseMountArgs(args: string): { mode: "rw" | "ro"; force: boolean } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const allowed = new Set(["--read-only", "--force"]);
  for (const token of tokens) {
    if (!allowed.has(token)) throw new Error("Usage: /chat-mount [--read-only] [--force]");
  }
  return { mode: tokens.includes("--read-only") ? "ro" : "rw", force: tokens.includes("--force") };
}

export default async function (pi: ExtensionAPI) {
  const wrapper = await tryInstallRuntimeWrapper();

  pi.registerCommand("chat-mount", {
    description: "Mount this pi session cwd into the connected pi-chat Gondolin VM after restart",
    handler: async (args, ctx) => {
      try {
        const { mode, force } = parseMountArgs(args);
        const conversationId = requireConversationId(ctx);
        const hostPath = resolve(ctx.cwd);
        const guestPath = deriveGuestPath(hostPath);
        const entry: MountEntry = { hostPath, mode };
        const store = await loadMountStore();
        const existing = store[conversationId]?.[guestPath];
        if (existing) {
          if (equalMount(existing, entry)) {
            notice(ctx, `${guestPath} is already configured for ${conversationId}. Restart the pi-chat sandbox if it is not visible yet.`);
            return;
          }
          if (!force) {
            notice(
              ctx,
              `Mount ${guestPath} already exists for ${conversationId}: ${existing.hostPath} (${existing.mode}). ` +
                `Refusing to clobber it with ${hostPath} (${mode}) without confirmation. ` +
                `If you want to replace the existing repo mount, rerun: /chat-mount${mode === "ro" ? " --read-only" : ""} --force`,
              "warning",
            );
            return;
          }
        }
        store[conversationId] = { ...(store[conversationId] ?? {}), [guestPath]: entry };
        await saveMountStore(store);
        notice(
          ctx,
          `${existing ? "Replaced" : "Configured"} ${guestPath} -> ${hostPath} (${mode}) for ${conversationId}. ` +
            `Restart the pi-chat sandbox (for example /chat-new or reconnect) for it to apply.`,
          existing ? "warning" : "info",
        );
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("chat-unmount", {
    description: "Remove a configured pi-chat sibling mount by name",
    handler: async (args, ctx) => {
      try {
        const conversationId = requireConversationId(ctx);
        const guestPath = normalizeUnmountName(args);
        const store = await loadMountStore();
        if (!store[conversationId]?.[guestPath]) {
          notice(ctx, `No configured mount ${guestPath} for ${conversationId}.`, "warning");
          return;
        }
        delete store[conversationId][guestPath];
        if (Object.keys(store[conversationId]).length === 0) delete store[conversationId];
        await saveMountStore(store);
        notice(ctx, `Removed ${guestPath} for ${conversationId}. Restart the pi-chat sandbox for the change to apply.`);
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("chat-mounts", {
    description: "List configured and last-applied pi-chat sibling mounts",
    handler: async (_args, ctx) => {
      try {
        const conversationId = getPersistedConversationId(ctx);
        const store = await loadMountStore();
        const ids = conversationId ? [conversationId] : Object.keys(store).sort();
        const lines: string[] = [];
        lines.push(`storage: ${MOUNTS_JSON_PATH}`);
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
        notice(ctx, lines.join("\n"));
      } catch (error) {
        notice(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
