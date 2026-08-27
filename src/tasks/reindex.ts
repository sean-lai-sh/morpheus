import { loadChannels, loadEnv } from "../config.ts";
import { logger } from "../logger.ts";
import { rebuildFts, ftsCount } from "../context/store.ts";
import { removeLegacyFlatFiles, removeLegacyNamespaceDirs, rerenderChannel } from "../storage/markdown.ts";

/** Rebuild markdown from SQLite and rebuild the FTS index. */
export function reindexAll(): void {
  // Remove stale flat .md files left over from the pre-hierarchy layout.
  removeLegacyFlatFiles();

  const cfg = loadChannels();
  for (const dest of removeLegacyNamespaceDirs(Object.keys(cfg.workspaces))) {
    logger.warn({ dest }, "moved pre-workspace markdown export to _legacy");
  }
  let total = 0;
  for (const channel of cfg.channels) {
    const written = rerenderChannel(channel, loadEnv().DISCORD_GUILD_ID);
    total += written;
    logger.info({ channel_id: channel.id, written }, "channel re-rendered");
  }
  rebuildFts();
  logger.info({ total, fts: ftsCount() }, "reindex complete");
}
