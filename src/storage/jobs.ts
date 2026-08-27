import { getChannel } from "../config.ts";
import { getDb } from "./db.ts";
import { effectiveChannelId, type MessageRow } from "./messages.ts";

export type Namespace = "general" | "leadership";
export type JobStatus = "queued" | "claimed" | "completed" | "failed" | "cancelled";

export interface JobRow {
  id: string;
  discord_message_id: string;
  discord_channel_id: string;
  discord_thread_id: string | null;
  author_id: string;
  namespace: Namespace;
  content: string;
  status: JobStatus;
  claimed_by: string | null;
  claimed_at: number | null;
  result_discord_message_id: string | null;
  reply_text: string | null;
  completion_key: string | null;
  github_issue_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface EnqueueJobInput {
  discordMessageId: string;
  discordChannelId: string;
  discordThreadId: string | null;
  authorId: string;
  namespace: Namespace;
  content: string;
}

/**
 * Namespace from the *parent/allowlisted* channel, never a bare thread id.
 * Unknown / non-allowlisted → null (callers fail closed; do not map to general).
 */
export function namespaceForRow(row: {
  channel_id: string;
  parent_channel_id: string | null;
}): Namespace | null {
  const parentId = effectiveChannelId(row as MessageRow);
  const ch = getChannel(parentId);
  if (!ch) return null;
  return ch.isolated ? "leadership" : "general";
}

function mapJob(row: JobRow): JobRow {
  return row;
}

export function getJob(id: string): JobRow | null {
  const row = getDb().query<JobRow, [string]>(`SELECT * FROM jobs WHERE id = ?`).get(id);
  return row ? mapJob(row) : null;
}

export function getJobByDiscordMessageId(discordMessageId: string): JobRow | null {
  const row = getDb()
    .query<JobRow, [string]>(`SELECT * FROM jobs WHERE discord_message_id = ?`)
    .get(discordMessageId);
  return row ? mapJob(row) : null;
}

export function listQueued(namespace: Namespace, limit = 20): JobRow[] {
  const cap = Math.min(Math.max(1, limit), 20);
  return getDb()
    .query<JobRow, [string, number]>(
      `SELECT * FROM jobs
       WHERE status = 'queued' AND namespace = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(namespace, cap)
    .map(mapJob);
}

export function countOutstandingJobs(authorId: string): number {
  return (
    getDb()
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM jobs
         WHERE author_id = ? AND status IN ('queued', 'claimed')`,
      )
      .get(authorId)?.n ?? 0
  );
}

export function countJobsSince(authorId: string, sinceMs: number): number {
  return (
    getDb()
      .query<{ n: number }, [string, number]>(
        `SELECT COUNT(*) AS n FROM jobs WHERE author_id = ? AND created_at >= ?`,
      )
      .get(authorId, sinceMs)?.n ?? 0
  );
}

function isUniqueConstraint(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg) || /constraint failed/i.test(msg);
}

/**
 * Insert a queued job. Unique on discord_message_id — duplicates return the existing row.
 * Does **not** cancel other authors' queued jobs in the same channel.
 */
