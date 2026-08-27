import { ChannelType, type Message } from "discord.js";

/** Mention of the official bot: content tokens and/or discord.js mention cache. */
export function isMentionTrigger(
  content: string,
  botUserId: string,
  mentionedUserIds: Iterable<string> = [],
): boolean {
  if (!botUserId) return false;
  for (const id of mentionedUserIds) {
    if (id === botUserId) return true;
  }
  return content.includes(`<@${botUserId}>`) || content.includes(`<@!${botUserId}>`);
}

export interface ReplyToBotInput {
  reference?: { messageId?: string | null } | null;
  referencedMessage?: { author?: { id: string; bot?: boolean } | null } | null;
  repliedUser?: { id: string; bot?: boolean } | null;
}

/** Reply to a message authored by *this* bot (not an arbitrary webhook/user bot). */
export function isReplyToBot(msg: ReplyToBotInput, botUserId: string): boolean {
  if (!botUserId) return false;
  if (!msg.reference?.messageId) return false;
  const author = msg.referencedMessage?.author ?? msg.repliedUser ?? null;
  if (!author?.id) return false;
  return author.id === botUserId;
}

export function threadParentId(message: {
  channel: { type: number; parentId?: string | null };
}): string | null {
  const t = message.channel.type;
  if (
    t === ChannelType.PublicThread ||
    t === ChannelType.PrivateThread ||
    t === ChannelType.AnnouncementThread
  ) {
    return message.channel.parentId ?? null;
  }
  return null;
}

export function memberRoleIds(member: { roles?: { cache?: { keys(): Iterable<string> } } } | null | undefined): string[] {
  const cache = member?.roles?.cache;
  if (!cache) return [];
  return [...cache.keys()];
}

export function mentionUserIds(message: Pick<Message, "mentions"> | { mentions?: { users?: { keys(): Iterable<string> } } }): string[] {
  const users = message.mentions?.users;
  if (!users) return [];
  return [...users.keys()];
}
