import { ChannelType, type Client, type TextChannel } from "discord.js";
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
      return { channelId: channel.id, ingested, pages, complete: true };
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
  const concurrency = 2;
  const queue = [...channels];
  let active = 0;
  const errors: unknown[] = [];

  await new Promise<void>((resolve) => {
    const tick = () => {
      if (queue.length === 0 && active === 0) return resolve();
      while (active < concurrency && queue.length > 0) {
        const c = queue.shift()!;
        active++;
        backfillChannel(client, c)
          .then((r) =>
            logger.info(
              { channel_id: r.channelId, ingested: r.ingested, pages: r.pages },
              "backfill done",
            ),
          )
          .catch((err) => {
            errors.push(err);
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

  if (errors.length > 0) {
    logger.warn({ count: errors.length }, "some channels failed to backfill");
  }
}
