import { getWorkspace, loadChannels, workspaceIds } from "../config.ts";
import { scopeFor } from "../context/namespace.ts";
import { contextStore } from "../context/store.ts";
import type { Scope, SearchHit } from "../context/types.ts";
import { FEED_CHANNEL_DISCORD_NAMES, FEED_CHANNEL_KEYS, type FeedChannelKey } from "../notify/channels.ts";
import { routeFeedFromText } from "../notify/route.ts";

/**
 * Single-term (or short phrase) FTS queries. `toFtsQuery` ANDs tokens, so we
 * do not pack a whole category into one string.
 */
export const DIGEST_FTS_QUERIES = [
  "sponsor",
  "partnership",
  "pitch",
  "collab",
  "internship",
  "fellowship",
  "hiring",
  "job",
  "career",
  "opportunity",
  "speaker",
  "keynote",
  "guest speaker",
] as const;

/** Default lookback so a weekday morning run covers yesterday afternoon. */
export const DEFAULT_LOOKBACK_MS = 36 * 60 * 60 * 1000;
export const MAX_HITS_PER_CHANNEL = 12;

export interface DigestHit {
  id: string;
  channel: FeedChannelKey;
  authorName: string;
  snippet: string;
  permalink: string;
  createdAt: number;
  sourceChannelId: string;
}

/** Root workspaces (or every workspace if the tree has no roots). */
export function digestScopes(): Scope[] {
  const ids = workspaceIds();
  const roots = ids.filter((id) => !getWorkspace(id)?.parent);
  const out: Scope[] = [];
  for (const id of roots.length > 0 ? roots : ids) {
    const scope = scopeFor(id);
    if (scope) out.push(scope);
  }
  return out;
}

/** Channel snowflakes bound to #sponsors / #opportunities / #speakers / #inbox. */
export function feedSourceChannelIds(): Set<string> {
  const names = new Set(Object.values(FEED_CHANNEL_DISCORD_NAMES).map((n) => n.toLowerCase()));
  return new Set(
    loadChannels()
      .channels.filter((c) => names.has(c.name.toLowerCase()))
      .map((c) => c.id),
  );
}

export function isFeedSourceHit(hit: SearchHit, feedIds: Set<string>): boolean {
  const parent = hit.parentChannelId ?? hit.channelId;
  return feedIds.has(parent) || feedIds.has(hit.channelId);
}

export function collectDigestHits(opts: { sinceMs: number; untilMs?: number; scopes?: Scope[] }): DigestHit[] {
  const scopes = opts.scopes ?? digestScopes();
  const feedIds = feedSourceChannelIds();
  const seen = new Set<string>();
  const out: DigestHit[] = [];

  for (const scope of scopes) {
    for (const query of DIGEST_FTS_QUERIES) {
      const hits = contextStore.search({
        query,
        scope,
        sinceMs: opts.sinceMs,
        untilMs: opts.untilMs,
        limit: 50,
      });
      for (const hit of hits) {
        if (seen.has(hit.id)) continue;
        if (isFeedSourceHit(hit, feedIds)) continue;
        const doc = contextStore.readMessage(hit.id, scope);
        if (!doc) continue;
        seen.add(hit.id);
        out.push({
          id: hit.id,
          channel: routeFeedFromText(doc.content),
          authorName: doc.authorName,
          snippet: (hit.snippet || doc.content).replace(/\s+/g, " ").trim(),
          permalink: hit.permalink,
          createdAt: doc.createdAt,
          sourceChannelId: doc.parentChannelId ?? doc.channelId,
        });
      }
    }
  }

  out.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  return out;
}

export function bucketDigestHits(hits: DigestHit[]): Record<FeedChannelKey, DigestHit[]> {
  const buckets = Object.fromEntries(FEED_CHANNEL_KEYS.map((k) => [k, [] as DigestHit[]])) as Record<
    FeedChannelKey,
    DigestHit[]
  >;
  for (const hit of hits) {
    const bucket = buckets[hit.channel];
    if (bucket.length >= MAX_HITS_PER_CHANNEL) continue;
    bucket.push(hit);
  }
  return buckets;
}

export function sourceChannelLabel(channelId: string): string {
  const ch = loadChannels().channels.find((c) => c.id === channelId);
  return ch ? `#${ch.name}` : "channel";
}

export function formatDigestBody(channel: FeedChannelKey, hits: DigestHit[]): string {
  const lines = hits.map((h) => {
    const snip = h.snippet.slice(0, 180);
    const where = sourceChannelLabel(h.sourceChannelId);
    return `• ${h.authorName} in ${where}: ${snip}\n  ${h.permalink}`;
  });
  return `Weekday index digest — ${hits.length} classified hit(s) for #${channel}\n\n${lines.join("\n")}`;
}
