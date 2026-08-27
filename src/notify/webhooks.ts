import { FEED_WEBHOOK_ENV, type FeedChannelKey } from "./channels.ts";
import { logger } from "../logger.ts";

/**
 * discord.com/discordapp.com and any subdomain (ptb., canary. serve the same
 * webhook API). Compared against the DNS-canonical form: an absolute name with
 * trailing dot(s) (`discord.com.`) resolves to the same host and must not slip
 * past the exact/subdomain boundary check.
 */
function isDiscordHost(hostname: string): boolean {
  const canonical = hostname.replace(/\.+$/, "");
  for (const root of ["discord.com", "discordapp.com"]) {
    if (canonical === root || canonical.endsWith(`.${root}`)) return true;
  }
  return false;
}

/**
 * Percent-decode then lowercase path segments. WHATWG `URL` leaves encodings
 * of unreserved characters in `pathname` (`%77` stays `%77`), but Discord's
 * router decodes once — `/api/%77ebhooks/{id}/{token}` executes as a webhook.
 * Discord also treats a decoded `%2F` as a path separator, so decoded segments
 * are re-split on `/` (`/api/webhooks%2F{id}%2F{token}` executes too). One
 * decode matches Discord (double-encoded `%252F`/`%2577…` forms are a generic
 * 404 there, so they are intentionally NOT separators/matches here).
 * Malformed encoding → null; Discord-host callers must fail closed on it.
 */
function decodedPathSegments(pathname: string): string[] | null {
  try {
    return pathname
      .split("/")
      .flatMap((seg) => decodeURIComponent(seg).toLowerCase().split("/"))
      .filter(Boolean);
  } catch {
    return null;
  }
}

export function isDiscordWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    if (!isDiscordHost(u.hostname)) return false;
    // Execute path is /webhooks/{id}/{token} on the API base — either the
    // unversioned default alias (/api/webhooks/…) or the documented versioned
    // base (/api/v10/webhooks/…). Segments are decoded then lowercased: this
    // is a denylist, so `%77ebhooks` or `/API/` must not slip past it, and an
    // undecodable path on a Discord host fails closed (treated as a webhook).
    const parts = decodedPathSegments(u.pathname);
    if (parts === null) return true;
    if (parts[0] !== "api") return false;
    const rest = /^v\d+$/.test(parts[1] ?? "") ? parts.slice(2) : parts.slice(1);
    return rest[0] === "webhooks" && rest.length >= 3;
  } catch {
    return false;
  }
}

export type FeedDirection = "inbound" | "outbound";
export type FeedUrgency = "digest" | "urgent";

export interface FeedPostInput {
  channel: FeedChannelKey;
  direction: FeedDirection;
  kind: string;
  text: string;
  urgency?: FeedUrgency;
  source?: string;
}

const CONTENT_LIMIT = 2000;

export function webhookUrlFor(channel: FeedChannelKey, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[FEED_WEBHOOK_ENV[channel]]?.trim();
  if (!raw) return null;
  if (!isDiscordWebhookUrl(raw)) {
    throw new Error(
      `${FEED_WEBHOOK_ENV[channel]} is not a Discord incoming webhook URL (https://discord.com/api/webhooks/…)`,
    );
  }
  return raw;
}

export function formatFeedContent(input: FeedPostInput): string {
  const urgency = input.urgency === "urgent" ? "URGENT" : "DIGEST";
  const source = input.source?.trim() ? input.source.trim() : "unspecified";
  const header = `**${urgency} · ${input.direction.toUpperCase()} · ${input.kind}** → #${input.channel}\nsource: ${source}\n`;
  const budget = CONTENT_LIMIT - header.length - 20;
  let body = input.text.trim();
  if (body.length > budget) body = `${body.slice(0, Math.max(0, budget))}…[truncated]`;
  return `${header}\n${body}`;
}

export interface DiscordWebhookPoster {
  (url: string, body: unknown): Promise<{ ok: boolean; status: number }>;
}

async function defaultPoster(url: string, body: unknown): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status };
}

/**
 * Post an operational-feed message via a Discord *incoming webhook*.
 * Does not use DISCORD_BOT_TOKEN or a user account (not a self-bot).
 */
export async function postFeed(
  input: FeedPostInput,
  opts: { env?: NodeJS.ProcessEnv; poster?: DiscordWebhookPoster } = {},
): Promise<{ posted: boolean; status?: number; skipped?: string }> {
  const url = webhookUrlFor(input.channel, opts.env ?? process.env);
  if (!url) {
    logger.warn({ channel: input.channel }, "feed webhook URL not set; skip post");
    return { posted: false, skipped: "missing-webhook-url" };
  }
  const content = formatFeedContent(input);
  const payload = {
    content,
    allowed_mentions: { parse: [] as string[], users: [] as string[], roles: [] as string[] },
  };
  const poster = opts.poster ?? defaultPoster;
  const result = await poster(url, payload);
  if (!result.ok) {
    logger.error({ channel: input.channel, status: result.status }, "feed webhook post failed");
  }
  return { posted: result.ok, status: result.status };
}
