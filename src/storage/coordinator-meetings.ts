import type {
  CalendarTarget,
  DiscordIdentity,
  MeetingAudienceKind,
  MeetingRecurrence,
  MeetingSource,
} from "../coordinator/identity.ts";
import { displayNameOf } from "../coordinator/identity.ts";
import { getDb } from "./db.ts";
import { insertOutboxEvent, type OutboxEvent } from "./outbox.ts";

export type MeetingStatus = "scheduled" | "cancelled";

export interface MeetingRow {
  id: string;
  createdByUserId: string;
  createdByUsername: string | null;
  createdByGlobalName: string | null;
  createdByGuildNick: string | null;
  title: string;
  startsAt: number;
  endsAt: number;
  timeZone: string;
  notes: string | null;
  status: MeetingStatus;
  version: number;
  channelId: string | null;
  calendarEventId: string | null;
  meetLink: string | null;
  calendarTarget: CalendarTarget;
  conference: boolean;
  recurrence: MeetingRecurrence;
  audienceKind: MeetingAudienceKind;
  source: MeetingSource;
  sourceMessageId: string | null;
  sourceText: string | null;
  requestedNames: string[];
  announcedAt: number | null;
  hourReminderAt: number | null;
  hourReminderSentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MeetingParticipantRow {
  meetingId: string;
  userId: string;
  displayName: string | null;
  username: string | null;
  globalName: string | null;
  guildNick: string | null;
  createdAt: number;
}

export interface MeetingAssigneeInput {
  userId: string;
  username?: string | null;
  globalName?: string | null;
  guildNick?: string | null;
  displayName?: string | null;
}

interface MeetingDbRow {
  id: string;
  created_by_user_id: string;
  created_by_username: string | null;
  created_by_global_name: string | null;
  created_by_guild_nick: string | null;
  title: string;
  starts_at: number;
  ends_at: number;
  time_zone: string;
  notes: string | null;
  status: string;
  version: number;
  channel_id: string | null;
  calendar_event_id: string | null;
  meet_link: string | null;
  calendar_target: string | null;
  conference: number | null;
  recurrence: string | null;
  audience_kind: string | null;
  source: string | null;
  source_message_id: string | null;
  source_text: string | null;
  requested_names: string | null;
  announced_at: number | null;
  hour_reminder_at: number | null;
  hour_reminder_sent_at: number | null;
  created_at: number;
  updated_at: number;
}

function parseRequestedNames(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  } catch {
    return [];
  }
}

const HOUR_MS = 60 * 60_000;

