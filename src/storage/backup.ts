import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../logger.ts";
import { getDb, vacuum } from "./db.ts";

const DB_PATH = resolve(process.cwd(), "data/morpheus.db");
const BACKUP_DIR = resolve(process.cwd(), "data/backups");

/**
 * Make a sibling backup of morpheus.db. Bun's :sqlite supports the BACKUP API
 * but a plain file copy on a WAL-checkpointed DB is sufficient at our scale.
 * VACUUM runs first to compact and force a checkpoint.
 */
export function backupDb(): string {
  if (!existsSync(DB_PATH)) {
    logger.warn({ path: DB_PATH }, "DB does not exist; skipping backup");
    return "";
  }
  mkdirSync(BACKUP_DIR, { recursive: true });
  // Force a checkpoint so the .db file holds the full state.
  getDb().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  vacuum();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = resolve(BACKUP_DIR, `morpheus-${stamp}.db`);
  copyFileSync(DB_PATH, dest);
  logger.info({ dest }, "db backup written");
  return dest;
}
