import type { RosterConfidence, RosterMapping, RosterUnmatched } from "../coordinator/roster-map.ts";
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

export function applyRosterSeedResult(input: {
  mappings: RosterMapping[];
  unmatched?: RosterUnmatched[];
  now?: number;
}): { mapped: number; unmatched: RosterUnmatched[] } {
  const now = input.now ?? Date.now();
  const db = getDb();
  let mapped = 0;
  db.transaction(() => {
    for (const mapping of input.mappings) {
      const email = mapping.email.trim();
      const discordId = mapping.discord_id.trim();
      if (!email || !discordId || !/^\d+$/.test(discordId)) continue;
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
  return { mapped, unmatched: input.unmatched ?? [] };
}
