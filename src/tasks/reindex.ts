import { loadChannels } from "../config.ts";
import { logger } from "../logger.ts";
import { rerenderChannel } from "../storage/markdown.ts";

/** Rebuild every channel's markdown from SQLite. Used after schema changes or to recover. */
export function reindexAll(): void {
  const cfg = loadChannels();
  let total = 0;
  for (const channel of cfg.channels) {
    const written = rerenderChannel(channel, cfg.guild_id);
    total += written;
    logger.info({ channel_id: channel.id, written }, "channel re-rendered");
  }
  logger.info({ total }, "reindex complete");
}
