import { getDb } from "./db.ts";

export interface QueueRow {
  message_id: string;
  enqueued_at: number;
  attempts: number;
}

export function enqueue(messageId: string, at: number = Date.now()): void {
  getDb()
    .query(
      `INSERT INTO classification_queue (message_id, enqueued_at)
       VALUES (?, ?)
       ON CONFLICT(message_id) DO NOTHING`,
    )
    .run(messageId, at);
}

export function dequeueBatch(limit: number): QueueRow[] {
  return getDb()
    .query<QueueRow, [number]>(
      `SELECT message_id, enqueued_at, attempts
       FROM classification_queue
       ORDER BY enqueued_at ASC
       LIMIT ?`,
    )
    .all(limit);
}

export function removeFromQueue(messageIds: string[]): void {
  if (messageIds.length === 0) return;
  const db = getDb();
  const stmt = db.query(`DELETE FROM classification_queue WHERE message_id = ?`);
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(id);
  });
  tx(messageIds);
}

export function bumpAttempts(messageIds: string[]): void {
  if (messageIds.length === 0) return;
  const db = getDb();
  const stmt = db.query(
    `UPDATE classification_queue SET attempts = attempts + 1 WHERE message_id = ?`,
  );
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(id);
  });
  tx(messageIds);
}

export function queueDepth(): number {
  return (
    getDb()
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM classification_queue`)
      .get()?.n ?? 0
  );
}
