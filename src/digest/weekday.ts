import { loadEnv } from "../config.ts";
import { logger } from "../logger.ts";
import { FEED_CHANNEL_KEYS, FEED_WEBHOOK_ENV, type FeedChannelKey } from "../notify/channels.ts";
import { redactSecrets } from "../notify/grok-dispatch.ts";
import { isDiscordWebhookUrl, postFeed, webhookUrlFor, type DiscordWebhookPoster } from "../notify/webhooks.ts";
import { composeDigestPosts, type DigestHit as ComposeHit } from "./compose.ts";
import {
  DEFAULT_LOOKBACK_MS,
  bucketDigestHits,
  collectDigestHits,
  sourceChannelLabel,
  type CollectedDigestHit,
} from "./collect.ts";
import { hasDigestPosted, releaseDigestPost, reserveDigestPost } from "./state.ts";

export const DIGEST_TIME_ZONE = "America/New_York";

export interface DigestChannelResult {
  posted: boolean;
  skipped?: string;
  hits: number;
}

export interface DigestRunOpts {
  env?: NodeJS.ProcessEnv;
  poster?: DiscordWebhookPoster;
  nowMs?: number;
  /** Skip the Sat/Sun check (still honors MINI_DIGEST_ENABLED). */
  force?: boolean;
  lookbackMs?: number;
}

export interface DigestRunResult {
  ran: boolean;
  skipped?: string;
  day?: string;
  channels: Record<FeedChannelKey, DigestChannelResult>;
}

export function isMiniDigestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MINI_DIGEST_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function calendarDay(nowMs: number, timeZone = DIGEST_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

export function isWeekday(nowMs: number, timeZone = DIGEST_TIME_ZONE): boolean {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(nowMs));
  return wd !== "Sat" && wd !== "Sun";
}

function emptyChannels(skipped: string): Record<FeedChannelKey, DigestChannelResult> {
  return Object.fromEntries(
    FEED_CHANNEL_KEYS.map((k) => [k, { posted: false, skipped, hits: 0 }]),
  ) as Record<FeedChannelKey, DigestChannelResult>;
}

/**
 * Replace Discord incoming-webhook URLs using the canonical detector
 * (`isDiscordWebhookUrl`), including encoded execute paths.
 */
export function redactDiscordWebhookUrls(text: string): string {
  return text.replace(/https:\/\/[^\s]+/gi, (raw) => {
    const trimmed = raw.replace(/[)\]>.,;:'"]+$/g, "");
    if (isDiscordWebhookUrl(raw) || isDiscordWebhookUrl(trimmed)) {
      return "[redacted-webhook]";
    }
    return raw;
  });
}

/** Strip Mini secrets and any pasted webhook URL from digest bodies. Never log the raw values. */
export function redactDigestText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = redactSecrets(text, loadEnv());
  for (const key of Object.values(FEED_WEBHOOK_ENV)) {
    const v = env[key]?.trim();
    if (v && v.length >= 8) out = out.split(v).join("[redacted]");
  }
  return redactDiscordWebhookUrls(out);
}

function composeInputs(hits: CollectedDigestHit[]): ComposeHit[] {
  return hits.map((h) => ({
    text: h.text,
    source: `${h.authorName} in ${sourceChannelLabel(h.sourceChannelId)}`,
    createdAt: h.createdAt,
  }));
}

export async function runWeekdayDigest(opts: DigestRunOpts = {}): Promise<DigestRunResult> {
  const env = opts.env ?? process.env;
  const nowMs = opts.nowMs ?? Date.now();

  if (!isMiniDigestEnabled(env)) {
    logger.info("weekday digest disabled (MINI_DIGEST_ENABLED off)");
    return { ran: false, skipped: "disabled", channels: emptyChannels("disabled") };
  }

  const day = calendarDay(nowMs);
  if (!isWeekday(nowMs) && !opts.force) {
    logger.info({ day }, "weekday digest skipped (weekend)");
    return { ran: false, skipped: "weekend", day, channels: emptyChannels("weekend") };
  }

  const sinceMs = nowMs - (opts.lookbackMs ?? DEFAULT_LOOKBACK_MS);
  const buckets = bucketDigestHits(collectDigestHits({ sinceMs, untilMs: nowMs }));
  const posts = composeDigestPosts(FEED_CHANNEL_KEYS.flatMap((key) => composeInputs(buckets[key])));
  const postByChannel = new Map(posts.map((p) => [p.channel, p]));
  const channels = emptyChannels("empty");

  for (const key of FEED_CHANNEL_KEYS) {
    const post = postByChannel.get(key);
    const hits = buckets[key];
    if (!post || hits.length === 0) {
      channels[key] = { posted: false, skipped: "empty", hits: 0 };
      continue;
    }
    try {
      if (!webhookUrlFor(key, env)) {
        logger.info({ channel: key }, "weekday digest skip (webhook unset)");
        channels[key] = { posted: false, skipped: "missing-webhook-url", hits: hits.length };
        continue;
      }
    } catch {
      logger.warn({ channel: key }, "weekday digest skip (webhook URL invalid)");
      channels[key] = { posted: false, skipped: "invalid-webhook-url", hits: hits.length };
      continue;
    }
    if (hasDigestPosted(day, key) || !reserveDigestPost(day, key, nowMs)) {
      logger.info({ day, channel: key }, "weekday digest skip (already posted)");
      channels[key] = { posted: false, skipped: "already-posted", hits: hits.length };
      continue;
    }

    try {
      const text = redactDigestText(post.text, env);
      const result = await postFeed(
        {
          ...post,
          text,
          urgency: "digest",
          source: "mini-index",
        },
        { env, poster: opts.poster },
      );

      if (!result.posted) {
        releaseDigestPost(day, key);
        const skipped = result.skipped ?? `http-${result.status ?? "error"}`;
        logger.warn({ day, channel: key, skipped }, "weekday digest post failed");
        channels[key] = { posted: false, skipped, hits: hits.length };
        continue;
      }

      logger.info({ day, channel: key, hits: hits.length }, "weekday digest posted");
      channels[key] = { posted: true, hits: hits.length };
    } catch {
      releaseDigestPost(day, key);
      logger.warn({ day, channel: key }, "weekday digest post threw");
      channels[key] = { posted: false, skipped: "post-error", hits: hits.length };
    }
  }

  return { ran: true, day, channels };
}
