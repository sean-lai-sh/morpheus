import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { upsertManualRosterBindings } from "./roster-map.ts";

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
  // Lane split (#47): counters are lane-aware so interactive (local SDK) and
  // /background (Grok) caps cannot starve each other.
  // Pre-existing rows default to 'interactive', which is what they were.
  try { db.exec(`ALTER TABLE jobs ADD COLUMN lane TEXT NOT NULL DEFAULT 'interactive'`); } catch { /* already exists */ }
  // Mini weekday digest idempotency: one successful post per calendar day + channel (#76).
  db.exec(`
    CREATE TABLE IF NOT EXISTS digest_posts (
      day TEXT NOT NULL,
      channel TEXT NOT NULL,
      posted_at INTEGER NOT NULL,
      PRIMARY KEY (day, channel)
    )
  `);
  migrateSeqAndFts(db);
  migrateCoordinator(db);
}

/**
 * Coordinator slice (techmate port): transactional outbox, tasks, meetings.
 * Single-guild Tech@NYU. People are Discord snowflakes already in `users`.
 */
function migrateCoordinator(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      dispatched_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (type, aggregate_id, expected_version)
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_status_created
      ON outbox_events(status, created_at);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      created_by_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      due_at INTEGER,
      time_zone TEXT NOT NULL DEFAULT 'America/New_York',
      status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'completed', 'cancelled')),
      revision INTEGER NOT NULL DEFAULT 1,
      channel_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_creator_status
      ON tasks(created_by_user_id, status);

    CREATE TABLE IF NOT EXISTS task_assignments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      display_name TEXT,
      status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
      reminder_policy_override TEXT CHECK (
        reminder_policy_override IS NULL
        OR reminder_policy_override IN ('daily_until_done', 'one_day_before', 'one_hour_before', 'none')
      ),
      reminder_revision INTEGER NOT NULL DEFAULT 1,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (task_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_assignments_user
      ON task_assignments(user_id, status);

    CREATE TABLE IF NOT EXISTS person_task_reminder_preferences (
      user_id TEXT PRIMARY KEY,
      default_policy TEXT NOT NULL DEFAULT 'daily_until_done' CHECK (
        default_policy IN ('daily_until_done', 'one_day_before', 'one_hour_before', 'none')
      ),
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_reminder_deliveries (
      id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
      reminder_revision INTEGER NOT NULL,
      scheduled_for INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
      error TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (assignment_id, reminder_revision, scheduled_for)
    );

    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      created_by_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      time_zone TEXT NOT NULL DEFAULT 'America/New_York',
      notes TEXT,
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'cancelled')),
      version INTEGER NOT NULL DEFAULT 1,
      channel_id TEXT,
      calendar_event_id TEXT,
      meet_link TEXT,
      announced_at INTEGER,
      hour_reminder_at INTEGER,
      hour_reminder_sent_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meetings_creator_status
      ON meetings(created_by_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_meetings_hour_reminder
      ON meetings(hour_reminder_at, hour_reminder_sent_at);

    CREATE TABLE IF NOT EXISTS meeting_participants (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      display_name TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (meeting_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS roster_bindings (
      discord_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      disc TEXT,
      confidence TEXT NOT NULL CHECK (confidence IN ('disc', 'name')),
      updated_at INTEGER NOT NULL
    );
  `);
  try {
    db.exec(`ALTER TABLE meetings ADD COLUMN audience_kind TEXT NOT NULL DEFAULT 'picked'`);
  } catch {
    /* already exists */
  }
  upsertManualRosterBindings(db);
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
