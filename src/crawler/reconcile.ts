import { ChannelType, type Client, type TextChannel } from "discord.js";
import { loadChannels } from "../config.ts";
import { logger } from "../logger.ts";
import { ingestMessage } from "../bot/ingest.ts";
import { markReconciled } from "../storage/crawl-state.ts";

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
  while (remaining > 0) {
    const limit = Math.min(100, remaining);
    const batch = await ch.messages.fetch({
      limit,
      ...(cursor ? { before: cursor } : {}),
    });
    if (batch.size === 0) break;
    for (const m of batch.values()) {
      const r = await ingestMessage(m);
      if (r.action !== "skipped" && r.action !== "dropped") touched++;
      if (!cursor || BigInt(m.id) < BigInt(cursor)) cursor = m.id;
    }
    remaining -= batch.size;
    if (batch.size < limit) break;
  }
  logger.info({ channel_id: ch.id, touched, lookback }, "reconciled");
}
