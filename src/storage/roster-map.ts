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

function upsertMappings(db: Database, mappings: RosterMapping[], now: number): number {
  let mapped = 0;
  db.transaction(() => {
    for (const mapping of mappings) {
      const email = mapping.email.trim();
      const discordId = mapping.discord_id.trim();
      if (!email || !discordId || !/^\d+$/.test(discordId)) continue;
      if (EXCLUDED_ROSTER_DISCORD_IDS.has(discordId)) continue;
      if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)) continue;
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
        discordId,
        email,
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

export function applyRosterSeedResult(input: {
  mappings: RosterMapping[];
  unmatched?: RosterUnmatched[];
  now?: number;
}): { mapped: number; unmatched: RosterUnmatched[] } {
  const mapped = upsertMappings(getDb(), input.mappings, input.now ?? Date.now());
  return { mapped, unmatched: input.unmatched ?? [] };
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
