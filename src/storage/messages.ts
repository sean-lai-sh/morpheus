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
  /**
   * JSON map of emoji → `{count, users}`.
   * Current writes: `{"👍":{"count":3,"users":["id1","id2","id3"]}}`.
   * Pre-migration rows may still be count-only: `{"👍":3}`. Use `parseReactions`.
   */
  reactions: string | null;
  /** The Discord thread channel id this message belongs to. Equals the starter message id. */
  thread_id: string | null;
  /** Human-readable name of the thread channel. */
  thread_name: string | null;
  /** Monotonic ingest seq; bumped on insert/edit/delete/reactions. */
  seq: number;
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
  /** The Discord thread channel id (= thread starter message id). */
  threadId?: string | null;
  /** Human-readable name of the thread. */
  threadName?: string | null;
}

/** Returns the channel id to use for config/markdown lookups (parent for threads). */
export function effectiveChannelId(row: MessageRow): string {
  return row.parent_channel_id ?? row.channel_id;
}

function nextSeq(): number {
  const db = getDb();
  db.exec(`UPDATE ingest_seq SET value = value + 1 WHERE k = 1`);
  return db.query<{ value: number }, []>(`SELECT value FROM ingest_seq WHERE k = 1`).get()!.value;
}

export function upsertMessage(input: MessageInput): { inserted: boolean; edited: boolean } {
  const db = getDb();
  const existing = db
    .query<
      Pick<MessageRow, "content" | "edited_at" | "author_name" | "parent_channel_id" | "thread_id" | "thread_name">,
      [string]
    >(
      `SELECT content, edited_at, author_name, parent_channel_id, thread_id, thread_name FROM messages WHERE id = ?`,
    )
    .get(input.id);

  if (!existing) {
    const seq = nextSeq();
    db.query(
      `INSERT INTO messages (id, channel_id, parent_channel_id, author_id, author_name, content, created_at, edited_at, thread_id, thread_name, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.channelId,
      input.parentChannelId ?? null,
      input.authorId,
      input.authorName,
      input.content,
      input.createdAt,
      input.editedAt ?? null,
      input.threadId ?? null,
      input.threadName ?? null,
      seq,
    );
    return { inserted: true, edited: false };
  }

  const parent = input.parentChannelId ?? null;
  const threadId = input.threadId ?? null;
  const threadName = input.threadName ?? null;
  const contentChanged = existing.content !== input.content;
  const metaChanged =
    existing.author_name !== input.authorName ||
    existing.parent_channel_id !== parent ||
    existing.thread_id !== threadId ||
    existing.thread_name !== threadName;

  if (!contentChanged && !metaChanged) {
    return { inserted: false, edited: false };
  }

  const seq = nextSeq();
  // Refresh metadata: author_name and thread fields may have been populated after
  // the initial insert (e.g. refresh-members backfill, or pre-migration rows lacking thread_id).
  db.query(
    `UPDATE messages SET author_name = ?, parent_channel_id = ?, thread_id = ?, thread_name = ?, seq = ? WHERE id = ?`,
  ).run(input.authorName, parent, threadId, threadName, seq, input.id);

  if (contentChanged) {
    db.query(
      `UPDATE messages SET content = ?, edited_at = ? WHERE id = ?`,
    ).run(input.content, input.editedAt ?? Date.now(), input.id);
  }
  return { inserted: false, edited: contentChanged };
}

export function markDeleted(id: string, at: number = Date.now()): boolean {
  const db = getDb();
  const existing = db
    .query<Pick<MessageRow, "deleted_at">, [string]>(`SELECT deleted_at FROM messages WHERE id = ?`)
    .get(id);
  if (!existing || existing.deleted_at != null) return false;
  const seq = nextSeq();
  const res = db
    .query<MessageRow, [number, number, string]>(
      `UPDATE messages SET deleted_at = ?, seq = ? WHERE id = ? AND deleted_at IS NULL RETURNING *`,
    )
    .get(at, seq, id);
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

/**
 * Live ids in a GuildText channel, matching `messages.fetch` on that channel.
 * Thread replies live under `channel_id = <thread>` / `parent_channel_id = <parent>`
 * and are never returned by a parent fetch, so they must not be in this set —
 * otherwise reconcile tombstones them as Discord deletes.
 */
export function nonDeletedMessageIds(channelId: string): string[] {
  return getDb()
    .query<{ id: string }, [string]>(
      `SELECT id FROM messages
       WHERE channel_id = ?
         AND parent_channel_id IS NULL
         AND thread_id IS NULL
         AND deleted_at IS NULL`,
    )
    .all(channelId)
    .map((r) => r.id);
}

/** Live ids in one thread. Parent-channel rows and sibling threads are excluded. */
export function nonDeletedThreadMessageIds(threadId: string): string[] {
  return getDb()
    .query<{ id: string }, [string]>(
      `SELECT id FROM messages
       WHERE thread_id = ?
         AND deleted_at IS NULL`,
    )
    .all(threadId)
    .map((r) => r.id);
}

export function lastMessageAt(): number | null {
  return (
    getDb()
      .query<{ ts: number | null }, []>(`SELECT MAX(created_at) AS ts FROM messages`)
      .get()?.ts ?? null
  );
}

/** Who currently has an emoji on a message. `count` is Discord's total (may exceed fetched users). */
export interface ReactionEntry {
  count: number;
  users: string[];
}

/** Emoji name → reactors. */
export type ReactionMap = Record<string, ReactionEntry>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `messages.reactions` in either the current `{count,users}` shape or the
 * legacy emoji→count map. Invalid JSON / entries become `{}` / are skipped.
 */
export function parseReactions(raw: string | null | undefined): ReactionMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainObject(parsed)) return {};

  const out: ReactionMap = {};
  for (const [emoji, value] of Object.entries(parsed)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[emoji] = { count: value, users: [] };
      continue;
    }
    if (!isPlainObject(value) || typeof value.count !== "number" || !Number.isFinite(value.count)) {
      continue;
    }
    const users = Array.isArray(value.users) ? value.users.map(String) : [];
    out[emoji] = { count: value.count, users };
  }
  return out;
}

/** Count map for consumers that only need totals (markdown, seq-poll fixtures). */
export function reactionCounts(map: ReactionMap): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [emoji, entry] of Object.entries(map)) {
    if (entry.count > 0) out[emoji] = entry.count;
  }
  return out;
}

export function setReactions(id: string, reactions: ReactionMap): void {
  const db = getDb();
  const existing = db.query<{ id: string }, [string]>(`SELECT id FROM messages WHERE id = ?`).get(id);
  if (!existing) return;
  const seq = nextSeq();
  const normalized: ReactionMap = {};
  for (const [emoji, entry] of Object.entries(reactions)) {
    const users = [...new Set(entry.users)].sort();
    if (entry.count <= 0 && users.length === 0) continue;
    normalized[emoji] = { count: entry.count, users };
  }
  db.query(`UPDATE messages SET reactions = ?, seq = ? WHERE id = ?`).run(
    JSON.stringify(normalized),
    seq,
    id,
  );
}
