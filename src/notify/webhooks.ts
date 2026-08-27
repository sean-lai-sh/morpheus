import { FEED_WEBHOOK_ENV, type FeedChannelKey } from "./channels.ts";
import { logger } from "../logger.ts";

function isDiscordWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    if (u.hostname !== "discord.com" && u.hostname !== "discordapp.com") return false;
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[0] === "api" && parts[1] === "webhooks" && parts.length >= 4;
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
