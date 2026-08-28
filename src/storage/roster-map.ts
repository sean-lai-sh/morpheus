import type { Database } from "bun:sqlite";
import {
  EXCLUDED_ROSTER_DISCORD_IDS,
  MANUAL_ROSTER_BINDINGS,
  type RosterConfidence,
  type RosterMapping,
  type RosterUnmatched,
} from "../coordinator/roster-map.ts";
import { getDb } from "./db.ts";

export interface RosterBindingRow {
  discordId: string;
  email: string;
  name: string;
  disc: string | null;
  confidence: RosterConfidence;
  updatedAt: number;
}

interface BindingDbRow {
  discord_id: string;
  email: string;
  name: string;
  disc: string | null;
  confidence: string;
  updated_at: number;
}

function mapRow(row: BindingDbRow): RosterBindingRow {
  return {
    discordId: row.discord_id,
    email: row.email,
    name: row.name,
    disc: row.disc,
    confidence: row.confidence === "name" ? "name" : "disc",
    updatedAt: row.updated_at,
  };
}

export function getRosterBinding(discordId: string): RosterBindingRow | null {
  const row = getDb()
    .query<BindingDbRow, [string]>(`SELECT * FROM roster_bindings WHERE discord_id = ?`)
    .get(discordId);
  return row ? mapRow(row) : null;
}

export function lookupRosterBindings(discordIds: string[]): RosterBindingRow[] {
  return discordIds.map(getRosterBinding).filter((row): row is RosterBindingRow => row !== null);
}

/**
 * Every binding the seed produced, ordered for stable output.
 *
 * This is the `f26_roster` audience as the Mini can see it: the intersection of
 * the F26 sheet and the Discord guild. Sheet rows whose Disc never matched a
 * member are reported as `unmatched` at seed time and not persisted, so they are
 * absent here -- see the count the caller reports back to the organizer.
 */
export function listAllRosterBindings(): RosterBindingRow[] {
  return getDb()
    .query<BindingDbRow, []>(`SELECT * FROM roster_bindings ORDER BY discord_id ASC`)
    .all()
    .map(mapRow);
}

/** The rows a seed may persist: valid snowflake, valid address, not on the exclusion list. */
function acceptableMappings(mappings: RosterMapping[]): RosterMapping[] {
  return mappings.filter((mapping) => {
    const email = mapping.email.trim();
    const discordId = mapping.discord_id.trim();
    if (!email || !discordId || !/^\d+$/.test(discordId)) return false;
    if (EXCLUDED_ROSTER_DISCORD_IDS.has(discordId)) return false;
    return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email);
  });
}

function upsertMappings(db: Database, mappings: RosterMapping[], now: number): number {
  let mapped = 0;
  db.transaction(() => {
    for (const mapping of acceptableMappings(mappings)) {
      db.query(
        `INSERT INTO roster_bindings (discord_id, email, name, disc, confidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(discord_id) DO UPDATE SET
           email = excluded.email,
           name = excluded.name,
           disc = excluded.disc,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`,
      ).run(
        mapping.discord_id.trim(),
        mapping.email.trim(),
        mapping.name.trim().slice(0, 120),
        mapping.disc?.trim() || null,
        mapping.confidence === "name" ? "name" : "disc",
        now,
      );
      mapped += 1;
    }
  })();
  return mapped;
}

/**
 * Replace the roster snapshot with what the seed returned.
 *
 * `listAllRosterBindings` is the production `f26_roster` guest list, so this
 * cannot be upsert-only: someone dropped from the sheet would otherwise keep
 * receiving every Eboard invite (and Meet link) forever. A seed that maps
 * anyone therefore prunes every binding it did not return, then re-applies the
 * hand-curated `MANUAL_ROSTER_BINDINGS` and the exclusion list on top, exactly
 * as migrate does.
 *
 * A seed that maps NOBODY is a parse failure or an empty sheet, not a roster
 * of zero; it is applied as a no-op rather than emptying the table.
 */
export function applyRosterSeedResult(input: {
  mappings: RosterMapping[];
  unmatched?: RosterUnmatched[];
  now?: number;
  /** Test/one-off seam: keep bindings the seed did not mention. Defaults to prune. */
  prune?: boolean;
}): { mapped: number; unmatched: RosterUnmatched[]; pruned: number } {
  const db = getDb();
  const now = input.now ?? Date.now();
  const accepted = acceptableMappings(input.mappings);
  let pruned = 0;
  db.transaction(() => {
    if ((input.prune ?? true) && accepted.length > 0) {
      const keep = new Set<string>([
        ...accepted.map((mapping) => mapping.discord_id.trim()),
        ...MANUAL_ROSTER_BINDINGS.map((mapping) => mapping.discord_id),
      ]);
      const placeholders = Array.from(keep, () => "?").join(", ");
      const result = db
        .query(`DELETE FROM roster_bindings WHERE discord_id NOT IN (${placeholders})`)
        .run(...keep);
      pruned = Number(result.changes ?? 0);
    }
    upsertMappings(db, accepted, now);
    upsertManualRosterBindings(db, now);
  })();
  return { mapped: accepted.length, unmatched: input.unmatched ?? [], pruned };
}

/** One-shot empty-Disc people who ARE on Discord. Pass `db` during migrate (getDb is not ready). */
export function upsertManualRosterBindings(db: Database, now: number = Date.now()): number {
  const mapped = upsertMappings(db, MANUAL_ROSTER_BINDINGS, now);
  for (const id of EXCLUDED_ROSTER_DISCORD_IDS) {
    db.query(`DELETE FROM roster_bindings WHERE discord_id = ?`).run(id);
  }
  return mapped;
}

export function partitionRosterUsers(
  users: Array<{ id: string; displayName: string }>,
): {
  bound: Array<{ userId: string; displayName: string }>;
  unmapped: Array<{ id: string; displayName: string }>;
} {
  const bound: Array<{ userId: string; displayName: string }> = [];
  const unmapped: Array<{ id: string; displayName: string }> = [];
  for (const user of users) {
    if (getRosterBinding(user.id)) bound.push({ userId: user.id, displayName: user.displayName });
    else unmapped.push(user);
  }
  return { bound, unmapped };
}
