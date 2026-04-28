import { getDb } from "./db.ts";

export interface CrawlStateRow {
  channel_id: string;
  oldest_seen_id: string | null;
  newest_seen_id: string | null;
  last_backfill_complete: number;
  last_reconciled_at: number | null;
}

export function getState(channelId: string): CrawlStateRow | null {
  return getDb()
    .query<CrawlStateRow, [string]>(`SELECT * FROM crawl_state WHERE channel_id = ?`)
    .get(channelId);
}

export function ensureState(channelId: string): void {
  getDb()
    .query(
      `INSERT INTO crawl_state (channel_id) VALUES (?) ON CONFLICT(channel_id) DO NOTHING`,
    )
    .run(channelId);
}

/**
 * Compare two id strings numerically when both are valid snowflakes; fall back
 * to lexicographic compare otherwise. Returns -1/0/1.
 */
function compareIds(a: string, b: string): number {
  const isNumeric = (s: string) => /^\d+$/.test(s);
  if (isNumeric(a) && isNumeric(b)) {
    const ba = BigInt(a);
    const bb = BigInt(b);
    return ba === bb ? 0 : ba < bb ? -1 : 1;
  }
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Move oldest cursor backward only (smaller snowflake = older). */
export function setOldestSeen(channelId: string, candidate: string): void {
  ensureState(channelId);
  const cur = getState(channelId);
  if (!cur?.oldest_seen_id || compareIds(candidate, cur.oldest_seen_id) < 0) {
    getDb()
      .query(`UPDATE crawl_state SET oldest_seen_id = ? WHERE channel_id = ?`)
      .run(candidate, channelId);
  }
}

/** Move newest cursor forward only (larger snowflake = newer). */
export function setNewestSeen(channelId: string, candidate: string): void {
  ensureState(channelId);
  const cur = getState(channelId);
  if (!cur?.newest_seen_id || compareIds(candidate, cur.newest_seen_id) > 0) {
    getDb()
      .query(`UPDATE crawl_state SET newest_seen_id = ? WHERE channel_id = ?`)
      .run(candidate, channelId);
  }
}

export function markBackfillComplete(channelId: string): void {
  ensureState(channelId);
  getDb()
    .query(`UPDATE crawl_state SET last_backfill_complete = 1 WHERE channel_id = ?`)
    .run(channelId);
}

export function markReconciled(channelId: string, at: number = Date.now()): void {
  ensureState(channelId);
  getDb()
    .query(`UPDATE crawl_state SET last_reconciled_at = ? WHERE channel_id = ?`)
    .run(at, channelId);
}
