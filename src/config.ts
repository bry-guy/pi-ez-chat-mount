import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CONFIG_JSON_PATH } from "./paths.js";

export type ChatMountConfig = {
  sourceDir: string;
  cloneMode: "full" | "shallow";
};

function expandHome(input: string): string {
  return input === "~" || input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
}

export function defaultSourceDir(cwd = process.cwd()): string {
  const dev = join(homedir(), "dev");
  if (cwd.startsWith(`${dev}/`) || cwd === dev) return dev;
  return dev;
}

export function normalizeConfig(raw: Partial<ChatMountConfig> | undefined, cwd = process.cwd()): ChatMountConfig {
  const sourceDir = raw?.sourceDir?.trim() || process.env.PI_EZ_CHAT_MOUNT_SOURCE_DIR || defaultSourceDir(cwd);
  const cloneMode = raw?.cloneMode === "shallow" ? "shallow" : "full";
  return { sourceDir: resolve(expandHome(sourceDir)), cloneMode };
}

export async function loadConfig(filePath = CONFIG_JSON_PATH, cwd = process.cwd()): Promise<ChatMountConfig> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Partial<ChatMountConfig>;
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
