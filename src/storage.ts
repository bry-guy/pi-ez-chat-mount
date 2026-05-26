import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEBUG_LOG_PATH, LAST_APPLY_JSON_PATH, MOUNTS_JSON_PATH } from "./paths.js";
import type { LastApplyState, MountStore } from "./types.js";

async function ensureParent(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function loadMountStore(filePath = MOUNTS_JSON_PATH): Promise<MountStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as MountStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function saveMountStore(store: MountStore, filePath = MOUNTS_JSON_PATH): Promise<void> {
  await ensureParent(filePath);
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export async function appendDebugLine(message: string, filePath = DEBUG_LOG_PATH): Promise<void> {
  await ensureParent(filePath);
  await appendFile(filePath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

export async function writeLastApply(state: LastApplyState, filePath = LAST_APPLY_JSON_PATH): Promise<void> {
  await ensureParent(filePath);
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function readLastApply(filePath = LAST_APPLY_JSON_PATH): Promise<LastApplyState | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as LastApplyState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
