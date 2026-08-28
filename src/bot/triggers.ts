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

export interface JobMentionUser {
  id: string;
  username: string;
  display_name: string;
}

/** Resolved Discord user mentions minus the bot. Never emails. */
export function mentionUsersFromMessage(
  message: {
    mentions?: {
      users?: {
        values?: () => Iterable<{
          id: string;
          bot?: boolean;
          username?: string | null;
          globalName?: string | null;
        }>;
      };
    };
    guild?: { members?: { cache?: { get?: (id: string) => { displayName?: string | null } | undefined } } } | null;
  },
  botUserId: string,
): JobMentionUser[] {
  const values = message.mentions?.users?.values?.();
  if (!values) return [];
  const out: JobMentionUser[] = [];
  for (const user of values) {
    if (!user?.id || user.id === botUserId || user.bot) continue;
    const member = message.guild?.members?.cache?.get?.(user.id);
    const username = (user.username ?? "").trim().slice(0, 100);
    const display = (member?.displayName ?? user.globalName ?? user.username ?? "").trim().slice(0, 100);
    out.push({ id: user.id, username, display_name: display });
    if (out.length >= 25) break;
  }
  return out;
}
