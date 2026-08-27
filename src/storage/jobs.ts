import { getChannel, getWorkspace, type Channel } from "../config.ts";
import { rowInScope, scopeFor, type ChannelResolver } from "../context/namespace.ts";
import { toFtsQuery, toFtsQueryLoose } from "../context/store.ts";
import { channelIdsForScope, messagePath } from "../context/paths.ts";
import type { Namespace, Scope } from "../context/types.ts";
import { logger } from "../logger.ts";
import { getDb } from "./db.ts";
import { effectiveChannelId, type MessageRow } from "./messages.ts";

/** Workspace lookup lives in ../context/namespace.ts — jobs only re-exports it. */
export type { ChannelResolver };

export type JobStatus = "queued" | "claimed" | "completed" | "failed" | "cancelled";
/**
 * `channel` = only `channel_ids`. `workspace` = every channel visible from
 * `scopeFor(job.namespace)` (the job's workspace plus its descendants).
 * Rows persisted before workspaces stored the literal `'leadership'`; those map to `workspace`.
 */
export type JobScope = "channel" | "workspace";

/** Cap persisted + dispatched allowlisted channel ids (MVP channel scope). */
export const MAX_JOB_CHANNEL_IDS = 8;

const FIRST_PASS_LOOKBACK_CHANNEL = 80;
/** Scan enough recent rows to still find quiet-workspace messages when a sibling is busier. */
const FIRST_PASS_LOOKBACK_WORKSPACE = 2000;
/** Candidates prefetched per FTS pass (strict, then loose) before the job-scope filter. */
const FIRST_PASS_FTS_CANDIDATES = 200;

export interface JobRow {
  id: string;
  discord_message_id: string;
  discord_channel_id: string;
  discord_thread_id: string | null;
  author_id: string;
  /** Workspace id from channels.yml. The DB column keeps its legacy `namespace` name. */
  namespace: Namespace;
  scope: JobScope;
  channel_ids: string[];
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
  namespace: Namespace;
  authorId: string;
  scope?: JobScope;
  channelIds?: string[];
  content: string;
}

function parseChannelIds(raw: unknown): string[] {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) {
    return raw.filter((id): id is string => typeof id === "string" && /^\d+$/.test(id));
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && /^\d+$/.test(id));
  } catch {
    return [];
  }
}

/** A root workspace (no parent) owns its whole subtree; anything else is channel-scoped. */
function defaultScope(namespace: Namespace): JobScope {
  const ws = getWorkspace(namespace);
  return ws && ws.parent == null ? "workspace" : "channel";
}

const warnedNamespaces = new Set<string>();

/**
 * Row → JobRow, or null when `namespace` is not a configured workspace.
 * Never coerce an unknown id to a default: a row written under a workspace that
 * has since been removed must disappear, not fall into someone else's scope.
 */
