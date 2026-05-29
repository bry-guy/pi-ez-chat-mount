import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const PI_CHAT_CONFIG_PATH = join(homedir(), ".pi", "agent", "chat", "config.json");

export type DiscordConversationTarget = {
  botToken: string;
  channelId: string;
};

type ChatConfig = {
  accounts?: Record<string, {
    service?: string;
    botToken?: string;
    channels?: Record<string, { id?: string }>;
  }>;
};

export async function getDiscordConversationTarget(conversationId: string, path = PI_CHAT_CONFIG_PATH): Promise<DiscordConversationTarget | undefined> {
  const slash = conversationId.indexOf("/");
  if (slash === -1) return undefined;
  const accountId = conversationId.slice(0, slash);
  const channelKey = conversationId.slice(slash + 1);
  const config = JSON.parse(await readFile(path, "utf8")) as ChatConfig;
  const account = config.accounts?.[accountId];
  const channel = account?.channels?.[channelKey];
  if (account?.service !== "discord" || !account.botToken || !channel?.id) return undefined;
  return { botToken: account.botToken, channelId: channel.id };
}
