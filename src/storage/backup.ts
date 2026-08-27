import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "../logger.ts";
import { dbPath, getDb, vacuum } from "./db.ts";

/**
 * Directory next to the live DB file (not a hardcoded `data/backups`).
 * If `MORPHEUS_DB_PATH=/var/morpheus/club.db`, backups go to `/var/morpheus/backups/`.
 */
export function backupDir(): string {
  return resolve(dirname(dbPath()), "backups");
}

/**
 * Make a sibling backup of the live DB. Bun's :sqlite supports the BACKUP API
 * but a plain file copy on a WAL-checkpointed DB is sufficient at our scale.
 * VACUUM runs first to compact and force a checkpoint.
 *
 * Always copies `dbPath()` (honors `MORPHEUS_DB_PATH`). Never assumes `data/morpheus.db`.
 */
export function backupDb(): string {
  const path = dbPath();
  if (path === ":memory:" || !existsSync(path)) {
    logger.warn({ path }, "DB does not exist; skipping backup");
    return "";
  }
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  // Force a checkpoint so the .db file holds the full state.
  getDb().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  vacuum();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = resolve(dir, `morpheus-${stamp}.db`);
  copyFileSync(path, dest);
  logger.info({ dest }, "db backup written");
  return dest;
}
