import type { DiscordConversationTarget } from "./chat-config.js";

export async function sendDiscordMessage(target: DiscordConversationTarget, content: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(`https://discord.com/api/v10/channels/${target.channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${target.botToken}`, "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message || `Discord message failed with HTTP ${response.status}`);
  }
}
