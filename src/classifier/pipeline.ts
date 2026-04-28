import { getChannel, loadChannels, type ChannelsConfig } from "../config.ts";
import { logger } from "../logger.ts";
import { appendBlock } from "../storage/markdown.ts";
import {
  getMessage,
  setClassification,
  type Classification,
  type MessageRow,
} from "../storage/messages.ts";
import { bumpAttempts, dequeueBatch, queueDepth, removeFromQueue } from "../storage/queue.ts";
import { classifyBatch, NimRateLimitError, NimTransientError } from "./nim-client.ts";
import type { BatchItem } from "./prompt.ts";

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
const POLL_INTERVAL_MS = 5_000;

let running = false;
let stopRequested = false;

export function startClassifierWorker(): void {
  if (running) return;
  running = true;
  stopRequested = false;
  void loop().catch((err) => {
    running = false;
    logger.error({ err }, "classifier worker crashed");
  });
}

export async function stopClassifierWorker(): Promise<void> {
  stopRequested = true;
  while (running) await sleep(50);
}

async function loop(): Promise<void> {
  while (!stopRequested) {
    const drained = await drainOnce();
    if (!drained) await sleep(POLL_INTERVAL_MS);
  }
  running = false;
}

/** Returns true if work was done this iteration. */
async function drainOnce(): Promise<boolean> {
  const rows = dequeueBatch(BATCH_SIZE);
  if (rows.length === 0) return false;

  const cfg = loadChannels();
  const items: BatchItem[] = [];
  const messageById = new Map<number, MessageRow>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const msg = getMessage(row.message_id);
    if (!msg) {
      // Message disappeared from DB (shouldn't happen, but be defensive)
      removeFromQueue([row.message_id]);
      continue;
    }
    const channel = getChannel(msg.channel_id);
    const channelName = channel?.name ?? msg.channel_id;
    items.push({
      index: i,
      channelName,
      authorName: msg.author_name,
      content: msg.content,
    });
    messageById.set(i, msg);
  }
  if (items.length === 0) return true;

  try {
    const result = await classifyBatch(items);
    await applyResults(cfg, result.classifications, messageById);
    removeFromQueue([...messageById.values()].map((m) => m.id));
    logger.info(
      { batch: items.length, queue_depth: queueDepth() },
      "classifier batch processed",
    );
    return true;
  } catch (err) {
    if (err instanceof NimRateLimitError) {
      logger.warn({ retry_ms: err.retryAfterMs }, "NIM 429; sleeping");
      bumpAttempts([...messageById.values()].map((m) => m.id));
      await sleep(err.retryAfterMs);
      return true;
    }
    if (err instanceof NimTransientError) {
      const ids = [...messageById.values()].map((m) => m.id);
      bumpAttempts(ids);
      const maxAttempts = Math.max(...rows.map((r) => r.attempts + 1));
      const backoff = BACKOFF_MS[Math.min(maxAttempts - 1, BACKOFF_MS.length - 1)] ?? 30_000;
      logger.warn({ status: err.status, backoff_ms: backoff }, "NIM transient; backing off");
      // Drop messages that have exceeded max attempts.
      for (const r of rows) {
        if (r.attempts + 1 >= MAX_ATTEMPTS) {
          logger.error({ message_id: r.message_id, attempts: r.attempts + 1 }, "dropping after max attempts");
          removeFromQueue([r.message_id]);
        }
      }
      await sleep(backoff);
      return true;
    }
    logger.error({ err }, "classifier batch failed; bumping attempts");
    bumpAttempts([...messageById.values()].map((m) => m.id));
    for (const r of rows) {
      if (r.attempts + 1 >= MAX_ATTEMPTS) {
        logger.error(
          { message_id: r.message_id, attempts: r.attempts + 1 },
          "dropping after max attempts",
        );
        removeFromQueue([r.message_id]);
      }
    }
    await sleep(BACKOFF_MS[0] ?? 2_000);
    return true;
  }
}

async function applyResults(
  cfg: ChannelsConfig,
  classifications: Array<{ index: number; label: Classification; confidence: number }>,
  messageById: Map<number, MessageRow>,
): Promise<void> {
  for (const c of classifications) {
    const msg = messageById.get(c.index);
    if (!msg) continue;
    setClassification(msg.id, c.label, c.confidence);

    if (c.label === "noise") continue; // SQLite-only, no markdown

    const channel = getChannel(msg.channel_id);
    if (!channel) continue;
    const threshold = channel.confidence_threshold ?? cfg.defaults.confidence_threshold;
    if (c.confidence < threshold) continue;

    const fresh = getMessage(msg.id);
    if (!fresh) continue;
    appendBlock(channel, cfg.guild_id, fresh, "create");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
