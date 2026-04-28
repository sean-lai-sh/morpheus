import { getDb } from "./db.ts";

export type Classification = "operational" | "discussion" | "noise";

export interface MessageRow {
  id: string;
  channel_id: string;
  /** Set when the message is from a thread; the parent text channel's id. */
  parent_channel_id: string | null;
  author_id: string;
  author_name: string;
  content: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  classification: Classification | null;
  classification_confidence: number | null;
  classified_at: number | null;
}

export interface MessageInput {
  id: string;
  channelId: string;
  /** Set for thread messages; the parent text channel's id. */
  parentChannelId?: string | null;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;
  editedAt?: number | null;
}

/** Returns the channel id to use for config/markdown lookups (parent for threads). */
export function effectiveChannelId(row: MessageRow): string {
  return row.parent_channel_id ?? row.channel_id;
}

export function upsertMessage(input: MessageInput): { inserted: boolean; edited: boolean } {
  const db = getDb();
  const existing = db
    .query<Pick<MessageRow, "content" | "edited_at">, [string]>(
      `SELECT content, edited_at FROM messages WHERE id = ?`,
    )
    .get(input.id);

  if (!existing) {
    db.query(
      `INSERT INTO messages (id, channel_id, parent_channel_id, author_id, author_name, content, created_at, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.channelId,
      input.parentChannelId ?? null,
      input.authorId,
      input.authorName,
      input.content,
      input.createdAt,
      input.editedAt ?? null,
    );
    return { inserted: true, edited: false };
  }

  // Treat as edit only when content actually changed.
  const contentChanged = existing.content !== input.content;
  if (contentChanged) {
    db.query(
      `UPDATE messages
       SET content = ?, edited_at = ?
       WHERE id = ?`,
    ).run(input.content, input.editedAt ?? Date.now(), input.id);
  }
  return { inserted: false, edited: contentChanged };
}

export function markDeleted(id: string, at: number = Date.now()): boolean {
  const db = getDb();
  const res = db
    .query<MessageRow, [number, string]>(
      `UPDATE messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL RETURNING *`,
    )
    .get(at, id);
  return res !== null;
}

export function getMessage(id: string): MessageRow | null {
  return getDb()
    .query<MessageRow, [string]>(`SELECT * FROM messages WHERE id = ?`)
    .get(id);
}

export function setClassification(
  id: string,
  classification: Classification,
  confidence: number,
  at: number = Date.now(),
): void {
  getDb()
    .query(
      `UPDATE messages
       SET classification = ?, classification_confidence = ?, classified_at = ?
       WHERE id = ?`,
    )
    .run(classification, confidence, at, id);
}

export function recentMessages(channelId: string, limit: number): MessageRow[] {
  return getDb()
    .query<MessageRow, [string, number]>(
      `SELECT * FROM messages
       WHERE channel_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(channelId, limit);
}

export function messagesForChannelAsc(channelId: string): MessageRow[] {
  return getDb()
    .query<MessageRow, [string, string]>(
      `SELECT * FROM messages
       WHERE channel_id = ? OR parent_channel_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(channelId, channelId);
}

export function countMessages(): number {
  return (
    getDb()
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM messages`)
      .get()?.n ?? 0
  );
}

export function nonDeletedMessageIds(channelId: string): string[] {
  return getDb()
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM messages
       WHERE (channel_id = ? OR parent_channel_id = ?) AND deleted_at IS NULL`,
    )
    .all(channelId, channelId)
    .map((r) => r.id);
}

export function lastMessageAt(): number | null {
  return (
    getDb()
      .query<{ ts: number | null }, []>(`SELECT MAX(created_at) AS ts FROM messages`)
      .get()?.ts ?? null
  );
}
