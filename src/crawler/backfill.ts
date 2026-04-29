import { ChannelType, type AnyThreadChannel, type Client, type TextChannel } from "discord.js";
import { loadChannels, type Channel } from "../config.ts";
import { logger } from "../logger.ts";
import { ingestMessage } from "../bot/ingest.ts";
import {
  getState,
  markBackfillComplete,
  setOldestSeen,
} from "../storage/crawl-state.ts";

const PAGE_SIZE = 100;

async function fetchTextChannel(client: Client, channelId: string): Promise<TextChannel | null> {
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || ch.type !== ChannelType.GuildText) {
      logger.warn({ channel_id: channelId, type: ch?.type }, "skipping non-text channel");
      return null;
    }
    return ch;
  } catch (err) {
    logger.error({ err, channel_id: channelId }, "failed to fetch channel");
    return null;
  }
}

/** Backfill a single channel from oldest_seen_id (resumable) back to creation. */
export async function backfillChannel(
  client: Client,
  channel: Channel,
): Promise<{ channelId: string; ingested: number; pages: number; complete: boolean }> {
  const ch = await fetchTextChannel(client, channel.id);
  if (!ch) return { channelId: channel.id, ingested: 0, pages: 0, complete: false };

  const startState = getState(channel.id);
  if (startState?.last_backfill_complete) {
    logger.info({ channel_id: channel.id }, "backfill already complete; skipping");
    return { channelId: channel.id, ingested: 0, pages: 0, complete: true };
  }

  let cursor: string | undefined = startState?.oldest_seen_id ?? undefined;
  let ingested = 0;
  let pages = 0;
  const log = logger.child({ channel_id: channel.id, op: "backfill" });

  while (true) {
    const t0 = Date.now();
    const batch = await ch.messages.fetch({
      limit: PAGE_SIZE,
      ...(cursor ? { before: cursor } : {}),
    });
    pages++;
    if (batch.size === 0) {
      log.info({ pages, ingested }, "reached oldest message; backfill complete");
      markBackfillComplete(channel.id);
      return { channelId: channel.id, ingested, pages, complete: true };
    }

    // discord.js returns messages newest-first. Iterate to ingest each.
    let oldestInBatch: string | undefined;
    for (const m of batch.values()) {
      const r = await ingestMessage(m);
      if (r.action === "inserted" || r.action === "edited") ingested++;
      if (!oldestInBatch || BigInt(m.id) < BigInt(oldestInBatch)) oldestInBatch = m.id;
    }
    if (oldestInBatch) {
      setOldestSeen(channel.id, oldestInBatch);
      cursor = oldestInBatch;
    }
    log.debug(
      { pages, ingested, latency_ms: Date.now() - t0, batch_size: batch.size },
      "page fetched",
    );

    if (batch.size < PAGE_SIZE) {
      log.info({ pages, ingested }, "tail page reached; backfill complete");
      markBackfillComplete(channel.id);
      break;
    }
  }

  // Thread backfill: active + archived, if the channel opts in.
  if (channel.include_threads) {
    let threadIngested = 0;
    try {
      const active = await ch.threads.fetchActive();
      for (const [, t] of active.threads) {
        const r = await backfillThread(t, channel);
        threadIngested += r.ingested;
      }
      // Paginate archived threads
      let hasMore = true;
      let before: string | undefined;
      while (hasMore) {
        const archived = await ch.threads.fetchArchived({ fetchAll: false, limit: 100, before });
        for (const [, t] of archived.threads) {
          const r = await backfillThread(t, channel);
          threadIngested += r.ingested;
        }
        hasMore = archived.hasMore;
        const ids = [...archived.threads.keys()];
        before = ids[ids.length - 1];
      }
    } catch (err) {
      logger.warn({ err, channel_id: channel.id }, "thread backfill failed");
    }
    if (threadIngested > 0) {
      log.info({ thread_ingested: threadIngested }, "thread messages backfilled");
    }
  }

  return { channelId: channel.id, ingested, pages, complete: true };
}

/** Backfill all messages in a single thread, using the parent channel's config. */
async function backfillThread(
  thread: AnyThreadChannel,
  parentChannel: Channel,
): Promise<{ ingested: number; pages: number }> {
  const startState = getState(thread.id);
  if (startState?.last_backfill_complete) {
    logger.info({ thread_id: thread.id, thread_name: thread.name }, "thread backfill already complete; skipping");
    return { ingested: 0, pages: 0 };
  }

  let cursor: string | undefined = startState?.oldest_seen_id ?? undefined;
  let ingested = 0;
  let pages = 0;
  const log = logger.child({ thread_id: thread.id, thread_name: thread.name, op: "backfill-thread" });

  while (true) {
    const batch = await thread.messages.fetch({
      limit: PAGE_SIZE,
      ...(cursor ? { before: cursor } : {}),
    });
    pages++;
    if (batch.size === 0) {
      log.info({ pages, ingested }, "thread backfill complete");
      markBackfillComplete(thread.id);
      return { ingested, pages };
    }
    let oldestInBatch: string | undefined;
    for (const m of batch.values()) {
      const r = await ingestMessage(m, parentChannel.id);
      if (r.action === "inserted" || r.action === "edited") ingested++;
      if (!oldestInBatch || BigInt(m.id) < BigInt(oldestInBatch)) oldestInBatch = m.id;
    }
    if (oldestInBatch) {
      setOldestSeen(thread.id, oldestInBatch);
      cursor = oldestInBatch;
    }
    if (batch.size < PAGE_SIZE) {
      log.info({ pages, ingested }, "thread tail reached; backfill complete");
      markBackfillComplete(thread.id);
      return { ingested, pages };
    }
  }
}

/**
 * Backfill all allowlisted channels with bounded concurrency.
 * Concurrency cap = 2 (per plan) — gentle on Discord's per-token rate limits.
 */
export async function backfillAll(
  client: Client,
  filter?: (c: Channel) => boolean,
): Promise<void> {
  const cfg = loadChannels();
  const channels = filter ? cfg.channels.filter(filter) : cfg.channels;
  const total = channels.length;
  const concurrency = 2;
  const queue = [...channels];
  let active = 0;
  let done = 0;
  const errors: unknown[] = [];

  process.stderr.write(`\nBackfilling ${total} channels (concurrency ${concurrency})\n\n`);

  await new Promise<void>((resolve) => {
    const tick = () => {
      if (queue.length === 0 && active === 0) return resolve();
      while (active < concurrency && queue.length > 0) {
        const c = queue.shift()!;
        active++;
        backfillChannel(client, c)
          .then((r) => {
            done++;
            const tag = r.ingested === 0 ? "·" : "✓";
            const label = `#${c.name}`.padEnd(32);
            const msgs = `${r.ingested} msgs`.padStart(8);
            const pages = `${r.pages}p`.padStart(4);
            process.stderr.write(`  [${String(done).padStart(2)}/${total}] ${tag} ${label} ${msgs}  ${pages}\n`);
            logger.info({ channel_id: r.channelId, ingested: r.ingested, pages: r.pages }, "backfill done");
          })
          .catch((err) => {
            done++;
            errors.push(err);
            process.stderr.write(`  [${String(done).padStart(2)}/${total}] ✗ #${c.name}\n`);
            logger.error({ err, channel_id: c.id }, "backfill failed");
          })
          .finally(() => {
            active--;
            tick();
          });
      }
    };
    tick();
  });

  process.stderr.write(`\n  ${done - errors.length}/${total} done, ${errors.length} failed\n\n`);
  if (errors.length > 0) {
    logger.warn({ count: errors.length }, "some channels failed to backfill");
  }
}
