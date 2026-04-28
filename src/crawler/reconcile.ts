import { ChannelType, type Client, type TextChannel } from "discord.js";
import { loadChannels } from "../config.ts";
import { logger } from "../logger.ts";
import { ingestDeleteById, ingestMessage } from "../bot/ingest.ts";
import { markReconciled } from "../storage/crawl-state.ts";
import { nonDeletedMessageIds } from "../storage/messages.ts";

/**
 * Refetch the last N messages of each allowlisted channel and re-ingest them.
 * upsertMessage is a no-op for unchanged content, so cost is bounded.
 * Catches edits/deletes that happened during gateway gaps.
 */
export async function reconcileAll(client: Client): Promise<void> {
  const cfg = loadChannels();
  const lookback = cfg.defaults.reconcile_lookback;
  for (const channel of cfg.channels) {
    try {
      const ch = await client.channels.fetch(channel.id);
      if (!ch || ch.type !== ChannelType.GuildText) continue;
      await reconcileChannel(ch, lookback);
      markReconciled(channel.id);
    } catch (err) {
      logger.error({ err, channel_id: channel.id }, "reconcile failed");
    }
  }
}

async function reconcileChannel(ch: TextChannel, lookback: number): Promise<void> {
  let remaining = lookback;
  let cursor: string | undefined;
  let touched = 0;
  const fetchedIds = new Set<string>();
  while (remaining > 0) {
    const limit = Math.min(100, remaining);
    const batch = await ch.messages.fetch({
      limit,
      ...(cursor ? { before: cursor } : {}),
    });
    if (batch.size === 0) break;
    for (const m of batch.values()) {
      fetchedIds.add(m.id);
      const r = await ingestMessage(m);
      if (r.action !== "skipped" && r.action !== "dropped") touched++;
      if (!cursor || BigInt(m.id) < BigInt(cursor)) cursor = m.id;
    }
    remaining -= batch.size;
    if (batch.size < limit) break;
  }

  // Detect deletes: any non-deleted SQLite message within the fetched ID window
  // that wasn't returned by the API was deleted during a gateway gap.
  if (fetchedIds.size > 0) {
    const ids = [...fetchedIds];
    const minId = ids.reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
    const maxId = ids.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
    const storedIds = nonDeletedMessageIds(ch.id);
    let deleted = 0;
    for (const storedId of storedIds) {
      const n = BigInt(storedId);
      if (n >= BigInt(minId) && n <= BigInt(maxId) && !fetchedIds.has(storedId)) {
        await ingestDeleteById(storedId);
        deleted++;
      }
    }
    if (deleted > 0) logger.info({ channel_id: ch.id, deleted }, "reconcile: tombstoned deletes");
  }

  logger.info({ channel_id: ch.id, touched, lookback }, "reconciled");
}
