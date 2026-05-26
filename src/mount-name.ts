import { basename } from "node:path";

export function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function deriveGuestPath(cwd: string): string {
  const repo = sanitizeSegment(basename(cwd));
  if (!repo) throw new Error("Could not derive a non-empty mount name from cwd");
  return `/${repo}`;
}

export function normalizeUnmountName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Usage: /chat-unmount <name>");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
