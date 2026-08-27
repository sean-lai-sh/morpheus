import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Resolved SQLite path. Honors `MORPHEUS_DB_PATH` (tests, non-default Mini volume). */
export function dbPath(): string {
  return process.env.MORPHEUS_DB_PATH ?? resolve(process.cwd(), "data/morpheus.db");
}

let _db: Database | undefined;

export function getDb(): Database {
  if (_db) return _db;
  const path = dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  migrateAlter(db);
  _db = db;
  return db;
}

export function closeDb(): void {
  _db?.close();
  _db = undefined;
}

/** Test-only: close the current handle so the next getDb() call opens a fresh DB. */
export function resetDbForTest(): void {
  _db?.close();
  _db = undefined;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      parent_channel_id TEXT,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      edited_at INTEGER,
      deleted_at INTEGER,
      classification TEXT,
      classification_confidence REAL,
      classified_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel_created
      ON messages(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_parent_channel
      ON messages(parent_channel_id);
    CREATE INDEX IF NOT EXISTS idx_messages_classification
      ON messages(classification);

    CREATE TABLE IF NOT EXISTS links (
      link_id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      url TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_id TEXT,
      first_seen_at INTEGER NOT NULL,
      UNIQUE(message_id, url)
    );
    CREATE INDEX IF NOT EXISTS idx_links_message ON links(message_id);
    CREATE INDEX IF NOT EXISTS idx_links_file_id ON links(file_id);

    CREATE TABLE IF NOT EXISTS crawl_state (
      channel_id TEXT PRIMARY KEY,
      oldest_seen_id TEXT,
      newest_seen_id TEXT,
      last_backfill_complete INTEGER NOT NULL DEFAULT 0,
      last_reconciled_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS classification_queue (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      enqueued_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_classification_queue_enqueued
      ON classification_queue(enqueued_at);

    CREATE TABLE IF NOT EXISTS export_dirty_state (
      folder_path TEXT PRIMARY KEY,
      dirty INTEGER NOT NULL DEFAULT 0
    );

    -- Additive jobs table (#29/#30). Do not fold FTS/seq into this migration.
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      discord_message_id TEXT NOT NULL UNIQUE,
      discord_channel_id TEXT NOT NULL,
      discord_thread_id TEXT,
      author_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at INTEGER,
      result_discord_message_id TEXT,
      reply_text TEXT,
      completion_key TEXT UNIQUE,
      github_issue_url TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      scope TEXT,
      channel_ids TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status_namespace_created
      ON jobs(status, namespace, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_author_status
      ON jobs(author_id, status);
    CREATE INDEX IF NOT EXISTS idx_jobs_author_created
      ON jobs(author_id, created_at);
  `);
}

function migrateAlter(db: Database): void {
  // Add parent_channel_id for thread support on existing databases.
  try { db.exec(`ALTER TABLE messages ADD COLUMN parent_channel_id TEXT`); } catch { /* already exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_parent_channel ON messages(parent_channel_id)`); } catch { /* already exists */ }
  // Add reactions column for emoji reaction metadata.
  try { db.exec(`ALTER TABLE messages ADD COLUMN reactions TEXT`); } catch { /* already exists */ }
  // NIM classifier removed; clean up queue table on existing DBs.
  try { db.exec(`DROP TABLE IF EXISTS classification_queue`); } catch { /* ignore */ }
  // Add thread_id / thread_name to identify which thread a message belongs to.
  // thread_id equals the Discord thread channel id, which is always the starter message id.
  try { db.exec(`ALTER TABLE messages ADD COLUMN thread_id TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN thread_name TEXT`); } catch { /* already exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id)`); } catch { /* already exists */ }
  // User display-name cache for resolving raw usernames to server nicknames.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      global_name TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
  try { db.exec(`DROP TABLE IF EXISTS nia_sync_state`); } catch { /* ignore */ }
  try { db.exec(`ALTER TABLE jobs ADD COLUMN scope TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE jobs ADD COLUMN channel_ids TEXT`); } catch { /* already exists */ }
  migrateSeqAndFts(db);
}

/**
 * Additive: monotonic ingest seq + FTS5 over messages.content.
 * Namespace is resolved at query time from channels.yml (not stored in FTS).
 */
function migrateSeqAndFts(db: Database): void {
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`);
  } catch {
    /* already exists */
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq)`);
  } catch {
    /* already exists */
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_seq (
      k INTEGER PRIMARY KEY CHECK (k = 1),
      value INTEGER NOT NULL
    )
  `);
  db.exec(`INSERT OR IGNORE INTO ingest_seq (k, value) VALUES (1, 0)`);
  db.exec(`UPDATE messages SET seq = rowid WHERE seq = 0`);
  const maxSeq =
    db.query<{ n: number | null }, []>(`SELECT MAX(seq) AS n FROM messages`).get()?.n ?? 0;
  db.query(`UPDATE ingest_seq SET value = MAX(value, ?) WHERE k = 1`).run(maxSeq);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid',
      tokenize='porter unicode61'
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END
  `);

  const ftsN =
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM messages_fts`).get()?.n ?? 0;
  const msgN =
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM messages`).get()?.n ?? 0;
  if (msgN > 0 && ftsN === 0) {
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);
  }
}

export function vacuum(): void {
  getDb().exec("VACUUM");
}
