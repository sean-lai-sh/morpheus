import { getDb } from "./db.ts";

export const EVENT_STATUSES = [
  "planned",
  "confirmed",
  "in_prep",
  "live",
  "wrapped",
  "postmortem",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_SOURCE_TYPES = [
  "backfill_parser",
  "agent_update",
  "slash_command",
  "manual_seed",
] as const;
export type EventSourceType = (typeof EVENT_SOURCE_TYPES)[number];

export interface EventRow {
  id: number;
  name: string;
  date: string | null;
  status: EventStatus;
  channel_id: string | null;
  source_type: EventSourceType;
  source_message_id: string | null;
  source_channel_id: string | null;
  is_manual: number;
  version: number;
  updated_at: number;
  updated_by: string | null;
}

export interface EventInput {
  id?: number;
  name: string;
  date?: string | null;
  status: EventStatus;
  channelId?: string | null;
  sourceType: EventSourceType;
  sourceMessageId?: string | null;
  sourceChannelId?: string | null;
  isManual?: boolean;
  updatedBy?: string | null;
  /**
   * Required when updating an existing row. The current row's `version` must
   * match this value or a `VersionConflictError` is thrown. Pass `0` for new
   * inserts (caller does not yet know a version).
   */
  expectedVersion?: number;
}

export class VersionConflictError extends Error {
  override readonly name ="VersionConflictError";
  constructor(
    public readonly id: number,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `event ${id} version conflict: expected ${expected}, actual ${actual}`,
    );
  }
}

export class ManualOverrideError extends Error {
  override readonly name ="ManualOverrideError";
  constructor(public readonly id: number) {
    super(`event ${id} is manual; refusing parser-source overwrite`);
  }
}

export class InvalidEventStatusError extends Error {
  override readonly name ="InvalidEventStatusError";
  constructor(public readonly value: string) {
    super(`invalid event status: ${value}`);
  }
}

export class InvalidEventSourceError extends Error {
  override readonly name ="InvalidEventSourceError";
  constructor(public readonly value: string) {
    super(`invalid event source_type: ${value}`);
  }
}

function assertStatus(value: string): asserts value is EventStatus {
  if (!(EVENT_STATUSES as readonly string[]).includes(value)) {
    throw new InvalidEventStatusError(value);
  }
}

function assertSource(value: string): asserts value is EventSourceType {
  if (!(EVENT_SOURCE_TYPES as readonly string[]).includes(value)) {
    throw new InvalidEventSourceError(value);
  }
}

/**
 * Insert a new event row, or update an existing one identified by `input.id`.
 *
 * - On insert, `version` starts at 1.
 * - On update, the current row's `version` must equal `expectedVersion`; the
 *   stored version is bumped by 1.
 * - Parser-source writes (`source_type=backfill_parser`) are rejected when the
 *   current row has `is_manual=1`.
 */
export function upsertEvent(input: EventInput): EventRow {
  assertStatus(input.status);
  assertSource(input.sourceType);

  const db = getDb();
  const now = Date.now();
  const isManual = input.isManual ? 1 : 0;

  if (input.id != null) {
    const existing = db
      .query<EventRow, [number]>(`SELECT * FROM events WHERE id = ?`)
      .get(input.id);
    if (!existing) {
      throw new Error(`event ${input.id} not found`);
    }
    if (
      input.sourceType === "backfill_parser" &&
      existing.is_manual === 1
    ) {
      throw new ManualOverrideError(existing.id);
    }
    const expected = input.expectedVersion ?? existing.version;
    if (existing.version !== expected) {
      throw new VersionConflictError(existing.id, expected, existing.version);
    }
    const nextVersion = existing.version + 1;
    db.query(
      `UPDATE events
         SET name = ?, date = ?, status = ?, channel_id = ?,
             source_type = ?, source_message_id = ?, source_channel_id = ?,
             is_manual = ?, version = ?, updated_at = ?, updated_by = ?
       WHERE id = ?`,
    ).run(
      input.name,
      input.date ?? null,
      input.status,
      input.channelId ?? null,
      input.sourceType,
      input.sourceMessageId ?? null,
      input.sourceChannelId ?? null,
      isManual,
      nextVersion,
      now,
      input.updatedBy ?? null,
      existing.id,
    );
    return db
      .query<EventRow, [number]>(`SELECT * FROM events WHERE id = ?`)
      .get(existing.id)!;
  }

  const inserted = db
    .query<EventRow, [
      string,
      string | null,
      EventStatus,
      string | null,
      EventSourceType,
      string | null,
      string | null,
      number,
      number,
      string | null,
    ]>(
      `INSERT INTO events
         (name, date, status, channel_id, source_type, source_message_id,
          source_channel_id, is_manual, version, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       RETURNING *`,
    )
    .get(
      input.name,
      input.date ?? null,
      input.status,
      input.channelId ?? null,
      input.sourceType,
      input.sourceMessageId ?? null,
      input.sourceChannelId ?? null,
      isManual,
      now,
      input.updatedBy ?? null,
    );
  return inserted!;
}

export function getEventById(id: number): EventRow | null {
  return getDb()
    .query<EventRow, [number]>(`SELECT * FROM events WHERE id = ?`)
    .get(id);
}

export function getEventByName(name: string): EventRow | null {
  return getDb()
    .query<EventRow, [string]>(
      `SELECT * FROM events WHERE name = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(name);
}

export function findEvents(filter: { name?: string; date?: string } = {}): EventRow[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.name !== undefined) {
    clauses.push("name = ?");
    params.push(filter.name);
  }
  if (filter.date !== undefined) {
    clauses.push("date = ?");
    params.push(filter.date);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .query<EventRow, (string | number)[]>(
      `SELECT * FROM events ${where} ORDER BY id ASC`,
    )
    .all(...params);
}
