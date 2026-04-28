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
 * Update the oldest cursor only when the candidate is older (numerically smaller snowflake).
 * Snowflakes encode time, so string-compare on equal-length is fine, but Discord IDs are
 * numeric — we compare via BigInt to be safe across length variations.
 */
export function setOldestSeen(channelId: string, candidate: string): void {
  ensureState(channelId);
  const cur = getState(channelId);
  if (!cur?.oldest_seen_id || BigInt(candidate) < BigInt(cur.oldest_seen_id)) {
    getDb()
      .query(`UPDATE crawl_state SET oldest_seen_id = ? WHERE channel_id = ?`)
      .run(candidate, channelId);
  }
}

export function setNewestSeen(channelId: string, candidate: string): void {
  ensureState(channelId);
  const cur = getState(channelId);
  if (!cur?.newest_seen_id || BigInt(candidate) > BigInt(cur.newest_seen_id)) {
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
