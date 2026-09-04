import { redactSecrets } from "../notify/grok-dispatch.ts";
import { applyRosterSeedResult } from "../storage/roster-map.ts";
import { MEET_INVOKE_ROLE_IDS } from "./roster-map.ts";
import {
  ROSTER_SHEET_ID,
  ROSTER_TAB,
  ROSTER_TAB_GID,
  type GuildMemberSnap,
  type RosterMapping,
  type RosterUnmatched,
} from "./roster-map.ts";

export const ROSTER_SEED_KIND = "roster.seed" as const;

export interface RosterSeedPack {
  kind: typeof ROSTER_SEED_KIND;
  sheet_id: string;
  tab: string;
  tab_gid: string;
  members: GuildMemberSnap[];
  instruction: string;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

const SEED_INSTRUCTION =
  `Read Drive roster sheet ${ROSTER_SHEET_ID} tab ${ROSTER_TAB} (gid ${ROSTER_TAB_GID}). Columns: First, Last, Preferred Email, Disc. Match members in this pack: Disc handle ↔ username (ignore leading @), then First+Last ↔ nick/global_name. Empty Disc (Marc, Fahim, Khidir, Zach) stays unmatched — do not guess. Complete with JSON only: {"mappings":[{"discord_id":"...","email":"...","name":"...","disc":"...","confidence":"disc|name"}],"unmatched":[{"name":"...","disc":null,"reason":"empty_disc"}]}. Mini persists the map. Do not expect Mini to send emails on later calendar jobs.`;

export function buildRosterSeedPack(members: GuildMemberSnap[]): RosterSeedPack {
  return {
    kind: ROSTER_SEED_KIND,
    sheet_id: ROSTER_SHEET_ID,
    tab: ROSTER_TAB,
    tab_gid: ROSTER_TAB_GID,
    members: members.map((member) => ({
      id: member.id,
      username: member.username,
      global_name: member.global_name,
      nick: member.nick,
    })),
    instruction: SEED_INSTRUCTION,
  };
}

export function parseRosterSeedContent(content: string): RosterSeedPack | null {
  try {
    const parsed = JSON.parse(content) as Partial<RosterSeedPack>;
    if (parsed.kind !== ROSTER_SEED_KIND) return null;
    return parsed as RosterSeedPack;
  } catch {
    return null;
  }
}

export function serializeRosterSeedPack(pack: RosterSeedPack): string {
  const json = JSON.stringify(pack);
  return json.replace(EMAIL_RE, "[email omitted]");
}

export function parseRosterSeedComplete(reply: string): {
  mappings: RosterMapping[];
  unmatched: RosterUnmatched[];
} {
  const candidates = [reply.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text) as { mappings?: unknown; unmatched?: unknown };
      const mappings = Array.isArray(parsed.mappings) ? parsed.mappings : [];
      const unmatched = Array.isArray(parsed.unmatched) ? parsed.unmatched : [];
      return {
        mappings: mappings.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const row = item as Record<string, unknown>;
          if (typeof row.discord_id !== "string" || typeof row.email !== "string") return [];
          if (typeof row.name !== "string") return [];
          return [
            {
              discord_id: row.discord_id,
              email: row.email,
              name: row.name,
              disc: typeof row.disc === "string" ? row.disc : null,
              confidence: row.confidence === "name" ? "name" : "disc",
            },
          ];
        }),
        unmatched: unmatched.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const row = item as Record<string, unknown>;
          if (typeof row.name !== "string") return [];
          return [
            {
              name: row.name,
              disc: typeof row.disc === "string" ? row.disc : null,
              reason: row.reason === "empty_disc" ? "empty_disc" : "no_member",
            },
          ];
        }),
      };
    } catch {
      /* next */
    }
  }
  return { mappings: [], unmatched: [] };
}

/**
 * The guild members a roster seed should consider.
 *
 * Seeding every non-bot member sent hundreds of unrelated usernames to a remote
 * worker and buried the real roster in noise. Only people carrying a role that
 * can appear on the F26 sheet are relevant.
 *
 * The whole MEET_INVOKE set rather than the bare @Eboard snowflake: someone
 * holding only Leadership or Senior Adv is still on the sheet, and excluding
 * them here would quietly make them un-inviteable through `/meet` later.
 */
export function isRosterSeedCandidate(member: {
  isBot: boolean;
  roleIds: readonly string[];
}): boolean {
  if (member.isBot) return false;
  return member.roleIds.some((id) => MEET_INVOKE_ROLE_IDS.has(id));
}

export function applyRosterSeedComplete(content: string, reply: string, now: number = Date.now()): {
  mapped: number;
  unmatched: RosterUnmatched[];
} | null {
  if (!parseRosterSeedContent(content)) return null;
  const parsed = parseRosterSeedComplete(reply);
  return applyRosterSeedResult({ ...parsed, now });
}

export function formatRosterSeedAnnouncement(mapped: number, unmatched: RosterUnmatched[]): string {
  const names = unmatched.map((row) => row.name).filter(Boolean);
  const extra = names.length > 0 ? `\nUnmatched (empty Disc or no guild member): ${names.join(", ")}` : "";
  return `Roster seed stored ${mapped} Discord→email binding(s).${extra}`;
}

export function redactSeedText(text: string): string {
  return redactSecrets(text.replace(EMAIL_RE, "[email omitted]"));
}
