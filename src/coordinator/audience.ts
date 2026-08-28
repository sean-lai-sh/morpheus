import type { Guild, GuildMember } from "discord.js";

export type AudienceSelection =
  | { kind: "user"; id: string; displayName: string }
  | { kind: "role"; id: string };

export interface ResolvedAssignee {
  userId: string;
  displayName: string;
  username: string | null;
  globalName: string | null;
  guildNick: string | null;
}

export function extractMentionableAudience(data: {
  values?: string[];
  resolved?: {
    users?: Record<string, { username?: string | null; global_name?: string | null }>;
    roles?: Record<string, { id?: string }>;
  };
}): AudienceSelection[] {
  const roleIds = new Set(Object.keys(data.resolved?.roles ?? {}));
  return (data.values ?? []).map((value) =>
    roleIds.has(value)
      ? { kind: "role" as const, id: value }
      : {
          kind: "user" as const,
          id: value,
          displayName:
            data.resolved?.users?.[value]?.global_name ??
            data.resolved?.users?.[value]?.username ??
            value,
        },
  );
}

export async function membersWithRole(guild: Guild, roleId: string): Promise<GuildMember[]> {
  let role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
  if (!role) return [];
  if (role.members.size === 0) {
    await guild.members.fetch().catch(() => undefined);
    role = guild.roles.cache.get(roleId) ?? role;
  }
  return [...role.members.values()].filter((member) => !member.user.bot);
}

/** Expand Discord users + roles at create time and snapshot membership. */
export async function expandAudience(input: {
  selections: AudienceSelection[];
  guild?: Guild | null;
}): Promise<ResolvedAssignee[]> {
  const byId = new Map<string, ResolvedAssignee>();
  for (const selection of input.selections) {
    if (selection.kind === "user") {
      byId.set(selection.id, {
        userId: selection.id,
        displayName: selection.displayName,
        username: null,
        globalName: selection.displayName,
        guildNick: selection.displayName,
      });
      continue;
    }
    if (!input.guild) continue;
    const members = await membersWithRole(input.guild, selection.id);
    for (const member of members) {
      if (byId.has(member.id)) continue;
      const username = member.user.username ?? null;
      const globalName = member.user.globalName ?? null;
      const guildNick = member.nickname ?? member.displayName ?? null;
      byId.set(member.id, {
        userId: member.id,
        displayName: guildNick || globalName || username || member.id,
        username,
        globalName,
        guildNick,
      });
    }
  }
  return [...byId.values()];
}

export function dateInTimeZone(date: string, hour: number, minute: number, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("Choose a valid due date and time.");
  }
  const requested = Date.UTC(year, month - 1, day, hour, minute);
  let result = new Date(requested);
  for (let index = 0; index < 2; index += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(result);
    const values = Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
    );
    const represented = Date.UTC(
      values.year!,
      (values.month ?? 1) - 1,
      values.day!,
      values.hour!,
      values.minute!,
    );
    result = new Date(result.getTime() + requested - represented);
  }
  return result;
}

export function parseMeetingStart(raw: string, timeZone: string, now: number = Date.now()): Date {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Start time is required.");
  const iso = new Date(trimmed);
  if (!Number.isNaN(iso.valueOf()) && /[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    if (iso.getTime() <= now) throw new Error("Meeting start time must be in the future.");
    return iso;
  }
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) throw new Error("Start time must be ISO-8601 or YYYY-MM-DD HH:mm.");
  const date = match[1]!;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const startsAt = dateInTimeZone(date, hour, minute, timeZone);
  if (startsAt.getTime() <= now) throw new Error("Meeting start time must be in the future.");
  return startsAt;
}
