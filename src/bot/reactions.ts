import type { MessageReaction, PartialMessageReaction, User, PartialUser } from "discord.js";
import { getChannel, isChannelAllowed, loadEnv } from "../config.ts";
import { logger } from "../logger.ts";
import { appendBlock } from "../storage/markdown.ts";
import { effectiveChannelId, getMessage, setReactions } from "../storage/messages.ts";

export async function handleReactionChange(
  reaction: MessageReaction | PartialMessageReaction,
  _user: User | PartialUser,
): Promise<void> {
  const full = reaction.partial ? await reaction.fetch() : reaction;
  const message = full.message.partial ? await full.message.fetch() : full.message;

  if (!isChannelAllowed(message.channelId)) return;

  const map: Record<string, number> = {};
  for (const [, r] of message.reactions.cache) {
    const name = r.emoji.name;
    if (name && r.count) map[name] = r.count;
  }

  setReactions(message.id, map);

  const stored = getMessage(message.id);
  if (!stored) return;
  const channel = getChannel(effectiveChannelId(stored));
  if (!channel) return;
  appendBlock(channel, loadEnv().DISCORD_GUILD_ID, stored, "edit");
  logger.debug({ message_id: message.id, reactions: map }, "reactions updated");
}
