/** Parameterized operational-feed channels. Webhook URLs live in env, never in git. */

export const FEED_CHANNEL_KEYS = [
  "sponsors",
  "opportunities",
  "speakers",
  "inbox",
] as const;

export type FeedChannelKey = (typeof FEED_CHANNEL_KEYS)[number];

/** Discord channel names operators should create/bind webhooks to. */
export const FEED_CHANNEL_DISCORD_NAMES: Record<FeedChannelKey, string> = {
  sponsors: "sponsors",
  opportunities: "opportunities",
  speakers: "speakers",
  inbox: "inbox",
};

export const FEED_WEBHOOK_ENV: Record<FeedChannelKey, string> = {
  sponsors: "DISCORD_WEBHOOK_SPONSORS",
  opportunities: "DISCORD_WEBHOOK_OPPORTUNITIES",
  speakers: "DISCORD_WEBHOOK_SPEAKERS",
  inbox: "DISCORD_WEBHOOK_INBOX",
};

export function isFeedChannelKey(value: string): value is FeedChannelKey {
  return (FEED_CHANNEL_KEYS as readonly string[]).includes(value);
}
