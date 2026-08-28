import { FEED_CHANNEL_KEYS, type FeedChannelKey } from "../notify/channels.ts";
import { routeFeedFromText } from "../notify/route.ts";
import type { FeedPostInput } from "../notify/webhooks.ts";

/**
 * Pure weekday-digest compose: index hits → one FeedPostInput per non-empty
 * feed bucket. Does not POST, does not read DISCORD_BOT_TOKEN, and is not a
 * self-bot. Callers (Mini runner) pass the result to postFeed / formatFeedContent.
 *
 * Unknown routing stays in #inbox — never #sponsors / #opportunities / #speakers.
 */

export interface DigestHit {
  text: string;
  source?: string;
  createdAt?: string | number | Date;
}

const KIND_FOR_CHANNEL: Record<FeedChannelKey, string> = {
  sponsors: "sponsor",
  opportunities: "opportunity",
  speakers: "speaker",
  inbox: "unknown",
};

/** Discord broadcast / user / role mention forms that must not survive into the body. */
const PINGABLE_MENTION =
  /@(everyone|here)\b|<@!?\d+>|<@&\d+>/gi;

/**
 * Defense in depth: neutralize pingable mention tokens before formatFeedContent.
 * Incoming webhooks already set allowed_mentions.parse = [].
 */
export function stripPingableMentions(text: string): string {
  return text.replace(PINGABLE_MENTION, (match) => {
    const everyoneHere = match.match(/^@(everyone|here)$/i);
    if (everyoneHere) return `[${everyoneHere[1]!.toLowerCase()}]`;
    const user = match.match(/^<@!?(\d+)>$/);
    if (user) return `[user:${user[1]}]`;
    const role = match.match(/^<@&(\d+)>$/);
    if (role) return `[role:${role[1]}]`;
    return "[mention]";
  });
}

function createdAtMs(hit: DigestHit): number {
  const raw = hit.createdAt;
  if (raw == null) return 0;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) ? t : 0;
  }
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function bulletFor(hit: DigestHit): string | null {
  const text = oneLine(stripPingableMentions(hit.text));
  if (!text) return null;
  const source = oneLine(stripPingableMentions(hit.source ?? ""));
  return source ? `- (${source}) ${text}` : `- ${text}`;
}

function postSource(hits: DigestHit[]): string {
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const hit of hits) {
    const s = oneLine(stripPingableMentions(hit.source ?? ""));
    if (!s || seen.has(s)) continue;
    seen.add(s);
    sources.push(s);
  }
  return sources.length > 0 ? sources.join(", ") : "index";
}

/**
 * Bucket hits with routeFeedFromText, newest first within each bucket.
 * Returns at most one inbound DIGEST FeedPostInput per non-empty channel.
 */
export function composeDigestPosts(hits: readonly DigestHit[]): FeedPostInput[] {
  const buckets = new Map<FeedChannelKey, Array<{ hit: DigestHit; index: number }>>();
  for (const key of FEED_CHANNEL_KEYS) buckets.set(key, []);

  hits.forEach((hit, index) => {
    if (!hit.text?.trim()) return;
    const channel = routeFeedFromText(hit.text);
    buckets.get(channel)!.push({ hit, index });
  });

  const posts: FeedPostInput[] = [];
  for (const channel of FEED_CHANNEL_KEYS) {
    const group = buckets.get(channel)!;
    if (group.length === 0) continue;
    group.sort((a, b) => {
      const dt = createdAtMs(b.hit) - createdAtMs(a.hit);
      return dt !== 0 ? dt : a.index - b.index;
    });
    const bullets: string[] = [];
    for (const { hit } of group) {
      const bullet = bulletFor(hit);
      if (bullet) bullets.push(bullet);
    }
    if (bullets.length === 0) continue;
    posts.push({
      channel,
      direction: "inbound",
      kind: KIND_FOR_CHANNEL[channel],
      text: bullets.join("\n"),
      urgency: "digest",
      source: postSource(group.map((g) => g.hit)),
    });
  }
  return posts;
}
