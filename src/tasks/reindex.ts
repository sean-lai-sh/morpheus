import { loadChannels, loadEnv } from "../config.ts";
import { logger } from "../logger.ts";
import { removeLegacyFlatFiles, rerenderChannel } from "../storage/markdown.ts";

/** Rebuild every channel's markdown from SQLite. Used after schema changes or to recover. */
export function reindexAll(): void {
  // Remove stale flat .md files left over from the pre-hierarchy layout.
  removeLegacyFlatFiles();

  const cfg = loadChannels();
  let total = 0;
  for (const channel of cfg.channels) {
    const written = rerenderChannel(channel, loadEnv().DISCORD_GUILD_ID);
    total += written;
    logger.info({ channel_id: channel.id, written }, "channel re-rendered");
  }
  logger.info({ total }, "reindex complete");
}
