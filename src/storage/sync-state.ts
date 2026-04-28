import { getDb } from "./db.ts";

export interface SyncStateRow {
  folder_path: string;
  last_sync_at: number | null;
  dirty: number;
  consecutive_failures: number;
}

function ensureRow(folderPath: string): void {
  getDb()
    .query(
      `INSERT INTO nia_sync_state (folder_path) VALUES (?)
       ON CONFLICT(folder_path) DO NOTHING`,
    )
    .run(folderPath);
}

export function getSyncState(folderPath: string): SyncStateRow {
  ensureRow(folderPath);
  return getDb()
    .query<SyncStateRow, [string]>(
      `SELECT * FROM nia_sync_state WHERE folder_path = ?`,
    )
    .get(folderPath)!;
}

export function markDirty(folderPath: string): void {
  ensureRow(folderPath);
  getDb()
    .query(`UPDATE nia_sync_state SET dirty = 1 WHERE folder_path = ?`)
    .run(folderPath);
}

export function markSyncSuccess(folderPath: string, at: number = Date.now()): void {
  ensureRow(folderPath);
  getDb()
    .query(
      `UPDATE nia_sync_state
       SET dirty = 0, last_sync_at = ?, consecutive_failures = 0
       WHERE folder_path = ?`,
    )
    .run(at, folderPath);
}

export function markSyncFailure(folderPath: string): number {
  ensureRow(folderPath);
  getDb()
    .query(
      `UPDATE nia_sync_state
       SET consecutive_failures = consecutive_failures + 1
       WHERE folder_path = ?`,
    )
    .run(folderPath);
  return getSyncState(folderPath).consecutive_failures;
}