export function enqueueJob(
  input: EnqueueJobInput,
  now: number = Date.now(),
): { job: JobRow; duplicate: boolean } {
  const existing = getJobByDiscordMessageId(input.discordMessageId);
  if (existing) return { job: existing, duplicate: true };

  const id = crypto.randomUUID();
  try {
    getDb()
      .query(
        `INSERT INTO jobs (
           id, discord_message_id, discord_channel_id, discord_thread_id,
           author_id, namespace, content, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        id,
        input.discordMessageId,
        input.discordChannelId,
        input.discordThreadId,
        input.authorId,
        input.namespace,
        input.content,
        now,
        now,
      );
  } catch (err) {
    if (isUniqueConstraint(err)) {
      const raced = getJobByDiscordMessageId(input.discordMessageId);
      if (raced) return { job: raced, duplicate: true };
    }
    throw err;
  }
  const job = getJob(id);
  if (!job) throw new Error("enqueueJob: insert succeeded but row missing");
  return { job, duplicate: false };
}

/** CAS queued → claimed. Returns the claimed row, or null if not queued. */
export function claimJob(id: string, claimedBy: string, now: number = Date.now()): JobRow | null {
  const worker = claimedBy.trim();
  if (!worker) return null;
  const row = getDb()
    .query<JobRow, [string, number, number, string]>(
      `UPDATE jobs
       SET status = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?, error = NULL
       WHERE id = ? AND status = 'queued'
       RETURNING *`,
    )
    .get(worker, now, now, id);
  return row ? mapJob(row) : null;
}

export type PrepareCompleteResult =
  | { ok: true; job: JobRow; alreadyCompleted: boolean }
  | { ok: false; reason: "not-found" | "claimed-by-mismatch" | "not-claimed" };

export interface CompleteInput {
  reply: string;
  github_issue_url?: string | null;
  completion_key?: string | null;
}

/**
 * Persist reply_text + completion_key **before** Discord send.
 * Already-completed jobs return the stored row (idempotent; caller must not re-post).
 */
export function prepareComplete(
  id: string,
  claimedBy: string,
  input: CompleteInput,
  now: number = Date.now(),
): PrepareCompleteResult {
  const worker = claimedBy.trim();
  const job = getJob(id);
  if (!job) return { ok: false, reason: "not-found" };
  if (job.status === "completed") {
    if (job.claimed_by !== worker) return { ok: false, reason: "claimed-by-mismatch" };
    return { ok: true, job, alreadyCompleted: true };
  }
  if (job.status !== "claimed") return { ok: false, reason: "not-claimed" };
  if (job.claimed_by !== worker) return { ok: false, reason: "claimed-by-mismatch" };

  const completionKey = (input.completion_key?.trim() || job.completion_key || `complete:${id}`).slice(0, 200);
  const github = input.github_issue_url ?? job.github_issue_url;

  getDb()
    .query(
      `UPDATE jobs
       SET reply_text = ?, completion_key = ?, github_issue_url = ?, updated_at = ?, error = NULL
       WHERE id = ? AND status = 'claimed' AND claimed_by = ?`,
    )
    .run(input.reply, completionKey, github, now, id, worker);

  const updated = getJob(id);
  if (!updated) return { ok: false, reason: "not-found" };
  return { ok: true, job: updated, alreadyCompleted: false };
}

export function markJobCompleted(
  id: string,
  resultDiscordMessageId: string | null,
  now: number = Date.now(),
): JobRow | null {
  const row = getDb()
    .query<JobRow, [string | null, number, string]>(
      `UPDATE jobs
       SET status = 'completed', result_discord_message_id = ?, updated_at = ?, error = NULL
       WHERE id = ? AND status = 'claimed'
       RETURNING *`,
    )
    .get(resultDiscordMessageId, now, id);
  return row ? mapJob(row) : null;
}

/** Discord send failed before any message id — stay claimed so the same worker can retry. */
export function markJobSendError(id: string, error: string, now: number = Date.now()): JobRow | null {
  const row = getDb()
    .query<JobRow, [string, number, string]>(
      `UPDATE jobs
       SET error = ?, updated_at = ?
       WHERE id = ? AND status = 'claimed'
       RETURNING *`,
    )
    .get(error.slice(0, 2000), now, id);
  return row ? mapJob(row) : null;
}

export function failJob(id: string, claimedBy: string, error: string, now: number = Date.now()): JobRow | null {
  const worker = claimedBy.trim();
  const job = getJob(id);
  if (!job) return null;
  if (job.status === "completed") return null;
  if (job.status !== "claimed" || job.claimed_by !== worker) return null;
  if (job.result_discord_message_id) return null;

  const row = getDb()
    .query<JobRow, [string, number, string, string]>(
      `UPDATE jobs
       SET status = 'failed', error = ?, updated_at = ?
       WHERE id = ? AND status = 'claimed' AND claimed_by = ?
       RETURNING *`,
    )
    .get(error.slice(0, 2000), now, id, worker);
  return row ? mapJob(row) : null;
}

/**
 * Return expired claimed jobs to queued **only if** no Discord send was recorded.
 * A set completion_key means a send is in flight / recorded — do not requeue.
 */
export function requeueExpiredClaims(now: number, leaseMs: number): number {
  const cutoff = now - leaseMs;
  const res = getDb()
    .query(
      `UPDATE jobs
       SET status = 'queued', claimed_by = NULL, claimed_at = NULL, updated_at = ?, error = NULL
       WHERE status = 'claimed'
         AND claimed_at IS NOT NULL
         AND claimed_at < ?
         AND result_discord_message_id IS NULL
         AND completion_key IS NULL`,
    )
    .run(now, cutoff);
  return Number(res.changes ?? 0);
}

export interface FirstPassSnippet {
  id?: string;
  channelId?: string;
  path?: string;
  content: string;
}

/** Recent SQLite messages in the job's channel/thread. Not the whole index. Not FTS. */
export function firstPassSnippets(
  job: Pick<JobRow, "namespace" | "discord_channel_id" | "discord_thread_id">,
  limit = 12,
): FirstPassSnippet[] {
  const cap = Math.min(Math.max(1, limit), 12);
  const channelId = job.discord_thread_id ?? job.discord_channel_id;
  const rows = getDb()
    .query<
      Pick<MessageRow, "id" | "channel_id" | "parent_channel_id" | "content">,
      [string, string, number]
    >(
      `SELECT id, channel_id, parent_channel_id, content
       FROM messages
       WHERE deleted_at IS NULL
         AND (channel_id = ? OR parent_channel_id = ?)
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(channelId, channelId, cap);

  const out: FirstPassSnippet[] = [];
  for (const row of rows) {
    const ns = namespaceForRow(row);
    if (ns !== job.namespace) continue;
    out.push({
      id: row.id,
      channelId: row.channel_id,
      path: `/${job.namespace}/${row.channel_id}/${row.id}`,
      content: row.content,
    });
  }
  return out;
}
