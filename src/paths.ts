import { homedir } from "node:os";
import { join } from "node:path";

export const CHAT_MOUNT_DIR = join(homedir(), ".pi", "agent", "chat-mount");
export const MOUNTS_JSON_PATH = join(CHAT_MOUNT_DIR, "mounts.json");
export const DEBUG_LOG_PATH = join(CHAT_MOUNT_DIR, "debug.log");
export const LAST_APPLY_JSON_PATH = join(CHAT_MOUNT_DIR, "last-apply.json");
export const PI_CHAT_STATE_CUSTOM_TYPE = "pi-chat-state";