function mapJob(row: JobRow | Record<string, unknown>): JobRow | null {
  const r = row as JobRow & { channel_ids?: unknown; scope?: unknown };
  const namespace = String(r.namespace ?? "");
  if (!getWorkspace(namespace)) {
    if (!warnedNamespaces.has(namespace)) {
      warnedNamespaces.add(namespace);
      logger.warn(
        { namespace, job_id: r.id },
        "job row has an unknown workspace; ignoring row (declare it under workspaces: in channels.yml)",
      );
    }
    return null;
  }
  const scope: JobScope =
    r.scope === "channel"
      ? "channel"
      : r.scope === "workspace" || r.scope === "leadership"
        ? "workspace"
        : defaultScope(namespace);
  let channel_ids = parseChannelIds(r.channel_ids);
  if (channel_ids.length === 0 && scope === "channel") {
    channel_ids = [String(r.discord_channel_id)];
  }
  return {
    ...(r as JobRow),
    namespace,
    scope,
    channel_ids,
  };
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

/** Queued jobs in every workspace visible from `scope`. Unknown-workspace rows are dropped. */
export function listQueued(scope: Scope, limit = 20): JobRow[] {
  const cap = Math.min(Math.max(1, limit), 20);
  const namespaces = [...scope.visible];
  if (namespaces.length === 0) return [];
  const placeholders = namespaces.map(() => "?").join(",");
  const rows = getDb()
    .query<JobRow, (string | number)[]>(
      `SELECT * FROM jobs
       WHERE status = 'queued' AND namespace IN (${placeholders})
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(...namespaces, cap);
  return rows.map(mapJob).filter((j): j is JobRow => j !== null);
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

  if (!getWorkspace(input.namespace)) {
    throw new Error(`enqueueJob: unknown workspace "${input.namespace}" (declare it under workspaces:)`);
  }
  const id = crypto.randomUUID();
  const scope = input.scope ?? defaultScope(input.namespace);
  const channelIds = (input.channelIds ?? (scope === "workspace" ? [] : [input.discordChannelId])).slice(
    0,
    MAX_JOB_CHANNEL_IDS,
  );
  try {
    getDb()
      .query(
        `INSERT INTO jobs (
           id, discord_message_id, discord_channel_id, discord_thread_id,
           author_id, namespace, scope, channel_ids, content, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        id,
        input.discordMessageId,
        input.discordChannelId,
        input.discordThreadId,
        input.authorId,
        input.namespace,
        scope,
        JSON.stringify(channelIds),
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
  | { ok: false; reason: "not-found" | "claimed-by-mismatch" | "not-claimed" | "in-progress" };

export interface CompleteInput {
  reply: string;
  github_issue_url?: string | null;
  completion_key?: string | null;
}

/**
 * Persist reply_text + completion_key **before** Discord send (CAS).
 * First winner may post. Losers must not: already-completed, or in-progress 409.
 * Same worker + same completion_key may retry after markJobSendError.
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
  if (job.result_discord_message_id) {
    return { ok: true, job, alreadyCompleted: true };
  }

  const completionKey = (input.completion_key?.trim() || job.completion_key || `complete:${id}`).slice(0, 200);
  const github = input.github_issue_url ?? job.github_issue_url ?? null;

  const updated = getDb()
    .query<JobRow, [string, string, string | null, number, string, string, string]>(
      `UPDATE jobs
       SET reply_text = ?, completion_key = ?, github_issue_url = ?, updated_at = ?, error = NULL
       WHERE id = ? AND status = 'claimed' AND claimed_by = ?
         AND result_discord_message_id IS NULL
         AND (completion_key IS NULL OR (completion_key = ? AND error IS NOT NULL))
       RETURNING *`,
    )
    .get(input.reply, completionKey, github, now, id, worker, completionKey);

  const mapped = updated ? mapJob(updated) : null;
  if (mapped) return { ok: true, job: mapped, alreadyCompleted: false };

  const current = getJob(id);
  if (!current) return { ok: false, reason: "not-found" };
  if (current.claimed_by !== worker) return { ok: false, reason: "claimed-by-mismatch" };
  if (current.status === "completed" || current.result_discord_message_id) {
    return { ok: true, job: current, alreadyCompleted: true };
  }
  if (current.status === "claimed") return { ok: false, reason: "in-progress" };
  return { ok: false, reason: "not-claimed" };
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

/**
 * Persist a Discord message id as soon as Discord accepts a send, while still claimed.
 * Retry must not post again once this is set (#30).
 */
export function recordJobDiscordSend(
  id: string,
  resultDiscordMessageId: string,
  now: number = Date.now(),
): JobRow | null {
  const row = getDb()
    .query<JobRow, [string, number, string]>(
      `UPDATE jobs
       SET result_discord_message_id = ?, updated_at = ?
       WHERE id = ? AND result_discord_message_id IS NULL
       RETURNING *`,
    )
    .get(resultDiscordMessageId, now, id);
  return row ? mapJob(row) : getJob(id);
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
  /** Which pass produced the snippet: relevance (FTS) or the recency window. */
  source?: "fts" | "recent";
}

type JobScopeRef = Pick<
  JobRow,
  "namespace" | "scope" | "channel_ids" | "discord_channel_id" | "discord_thread_id"
> & { content?: string };

type SnippetRow = Pick<
  MessageRow,
  "id" | "channel_id" | "parent_channel_id" | "thread_id" | "thread_name" | "content"
>;

function snippetAllowedForJob(
  job: JobScopeRef,
  row: Pick<MessageRow, "channel_id" | "parent_channel_id">,
  resolveChannel: ChannelResolver,
): boolean {
  const scope = scopeFor(job.namespace);
  if (!scope) return false;
  // Workspace boundary first: a row outside the job's subtree never qualifies,
  // whatever channel_ids says.
  if (!rowInScope(row, scope, resolveChannel)) return false;
  if (job.scope === "workspace") return true;
  const allowed = new Set(
    job.channel_ids.length > 0
      ? job.channel_ids
      : [job.discord_thread_id ?? job.discord_channel_id],
  );
  if (allowed.has(row.channel_id)) return true;
  const parent = row.parent_channel_id;
  if (parent && allowed.has(parent) && resolveChannel(parent)?.include_threads) return true;
  return false;
}

/**
 * Index path for a snippet. Prefers the injected resolver when it carries enough
 * of a `Channel` to build one, else the real config. Never emits a raw channel-id
 * path — an unparseable path is worse than no path.
 */
function snippetPath(row: SnippetRow, resolveChannel: ChannelResolver): string | undefined {
  const parentId = effectiveChannelId(row as MessageRow);
  const resolved = resolveChannel(parentId);
  let channel: Channel | undefined;
  if (resolved?.name && resolved.id) {
    channel = {
      id: resolved.id,
      name: resolved.name,
      classify: true,
      include_threads: resolved.include_threads ?? false,
      category: resolved.category,
      workspace: resolved.workspace,
    };
  } else {
    channel = getChannel(parentId);
  }
  if (!channel) return undefined;
  return messagePath(channel.workspace, channel, row as MessageRow);
}

/** Drop the leading bot mention(s) so `<@123>` never becomes an FTS term. */
function stripLeadingMentions(content: string): string {
  return content.replace(/^(\s*<@!?\d+>\s*)+/, "").trim();
}

type ScopePredicate = { sql: string; args: string[] };

/**
 * SQL predicate (over alias `m`) narrowing `messages` to the rows a job may see,
 * so both the FTS and recency queries rank only in-scope rows before LIMIT.
 * Workspace jobs: every configured channel in the job's subtree (threads fold
 * into their parent). Channel jobs: the allowed ids, plus threads of any allowed
 * channel that includes them. `null` when nothing can match. This is a coarse
 * pre-filter; `snippetAllowedForJob` remains the authority row by row.
 */
function scopePredicateForJob(
  job: JobScopeRef,
  resolveChannel: ChannelResolver,
): ScopePredicate | null {
  const ph = (ids: string[]) => ids.map(() => "?").join(",");
  if (job.scope === "workspace") {
    const scope = scopeFor(job.namespace);
    if (!scope) return null;
    const ids = channelIdsForScope(scope);
    if (ids.length === 0) return null;
    return { sql: `COALESCE(m.parent_channel_id, m.channel_id) IN (${ph(ids)})`, args: ids };
  }
  const allowed = (
    job.channel_ids.length > 0
      ? job.channel_ids
      : [job.discord_thread_id ?? job.discord_channel_id]
  ).filter((id): id is string => typeof id === "string" && id.length > 0);
  if (allowed.length === 0) return null;
  const threadParents = allowed.filter((id) => resolveChannel(id)?.include_threads);
  let sql = `(m.channel_id IN (${ph(allowed)})`;
  const args = [...allowed];
  if (threadParents.length > 0) {
    sql += ` OR m.parent_channel_id IN (${ph(threadParents)})`;
    args.push(...threadParents);
  }
  return { sql: `${sql})`, args };
}

/**
 * FTS candidates for the job text within `scope`, best bm25 rank first. Strict
 * (AND) hits come before loose (OR) hits. Rows still go through
 * `snippetAllowedForJob`. An empty or malformed expression yields no rows —
 * never throws.
 */
function ftsCandidates(content: string, scope: ScopePredicate): SnippetRow[] {
  const cleaned = stripLeadingMentions(content);
  if (!cleaned) return [];
  const exprs: string[] = [];
  const strict = toFtsQuery(cleaned);
  if (strict) exprs.push(strict);
  const loose = toFtsQueryLoose(cleaned);
  if (loose && loose !== strict) exprs.push(loose);
  const out: SnippetRow[] = [];
  for (const expr of exprs) {
    try {
      const rows = getDb()
        .query(
          `SELECT m.id, m.channel_id, m.parent_channel_id, m.thread_id, m.thread_name, m.content
           FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
           WHERE messages_fts MATCH ?
             AND m.deleted_at IS NULL
             AND ${scope.sql}
           ORDER BY bm25(messages_fts)
           LIMIT ?`,
        )
        .all(expr, ...scope.args, FIRST_PASS_FTS_CANDIDATES) as SnippetRow[];
      out.push(...rows);
    } catch (err) {
      logger.warn({ err, expr }, "first-pass fts query failed; skipping");
    }
  }
  return out;
}

/**
 * Seed snippets for a job: FTS hits for the job text (bm25 order) first, then the
 * remainder from the recent window of the job's allowed channels. Both queries
 * are pre-narrowed by the same scope predicate and both go through the same
 * job-scope filter. Not a whole workspace tree.
 */
export function firstPassSnippets(
  job: JobScopeRef,
  limit = 12,
  resolveChannel: ChannelResolver = getChannel,
): FirstPassSnippet[] {
  const cap = Math.min(Math.max(1, limit), 12);
  const wide = job.scope === "workspace";
  const lookback = wide ? FIRST_PASS_LOOKBACK_WORKSPACE : FIRST_PASS_LOOKBACK_CHANNEL;

  const scope = scopePredicateForJob(job, resolveChannel);
  if (!scope) return [];

  const out: FirstPassSnippet[] = [];
  const seen = new Set<string>();
  const take = (row: SnippetRow, source: "fts" | "recent"): boolean => {
    if (seen.has(row.id)) return false;
    if (!snippetAllowedForJob(job, row, resolveChannel)) return false;
    seen.add(row.id);
    const path = snippetPath(row, resolveChannel);
    out.push({
      id: row.id,
      channelId: row.channel_id,
      ...(path ? { path } : {}),
      content: row.content,
      source,
    });
    return out.length >= cap;
  };

  if (job.content) {
    for (const row of ftsCandidates(job.content, scope)) {
      if (take(row, "fts")) return out;
    }
  }

  const rows = getDb()
    .query(
      `SELECT m.id, m.channel_id, m.parent_channel_id, m.thread_id, m.thread_name, m.content
       FROM messages m
       WHERE m.deleted_at IS NULL
         AND ${scope.sql}
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(...scope.args, lookback) as SnippetRow[];

  for (const row of rows) {
    if (take(row, "recent")) break;
  }
  return out;
}
