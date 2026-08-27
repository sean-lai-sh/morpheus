import { getDb } from "./db.ts";

/** Local markdown-export dirty bit (not a remote index). */
export interface ExportDirtyRow {
  folder_path: string;
  dirty: number;
}

function ensureRow(folderPath: string): void {
  getDb()
    .query(
      `INSERT INTO export_dirty_state (folder_path) VALUES (?)
       ON CONFLICT(folder_path) DO NOTHING`,
    )
    .run(folderPath);
}

export function getSyncState(folderPath: string): ExportDirtyRow {
  ensureRow(folderPath);
  return getDb()
    .query<ExportDirtyRow, [string]>(
      `SELECT folder_path, dirty FROM export_dirty_state WHERE folder_path = ?`,
    )
    .get(folderPath)!;
}

export function markDirty(folderPath: string): void {
  ensureRow(folderPath);
  getDb()
    .query(`UPDATE export_dirty_state SET dirty = 1 WHERE folder_path = ?`)
    .run(folderPath);
}
