import { getDb } from "./db.ts";

export const OUTBOX_TYPES = [
  "task.assignment_reminder_requested",
  "meeting.calendar_sync_requested",
  "meeting.calendar_cancel_requested",
] as const;

export type OutboxType = (typeof OUTBOX_TYPES)[number];
export type OutboxStatus = "pending" | "dispatched" | "failed";

/**
 * Max dispatch attempts before an outbox row is dead-lettered to `failed`.
 *
 * The sweeper runs every 60s, so 6 attempts is roughly a five-minute window of
 * retries: long enough to ride out a Discord blip, a restart, or a brief
 * Grok/handoff outage, short enough that a permanently-broken row clears the
 * head of the queue within minutes instead of blocking newer events forever.
 */
export const OUTBOX_MAX_ATTEMPTS = 6;

export type OutboxPayload = Record<string, string | number | boolean | null>;

export interface OutboxEvent {
  id: string;
  type: OutboxType;
  aggregateId: string;
  expectedVersion: number;
  payload: OutboxPayload;
  status: OutboxStatus;
  attempts: number;
  dispatchedAt: number | null;
  lastError: string | null;
  createdAt: number;
}

export interface InsertOutboxInput {
  type: OutboxType;
  aggregateId: string;
  expectedVersion: number;
  payload: OutboxPayload;
}

interface OutboxRow {
  id: string;
  type: string;
  aggregate_id: string;
  expected_version: number;
  payload: string;
  status: string;
  attempts: number;
  dispatched_at: number | null;
  last_error: string | null;
  created_at: number;
}

function isOutboxType(value: string): value is OutboxType {
  return (OUTBOX_TYPES as readonly string[]).includes(value);
}

function parsePayload(raw: string): OutboxPayload {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: OutboxPayload = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function mapRow(row: OutboxRow): OutboxEvent | null {
  if (!isOutboxType(row.type)) return null;
  if (row.status !== "pending" && row.status !== "dispatched" && row.status !== "failed") return null;
  return {
    id: row.id,
    type: row.type,
    aggregateId: row.aggregate_id,
    expectedVersion: row.expected_version,
    payload: parsePayload(row.payload),
    status: row.status,
    attempts: row.attempts,
    dispatchedAt: row.dispatched_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

export function insertOutboxEvent(input: InsertOutboxInput, now: number = Date.now()): OutboxEvent | null {
  const id = crypto.randomUUID();
  try {
    getDb()
      .query(
        `INSERT INTO outbox_events (
           id, type, aggregate_id, expected_version, payload, status, attempts, created_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .run(id, input.type, input.aggregateId, input.expectedVersion, JSON.stringify(input.payload), now);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(msg)) return null;
    throw err;
  }
  return getOutboxEvent(id);
}

export function getOutboxEvent(id: string): OutboxEvent | null {
  const row = getDb()
    .query<OutboxRow, [string]>(`SELECT * FROM outbox_events WHERE id = ?`)
    .get(id);
  return row ? mapRow(row) : null;
}

export function listPendingOutbox(limit = 50): OutboxEvent[] {
  const cap = Math.min(Math.max(1, limit), 50);
  const rows = getDb()
    .query<OutboxRow, [number]>(
      `SELECT * FROM outbox_events
       WHERE status = 'pending'
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(cap);
  return rows.map(mapRow).filter((e): e is OutboxEvent => e !== null);
}

export function markOutboxDispatched(id: string, now: number = Date.now()): boolean {
  const res = getDb()
    .query(
      `UPDATE outbox_events
       SET status = 'dispatched', dispatched_at = ?, last_error = NULL, attempts = attempts + 1
       WHERE id = ? AND status = 'pending'`,
    )
    .run(now, id);
  return Number(res.changes ?? 0) > 0;
}

export interface OutboxDispatchFailureResult {
  /** False when the row was missing or no longer `pending` (nothing was written). */
  updated: boolean;
  /** `attempts` after the increment; 0 when nothing was written. */
  attempts: number;
  /** True when this failure hit {@link OUTBOX_MAX_ATTEMPTS} and moved the row to `failed`. */
  deadLettered: boolean;
}

/**
 * Record a soft dispatch failure. The row stays `pending` (the 60s sweeper will
 * retry it) until it has failed {@link OUTBOX_MAX_ATTEMPTS} times, at which
 * point it is dead-lettered to the terminal `failed` status so it stops being
 * selected by {@link listPendingOutbox}.
 *
 * Without the cap, a permanently-failing row (unknown namespace, a webhook that
 * is down for good) sits at the head of the `created_at ASC` window forever and
 * starves every newer event behind it, because `listPendingOutbox` reads at most
 * 50 rows.
 *
 * The increment and the conditional transition happen in one UPDATE so two
 * concurrent sweepers cannot double-count or race past the cap.
 */
export function recordOutboxDispatchFailure(
  id: string,
  error: string,
  now: number = Date.now(),
): OutboxDispatchFailureResult {
  void now;
  const retryError = error.slice(0, 500);
  const exhaustedError = `exhausted after ${OUTBOX_MAX_ATTEMPTS} attempts: ${error}`.slice(0, 500);
  const row = getDb()
    .query<{ attempts: number; status: string }, [number, string, string, number, string]>(
      `UPDATE outbox_events
       SET attempts = attempts + 1,
           dispatched_at = NULL,
           last_error = CASE WHEN attempts + 1 >= ? THEN ? ELSE ? END,
           status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
       WHERE id = ? AND status = 'pending'
       RETURNING attempts, status`,
    )
    .get(OUTBOX_MAX_ATTEMPTS, exhaustedError, retryError, OUTBOX_MAX_ATTEMPTS, id);
  if (!row) return { updated: false, attempts: 0, deadLettered: false };
  return { updated: true, attempts: row.attempts, deadLettered: row.status === "failed" };
}

export function markOutboxFailed(id: string, error: string, now: number = Date.now()): boolean {
  void now;
  const res = getDb()
    .query(
      `UPDATE outbox_events
       SET status = 'failed', last_error = ?, attempts = attempts + 1
       WHERE id = ? AND status = 'pending'`,
    )
    .run(error.slice(0, 500), id);
  return Number(res.changes ?? 0) > 0;
}

export function countOutboxByType(type: OutboxType, aggregateId: string): number {
  return (
    getDb()
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM outbox_events WHERE type = ? AND aggregate_id = ?`,
      )
      .get(type, aggregateId)?.n ?? 0
  );
}
