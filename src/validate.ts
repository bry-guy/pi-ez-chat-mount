import { stat } from "node:fs/promises";
import path from "node:path";
import type { AppliedMount, ConversationMounts, MountEntry, SkippedMount } from "./types.js";

const RESERVED = ["/", "/workspace", "/shared"];

export function validateGuestPath(guestPath: string): string | undefined {
  if (!guestPath.startsWith("/")) return "guest path must be absolute";
  if (RESERVED.includes(guestPath)) return `guest path ${guestPath} is reserved`;
  for (const reserved of RESERVED.slice(1)) {
    if (guestPath.startsWith(`${reserved}/`)) return `guest path cannot be under ${reserved}`;
  }
  if (guestPath.includes("//") || guestPath.split("/").includes("..")) return "guest path must be normalized";
  return undefined;
}

export function equalMount(a: MountEntry, b: MountEntry): boolean {
  return a.hostPath === b.hostPath && a.mode === b.mode;
}

export async function partitionMounts(configured: ConversationMounts): Promise<{ applied: AppliedMount[]; skipped: SkippedMount[] }> {
  const applied: AppliedMount[] = [];
  const skipped: SkippedMount[] = [];
  const seen = new Set<string>();
  for (const [guestPath, entry] of Object.entries(configured)) {
    const normalizedGuest = path.posix.normalize(guestPath);
    const validation = validateGuestPath(guestPath) || (normalizedGuest !== guestPath ? "guest path must be normalized" : undefined);
    if (validation) {
      skipped.push({ guestPath, ...entry, reason: validation });
      continue;
    }
    if (seen.has(guestPath)) {
      skipped.push({ guestPath, ...entry, reason: "duplicate guest path" });
      continue;
    }
    seen.add(guestPath);
    try {
      await stat(entry.hostPath);
      applied.push({ guestPath, ...entry });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      skipped.push({ guestPath, ...entry, reason: code === "ENOENT" ? "host path missing" : `host path unavailable: ${String(code || error)}` });
    }
  }
  return { applied, skipped };
}
