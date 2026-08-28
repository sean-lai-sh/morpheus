/** Discord profile fields Mini may pack for Grok. Never emails. */

export type CalendarTarget = "eboard" | "leadership";
export type MeetingRecurrence = "none" | "weekly";
export type MeetingAudienceKind = "picked" | "f26_roster";
export type MeetingSource = "slash" | "mention";

export interface DiscordIdentity {
  userId: string;
  username: string | null;
  globalName: string | null;
  guildNick: string | null;
}

export interface PackedDiscordIdentity {
  user_id: string;
  username: string | null;
  global_name: string | null;
  guild_nick: string | null;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function keepAddress(address: string): boolean {
  return (
    /^hello@techatnyu\.org$/i.test(address) || /@group\.calendar\.google\.com$/i.test(address)
  );
}

export function stripEmails(text: string): string {
  return text.replace(EMAIL_RE, (match) => (keepAddress(match) ? match : "[email omitted]"));
}

export function containsEmail(text: string): boolean {
  EMAIL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EMAIL_RE.exec(text))) {
    if (!keepAddress(match[0])) return true;
  }
  return false;
}

export function displayNameOf(identity: DiscordIdentity): string {
  return identity.guildNick || identity.globalName || identity.username || identity.userId;
}

export function packDiscordIdentity(identity: DiscordIdentity): PackedDiscordIdentity {
  return {
    user_id: identity.userId,
    username: sanitizeHandle(identity.username),
    global_name: sanitizeHandle(identity.globalName),
    guild_nick: sanitizeHandle(identity.guildNick),
  };
}

function sanitizeHandle(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = stripEmails(value).trim();
  return trimmed.length > 0 ? trimmed.slice(0, 100) : null;
}

export function identityFromUserLike(input: {
  id: string;
  username?: string | null;
  globalName?: string | null;
  global_name?: string | null;
  nickname?: string | null;
  displayName?: string | null;
}): DiscordIdentity {
  const guildNick = input.nickname?.trim() || null;
  const display = input.displayName?.trim() || null;
  return {
    userId: input.id,
    username: input.username?.trim() || null,
    globalName: (input.globalName ?? input.global_name)?.trim() || null,
    guildNick: guildNick && guildNick !== input.username ? guildNick : display && display !== input.username ? display : guildNick,
  };
}

export function identityFromCachedUser(row: {
  user_id: string;
  username: string | null;
  display_name: string | null;
  global_name: string | null;
}): DiscordIdentity {
  return {
    userId: row.user_id,
    username: row.username,
    globalName: row.global_name,
    guildNick: row.display_name,
  };
}
