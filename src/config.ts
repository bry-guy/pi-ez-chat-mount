import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONFIG_JSON_PATH } from "./paths.js";
import { parseForge, type ForgeName } from "./target.js";

export type ChatMountConfig = {
  sourceDir: string;
  cloneMode: "full" | "shallow";
  defaultForge: ForgeName;
};

type RawConfig = Partial<ChatMountConfig> & { sourceDirs?: string[] };

export function expandHome(input: string): string {
  return input === "~" || input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
}

export function defaultSourceDir(cwd = process.cwd()): string {
  const dev = join(homedir(), "dev");
  if (cwd.startsWith(`${dev}/`) || cwd === dev) return dev;
  return dev;
}

export function normalizeConfig(raw: RawConfig | undefined, cwd = process.cwd()): ChatMountConfig {
  const sourceDirRaw = raw?.sourceDir?.trim() || raw?.sourceDirs?.[0]?.trim() || process.env.PI_EZ_CHAT_MOUNT_SOURCE_DIR || defaultSourceDir(cwd);
  const cloneMode = raw?.cloneMode === "shallow" ? "shallow" : "full";
  const defaultForge = parseForge(raw?.defaultForge ?? process.env.PI_EZ_CHAT_MOUNT_DEFAULT_FORGE ?? "github");
  return { sourceDir: resolve(expandHome(sourceDirRaw)), cloneMode, defaultForge };
}

export async function loadConfig(filePath = CONFIG_JSON_PATH, cwd = process.cwd()): Promise<ChatMountConfig> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as RawConfig;
    return normalizeConfig(raw, cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalizeConfig(undefined, cwd);
    throw error;
  }
}

export async function saveConfig(config: ChatMountConfig, filePath = CONFIG_JSON_PATH): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
