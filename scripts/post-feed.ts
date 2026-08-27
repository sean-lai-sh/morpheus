/**
 * One-shot: post an operational-feed message through a Discord incoming webhook.
 *
 *   bun run post-feed -- --channel=sponsors --direction=inbound --kind=sponsor --text='Acme asked about Spring gala'
 *
 * URLs come from DISCORD_WEBHOOK_* env (Doppler). Never pass a webhook URL on the CLI.
 */
import { isFeedChannelKey } from "../src/notify/channels.ts";
import { routeFeedChannel } from "../src/notify/route.ts";
import { postFeed, type FeedDirection, type FeedUrgency } from "../src/notify/webhooks.ts";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const channelArg = arg("channel");
  const kind = arg("kind") ?? "unknown";
  const direction = (arg("direction") ?? "inbound") as FeedDirection;
  const urgency = (arg("urgency") ?? "digest") as FeedUrgency;
  const text = arg("text");
  const source = arg("source");

  if (!text) {
    console.error("usage: bun run post-feed -- --channel=sponsors|opportunities|speakers|inbox --direction=inbound|outbound --kind=sponsor --text='...'");
    process.exit(1);
  }
  if (direction !== "inbound" && direction !== "outbound") {
    console.error("direction must be inbound or outbound");
    process.exit(1);
  }

  const channel = channelArg && isFeedChannelKey(channelArg) ? channelArg : routeFeedChannel(kind);
  const result = await postFeed({ channel, direction, kind, text, urgency, source });
  if (!result.posted) {
    console.error(result.skipped ?? `webhook HTTP ${result.status}`);
    process.exit(1);
  }
  console.error(`posted to #${channel}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
