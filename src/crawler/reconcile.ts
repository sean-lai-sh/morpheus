import { ChannelType, type AnyThreadChannel, type Client, type Message, type TextChannel } from "discord.js";
import { ingestDeleteById, ingestMessage, type IngestResult } from "../bot/ingest.ts";
import { loadChannels, type Channel } from "../config.ts";
import { logger } from "../logger.ts";
import { markReconciled } from "../storage/crawl-state.ts";
import { nonDeletedMessageIds, nonDeletedThreadMessageIds } from "../storage/messages.ts";

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
      await reconcileChannel(ch, channel, lookback);
      markReconciled(channel.id);
    } catch (err) {
      logger.error({ err, channel_id: channel.id }, "reconcile failed");
    }
  }
}

type MessagePage = { size: number; values: () => Iterable<Message> };

async function paginateLookback(
  fetchPage: (opts: { limit: number; before?: string }) => Promise<MessagePage>,
  lookback: number,
  ingest: (m: Message) => Promise<IngestResult>,
): Promise<{ fetchedIds: Set<string>; touched: number }> {
  let remaining = lookback;
  let cursor: string | undefined;
  let touched = 0;
  const fetchedIds = new Set<string>();
  while (remaining > 0) {
    const limit = Math.min(100, remaining);
    const batch = await fetchPage({
      limit,
      ...(cursor ? { before: cursor } : {}),
    });
    if (batch.size === 0) break;
    for (const m of batch.values()) {
      fetchedIds.add(m.id);
      const r = await ingest(m);
      if (r.action !== "skipped" && r.action !== "dropped") touched++;
      if (!cursor || BigInt(m.id) < BigInt(cursor)) cursor = m.id;
    }
    remaining -= batch.size;
    if (batch.size < limit) break;
  }
  return { fetchedIds, touched };
}

/** Tombstone stored ids in the fetched snowflake window that the API did not return. */
async function tombstoneMissing(fetchedIds: Set<string>, storedIds: string[]): Promise<number> {
  if (fetchedIds.size === 0) return 0;
  const ids = [...fetchedIds];
  const minId = ids.reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
  const maxId = ids.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
  let deleted = 0;
  for (const storedId of storedIds) {
    const n = BigInt(storedId);
    if (n >= BigInt(minId) && n <= BigInt(maxId) && !fetchedIds.has(storedId)) {
      await ingestDeleteById(storedId);
      deleted++;
    }
  }
  return deleted;
}

/** Active + paginated public and private archived threads — same listing as backfill. */
async function listThreads(ch: TextChannel): Promise<AnyThreadChannel[]> {
  const out: AnyThreadChannel[] = [];
  const seen = new Set<string>();
  const add = (t: AnyThreadChannel) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push(t);
  };

  const active = await ch.threads.fetchActive();
  for (const t of active.threads.values()) add(t);

  const addArchived = async (type: "public" | "private", fetchAll: boolean) => {
    let hasMore = true;
    let before: string | undefined;
    while (hasMore) {
      const archived = await ch.threads.fetchArchived({ type, fetchAll, limit: 100, before });
      for (const t of archived.threads.values()) add(t);
      hasMore = archived.hasMore;
      const ids = [...archived.threads.keys()];
      before = ids[ids.length - 1];
    }
  };

  await addArchived("public", false);
  // All private archived (needs Manage Threads). A throw skips this channel's
  // thread diffs rather than pretending the list was complete (#72).
  await addArchived("private", true);
  return out;
}

async function reconcileChannel(ch: TextChannel, channel: Channel, lookback: number): Promise<void> {
  const parent = await paginateLookback((opts) => ch.messages.fetch(opts), lookback, (m) => ingestMessage(m));
  const deleted = await tombstoneMissing(parent.fetchedIds, nonDeletedMessageIds(ch.id));
  if (deleted > 0) logger.info({ channel_id: ch.id, deleted }, "reconcile: tombstoned deletes");

  if (channel.include_threads) {
    await reconcileChannelThreads(ch, channel, lookback);
  }

  logger.info({ channel_id: ch.id, touched: parent.touched, lookback }, "reconciled");
}

async function reconcileChannelThreads(
  ch: TextChannel,
  channel: Channel,
  lookback: number,
): Promise<void> {
  let threads: AnyThreadChannel[];
  try {
    threads = await listThreads(ch);
  } catch (err) {
    logger.warn({ err, channel_id: channel.id }, "thread reconcile listing failed; skipping thread diffs");
    return;
  }

  for (const thread of threads) {
    try {
      const result = await paginateLookback(
        (opts) => thread.messages.fetch(opts),
        lookback,
        // Do not write thread snowflakes onto the parent crawl row — an archived
        // thread last-N can rewind oldest_seen_id and skip in-progress backfill.
        (m) => ingestMessage(m, channel.id, thread.name, { updateCrawlCursors: false }),
      );
      // Empty first page while the thread still exists (we listed it): do not
      // treat an empty fetched set as "everything deleted".
      if (result.fetchedIds.size === 0) {
        logger.warn(
          { channel_id: channel.id, thread_id: thread.id },
          "thread reconcile empty page; skipping diff",
        );
        continue;
      }
      const deleted = await tombstoneMissing(result.fetchedIds, nonDeletedThreadMessageIds(thread.id));
      if (deleted > 0) {
        logger.info(
          { channel_id: channel.id, thread_id: thread.id, deleted },
          "reconcile: tombstoned thread deletes",
        );
      }
    } catch (err) {
      logger.warn(
        { err, channel_id: channel.id, thread_id: thread.id },
        "thread reconcile fetch failed; skipping thread",
      );
    }
  }
}
