import { getDb } from "../storage/db.ts";
import type { FeedChannelKey } from "../notify/channels.ts";

export function hasDigestPosted(day: string, channel: FeedChannelKey): boolean {
  const row = getDb()
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM digest_posts WHERE day = ? AND channel = ?`,
    )
    .get(day, channel);
  return (row?.n ?? 0) > 0;
}

/** Insert-or-ignore. Returns true when this caller reserved the day+channel slot. */
export function reserveDigestPost(day: string, channel: FeedChannelKey, postedAt: number): boolean {
  const result = getDb()
    .query(`INSERT OR IGNORE INTO digest_posts (day, channel, posted_at) VALUES (?, ?, ?)`)
    .run(day, channel, postedAt);
  return result.changes > 0;
}

/** Drop a reservation so an unset webhook or failed POST can retry later the same day. */
export function releaseDigestPost(day: string, channel: FeedChannelKey): void {
  getDb().query(`DELETE FROM digest_posts WHERE day = ? AND channel = ?`).run(day, channel);
}
