import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../logger.ts";
import { loadEnv } from "../config.ts";
import { DISCORD_DIR } from "../storage/markdown.ts";

const ARCHIVE_DIR = resolve(process.cwd(), "data/discord-archive");

/**
 * Rotate channel markdown files older than RETENTION_MONTHS into
 * data/discord-archive/ (NOT registered with Nia).
 *
 * Eligibility = file mtime older than the cutoff. Archive preserves filename.
 * Skipped (no-op) when RETENTION_MONTHS is unset.
 *
 * Note: archived files are not re-rendered if their messages get edited later.
 * Use `bun run reindex` first to fold pending edits into the live file before
 * rotating, if pristine archive copies matter.
 */
export function rotate(): void {
  const env = loadEnv();
  if (!env.RETENTION_MONTHS) {
    logger.info("RETENTION_MONTHS unset; rotation disabled (no-op)");
    return;
  }

  mkdirSync(ARCHIVE_DIR, { recursive: true });

  const cutoffMs = Date.now() - env.RETENTION_MONTHS * 30 * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs).toISOString();
  let rotated = 0;
  for (const entry of readdirSync(DISCORD_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const src = resolve(DISCORD_DIR, entry.name);
    const stat = statSync(src);
    if (stat.mtimeMs >= cutoffMs) continue;
    const dest = resolve(ARCHIVE_DIR, entry.name);
    renameSync(src, dest);
    rotated++;
    logger.info({ file: entry.name, mtime: stat.mtime.toISOString() }, "rotated to archive");
  }
  logger.info({ rotated, cutoff, retention_months: env.RETENTION_MONTHS }, "rotation complete");
}
