import type { Guild, GuildMember } from "discord.js";
import { partitionRosterUsers } from "../storage/roster-map.ts";
import { isRosterRole, rosterAudienceForRoles } from "./roster-map.ts";

const ROLE_MENTION_RE = /<@&(\d+)>/g;

export type AudienceSelection =
  | { kind: "user"; id: string; displayName: string }
  | { kind: "role"; id: string };

export interface ResolvedAssignee {
  userId: string;
  displayName: string;
}

/** Role snowflakes from `<@&id>` tokens. Does not match the word "eboard". */
export function extractRoleSnowflakes(content: string): string[] {
  const ids: string[] = [];
  ROLE_MENTION_RE.lastIndex = 0;
  for (const match of content.matchAll(ROLE_MENTION_RE)) {
    if (match[1]) ids.push(match[1]);
  }
  return [...new Set(ids)];
}

export function collectMentionRoleIds(input: {
  content?: string | null;
  cachedRoleIds?: Iterable<string>;
}): string[] {
  return [...new Set([...extractRoleSnowflakes(input.content ?? ""), ...(input.cachedRoleIds ?? [])])];
}

export function extractMentionableAudience(data: {
  values?: string[];
  resolved?: {
    users?: Record<string, { username?: string | null; global_name?: string | null }>;
    roles?: Record<string, { id?: string }>;
  };
}): AudienceSelection[] {
  const resolvedRoleIds = new Set(Object.keys(data.resolved?.roles ?? {}));
  return (data.values ?? []).map((value) =>
    resolvedRoleIds.has(value) || isRosterRole(value)
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

export function audienceSelectionsFromMentions(input: {
  users: Array<{ id: string; displayName?: string }>;
  roleIds: string[];
}): AudienceSelection[] {
  return [
    ...input.users.map((user) => ({
      kind: "user" as const,
      id: user.id,
      displayName: user.displayName?.trim() || user.id,
    })),
    ...input.roleIds.map((id) => ({ kind: "role" as const, id })),
  ];
}

/**
 * Meetings: a mapped roster role (Eboard snowflake, not the word "eboard") means
 * F26 Preferred Emails. Extra explicit users stay as snowflakes. Do not expand members.
 */
export function meetingAudienceFromSelections(selections: AudienceSelection[]): {
  audienceKind: "picked" | "f26_roster";
  userSelections: Extract<AudienceSelection, { kind: "user" }>[];
} {
  const roleIds = selections.filter((selection) => selection.kind === "role" || isRosterRole(selection.id)).map((s) => s.id);
  const userSelections = selections.filter(
    (selection): selection is Extract<AudienceSelection, { kind: "user" }> =>
      selection.kind === "user" && !isRosterRole(selection.id),
  );
  return {
    audienceKind: rosterAudienceForRoles(roleIds) ?? "picked",
    userSelections,
  };
}

export function formatUnmappedInviteRefusal(unmapped: Array<{ displayName: string }>): string {
  const names = unmapped.map((row) => row.displayName).filter(Boolean);
  return `I can only invite F26 / @Eboard plus people already on the roster map. I will not invent emails. Unmapped: ${names.join(", ") || "unknown user"}.`;
}

/** F26 role dump and/or users who already have roster_bindings. Refuse unmapped @users. */
export function resolveMeetingInvitees(selections: AudienceSelection[]):
  | {
      ok: true;
      audienceKind: "picked" | "f26_roster";
      participants: Array<{ userId: string; displayName: string }>;
    }
  | { ok: false; reason: "unmapped-users" | "no-audience"; unmapped: Array<{ id: string; displayName: string }> } {
  const audience = meetingAudienceFromSelections(selections);
  const { bound, unmapped } = partitionRosterUsers(audience.userSelections);
  if (unmapped.length > 0) return { ok: false, reason: "unmapped-users", unmapped };
  if (audience.audienceKind !== "f26_roster" && bound.length === 0) {
    return { ok: false, reason: "no-audience", unmapped: [] };
  }
  return { ok: true, audienceKind: audience.audienceKind, participants: bound };
}

/** Expand Discord users + roles at create time and snapshot membership. */
export async function expandAudience(input: {
  selections: AudienceSelection[];
  guild?: Guild | null;
}): Promise<ResolvedAssignee[]> {
  const byId = new Map<string, ResolvedAssignee>();
  for (const selection of input.selections) {
    if (selection.kind === "user") {
      byId.set(selection.id, { userId: selection.id, displayName: selection.displayName });
      continue;
    }
    if (!input.guild) continue;
    const members = await membersWithRole(input.guild, selection.id);
    for (const member of members) {
      if (byId.has(member.id)) continue;
      byId.set(member.id, {
        userId: member.id,
        displayName: member.displayName || member.user.globalName || member.user.username || member.id,
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