function mapMeeting(row: MeetingDbRow): MeetingRow {
  return {
    id: row.id,
    createdByUserId: row.created_by_user_id,
    createdByUsername: row.created_by_username ?? null,
    createdByGlobalName: row.created_by_global_name ?? null,
    createdByGuildNick: row.created_by_guild_nick ?? null,
    title: row.title,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timeZone: row.time_zone,
    notes: row.notes,
    status: row.status as MeetingStatus,
    version: row.version,
    channelId: row.channel_id,
    calendarEventId: row.calendar_event_id,
    meetLink: row.meet_link,
    calendarTarget: row.calendar_target === "leadership" ? "leadership" : "eboard",
    conference: row.conference !== 0,
    recurrence: row.recurrence === "weekly" ? "weekly" : "none",
    audienceKind: row.audience_kind === "f26_roster" ? "f26_roster" : "picked",
    source: row.source === "mention" ? "mention" : "slash",
    sourceMessageId: row.source_message_id ?? null,
    sourceText: row.source_text ?? null,
    requestedNames: parseRequestedNames(row.requested_names),
    announcedAt: row.announced_at,
    hourReminderAt: row.hour_reminder_at,
    hourReminderSentAt: row.hour_reminder_sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getMeeting(id: string): MeetingRow | null {
  const row = getDb().query<MeetingDbRow, [string]>(`SELECT * FROM meetings WHERE id = ?`).get(id);
  return row ? mapMeeting(row) : null;
}

export function getMeetingParticipants(meetingId: string): MeetingParticipantRow[] {
  return getDb()
    .query<MeetingParticipantRow, [string]>(
      `SELECT meeting_id AS meetingId, user_id AS userId, display_name AS displayName,
              username, global_name AS globalName, guild_nick AS guildNick, created_at AS createdAt
       FROM meeting_participants WHERE meeting_id = ? ORDER BY created_at ASC`,
    )
    .all(meetingId);
}

export function createScheduledMeeting(input: {
  id?: string;
  createdByUserId: string;
  createdBy?: DiscordIdentity | null;
  title: string;
  startsAt: number;
  durationMinutes: number;
  timeZone?: string;
  notes?: string | null;
  channelId?: string | null;
  participants: MeetingAssigneeInput[];
  calendarTarget?: CalendarTarget;
  conference?: boolean;
  recurrence?: MeetingRecurrence;
  audienceKind?: MeetingAudienceKind;
  source?: MeetingSource;
  sourceMessageId?: string | null;
  sourceText?: string | null;
  requestedNames?: string[];
  now?: number;
}): { meeting: MeetingRow; outboxEvents: OutboxEvent[] } {
  const now = input.now ?? Date.now();
  const title = input.title.trim().slice(0, 100);
  if (!title) throw new Error("Meeting title is required.");
  if (input.startsAt <= now) throw new Error("Meeting start time must be in the future.");
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 15 || input.durationMinutes > 480) {
    throw new Error("Duration must be between 15 and 480 minutes.");
  }
  const unique = [...new Map(input.participants.map((p) => [p.userId, p])).values()];
  const audienceKind = input.audienceKind ?? "picked";
  if (unique.length === 0 && audienceKind !== "f26_roster") {
    throw new Error("Add at least one attendee.");
  }
  const endsAt = input.startsAt + input.durationMinutes * 60_000;
  const timeZone = input.timeZone?.trim() || "America/New_York";
  const id = input.id ?? crypto.randomUUID();
  const hourReminderAt = input.startsAt - HOUR_MS;
  const creator = input.createdBy;

  return getDb().transaction(() => {
    getDb()
      .query(
        `INSERT INTO meetings (
           id, created_by_user_id, created_by_username, created_by_global_name, created_by_guild_nick,
           title, starts_at, ends_at, time_zone, notes, status, version,
           channel_id, hour_reminder_at, calendar_target, conference, recurrence, audience_kind,
           source, source_message_id, source_text, requested_names, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.createdByUserId,
        creator?.username ?? null,
        creator?.globalName ?? null,
        creator?.guildNick ?? null,
        title,
        input.startsAt,
        endsAt,
        timeZone,
        input.notes?.trim() || null,
        input.channelId ?? null,
        hourReminderAt,
        input.calendarTarget ?? "eboard",
        input.conference === false ? 0 : 1,
        input.recurrence ?? "none",
        audienceKind,
        input.source ?? "slash",
        input.sourceMessageId ?? null,
        input.sourceText?.trim() || null,
        JSON.stringify(input.requestedNames ?? []),
        now,
        now,
      );
    for (const person of unique) {
      const display =
        person.displayName ??
        displayNameOf({
          userId: person.userId,
          username: person.username ?? null,
          globalName: person.globalName ?? null,
          guildNick: person.guildNick ?? null,
        });
      getDb()
        .query(
          `INSERT INTO meeting_participants (
             meeting_id, user_id, display_name, username, global_name, guild_nick, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          person.userId,
          display,
          person.username ?? null,
          person.globalName ?? null,
          person.guildNick ?? null,
          now,
        );
    }
    const outbox = insertOutboxEvent({
      type: "meeting.calendar_sync_requested",
      aggregateId: id,
      expectedVersion: 1,
      payload: { meetingId: id, version: 1 },
    });
    const meeting = getMeeting(id);
    if (!meeting) throw new Error("createScheduledMeeting: insert succeeded but row missing");
    return { meeting, outboxEvents: outbox ? [outbox] : [] };
  })();
}

export function setMeetingSourceMessageId(meetingId: string, messageId: string): MeetingRow | null {
  const row = getDb()
    .query<MeetingDbRow, [string, string]>(
      `UPDATE meetings SET source_message_id = ? WHERE id = ? RETURNING *`,
    )
    .get(messageId, meetingId);
  return row ? mapMeeting(row) : getMeeting(meetingId);
}

export function cancelMeeting(input: {
  meetingId: string;
  creatorUserId: string;
  now?: number;
}): { meeting: MeetingRow; outboxEvents: OutboxEvent[] } {
  const now = input.now ?? Date.now();
  return getDb().transaction(() => {
    const existing = getMeeting(input.meetingId);
    if (!existing) throw new Error("Meeting not found.");
    if (existing.createdByUserId !== input.creatorUserId) {
      throw new Error("Only the meeting creator can cancel it.");
    }
    if (existing.status === "cancelled") throw new Error("This meeting is already cancelled.");
    const row = getDb()
      .query<MeetingDbRow, [number, string]>(
        `UPDATE meetings
         SET status = 'cancelled', version = version + 1, updated_at = ?
         WHERE id = ?
         RETURNING *`,
      )
      .get(now, existing.id);
    if (!row) throw new Error("Unable to cancel meeting.");
    const meeting = mapMeeting(row);
    const outbox = insertOutboxEvent({
      type: "meeting.calendar_cancel_requested",
      aggregateId: meeting.id,
      expectedVersion: meeting.version,
      payload: {
        meetingId: meeting.id,
        version: meeting.version,
        calendarEventId: meeting.calendarEventId,
      },
    });
    return { meeting, outboxEvents: outbox ? [outbox] : [] };
  })();
}

export function applyCalendarSyncResult(input: {
  meetingId: string;
  version: number;
  calendarEventId?: string | null;
  meetLink?: string | null;
  now?: number;
}): MeetingRow | null {
  const now = input.now ?? Date.now();
  const meeting = getMeeting(input.meetingId);
  if (!meeting || meeting.status !== "scheduled") return null;
  if (meeting.version !== input.version) return meeting;
  const row = getDb()
    .query<MeetingDbRow, [string | null, string | null, number, string]>(
      `UPDATE meetings
       SET calendar_event_id = COALESCE(?, calendar_event_id),
           meet_link = COALESCE(?, meet_link),
           updated_at = ?
       WHERE id = ?
       RETURNING *`,
    )
    .get(input.calendarEventId ?? null, input.meetLink ?? null, now, meeting.id);
  return row ? mapMeeting(row) : meeting;
}

export function markMeetingAnnounced(meetingId: string, now: number = Date.now()): MeetingRow | null {
  const row = getDb()
    .query<MeetingDbRow, [number, number, string]>(
      `UPDATE meetings SET announced_at = ?, updated_at = ? WHERE id = ? AND announced_at IS NULL RETURNING *`,
    )
    .get(now, now, meetingId);
  return row ? mapMeeting(row) : getMeeting(meetingId);
}

export function listDueMeetingHourReminders(now: number = Date.now()): MeetingRow[] {
  return getDb()
    .query<MeetingDbRow, [number, number]>(
      `SELECT * FROM meetings
       WHERE status = 'scheduled'
         AND hour_reminder_sent_at IS NULL
         AND hour_reminder_at IS NOT NULL
         AND hour_reminder_at <= ?
         AND starts_at > ?`,
    )
    .all(now, now - HOUR_MS)
    .map(mapMeeting);
}

export function markMeetingHourReminderSent(meetingId: string, now: number = Date.now()): boolean {
  const res = getDb()
    .query(
      `UPDATE meetings SET hour_reminder_sent_at = ?, updated_at = ?
       WHERE id = ? AND hour_reminder_sent_at IS NULL`,
    )
    .run(now, now, meetingId);
  return Number(res.changes ?? 0) > 0;
}

export function listUnannouncedScheduledMeetings(): MeetingRow[] {
  return getDb()
    .query<MeetingDbRow, []>(
      `SELECT * FROM meetings
       WHERE status = 'scheduled' AND announced_at IS NULL
       ORDER BY created_at ASC`,
    )
    .all()
    .map(mapMeeting);
}
