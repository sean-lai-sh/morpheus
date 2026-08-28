/** F26 contact sheet. Grok reads it as hello@; Mini never fetches Drive. */
export const ROSTER_SHEET_ID = "1NlApvtFAhFTMNafGoVksrYpJhi_oz5dlA6pml5VQ3rw";
export const ROSTER_TAB = "F26";
export const ROSTER_TAB_GID = "1079418365";
/** Same snowflake as JOB_TRIGGER Eboard. Detect this role mention/select, not the word "eboard". */
export const EBOARD_ROLE_ID = "1203562091500404782";

/** Mapped Discord role → sheet dump. Add snowflakes here; do not live-expand members. */
export const ROSTER_ROLE_AUDIENCE = {
  [EBOARD_ROLE_ID]: "f26_roster",
} as const;

export type RosterAudienceKind = (typeof ROSTER_ROLE_AUDIENCE)[keyof typeof ROSTER_ROLE_AUDIENCE];

export function isRosterRole(roleId: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROSTER_ROLE_AUDIENCE, roleId);
}

export function rosterAudienceForRoles(roleIds: Iterable<string>): RosterAudienceKind | null {
  for (const id of roleIds) {
    if (isRosterRole(id)) return ROSTER_ROLE_AUDIENCE[id as keyof typeof ROSTER_ROLE_AUDIENCE];
  }
  return null;
}

export type RosterConfidence = "disc" | "name";

export interface RosterRow {
  first: string;
  last: string;
  email: string;
  disc: string | null;
}

export interface GuildMemberSnap {
  id: string;
  username: string | null;
  global_name: string | null;
  nick: string | null;
}

export interface RosterMapping {
  discord_id: string;
  email: string;
  name: string;
  disc: string | null;
  confidence: RosterConfidence;
}

export interface RosterUnmatched {
  name: string;
  disc: string | null;
  reason: "empty_disc" | "no_member";
}

export interface RosterMatchResult {
  mappings: RosterMapping[];
  unmatched: RosterUnmatched[];
}

function norm(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/^@/, "").replace(/\s+/g, " ");
}

function compact(value: string): string {
  return value.replace(/\s+/g, "");
}

function fullName(row: RosterRow): string {
  return `${row.first} ${row.last}`.trim();
}

function findByUsername(members: GuildMemberSnap[], used: Set<string>, disc: string): GuildMemberSnap | undefined {
  const handle = norm(disc);
  const compactHandle = compact(handle);
  return members.find((member) => {
    if (used.has(member.id)) return false;
    const username = norm(member.username);
    return username === handle || compact(username) === compactHandle;
  });
}

function findByName(members: GuildMemberSnap[], used: Set<string>, row: RosterRow): GuildMemberSnap | undefined {
  const target = norm(fullName(row));
  if (!target) return undefined;
  return members.find((member) => {
    if (used.has(member.id)) return false;
    return norm(member.nick) === target || norm(member.global_name) === target;
  });
}

/**
 * Disc handle ↔ username, then First+Last ↔ nick/global_name.
 * Empty Disc is unmatched — do not guess an email.
 */
export function matchRosterToMembers(roster: RosterRow[], members: GuildMemberSnap[]): RosterMatchResult {
  const mappings: RosterMapping[] = [];
  const unmatched: RosterUnmatched[] = [];
  const used = new Set<string>();

  for (const row of roster) {
    const name = fullName(row);
    const email = row.email.trim();
    const disc = row.disc?.trim() ? row.disc.trim() : null;
    if (!email) {
      unmatched.push({ name, disc, reason: "no_member" });
      continue;
    }
    if (!disc) {
      unmatched.push({ name, disc: null, reason: "empty_disc" });
      continue;
    }

    const discHit = findByUsername(members, used, disc);
    if (discHit) {
      used.add(discHit.id);
      mappings.push({ discord_id: discHit.id, email, name, disc, confidence: "disc" });
      continue;
    }

    const nameHit = findByName(members, used, row);
    if (nameHit) {
      used.add(nameHit.id);
      mappings.push({ discord_id: nameHit.id, email, name, disc, confidence: "name" });
      continue;
    }

    unmatched.push({ name, disc, reason: "no_member" });
  }

  return { mappings, unmatched };
}
