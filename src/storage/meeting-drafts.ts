import { getDb } from "./db.ts";

/**
 * How long a `/meet create` draft stays usable.
 *
 * Discord's ephemeral message components stop working at roughly the
 * fifteen-minute mark, so a draft that outlives them is useless anyway: the user
 * can no longer touch the selector that would consume it. Expiring on the same
 * clock keeps the table self-cleaning instead of accumulating one abandoned row
 * per abandoned command, which is exactly what the old process-local Map did.
 */
export const MEETING_DRAFT_TTL_MS = 15 * 60_000;

/** Defensive caps, mirroring the `meetings` table's own title clamp. */
const MAX_TITLE_LENGTH = 100;
const MAX_NOTES_LENGTH = 1000;
const MAX_LOCATION_LENGTH = 200;
/** Matches the audience select menu's own max, so a full pick always fits. */
const MAX_PARTICIPANTS = 25;

export type MeetingDraftAudienceKind = "picked" | "f26_roster";

export interface MeetingDraftParticipant {
  userId: string;
  displayName: string;
}

export interface MeetingDraftAudience {
  audienceKind: MeetingDraftAudienceKind;
  participants: MeetingDraftParticipant[];
}

export interface MeetingDraftRow {
  id: string;
  createdByUserId: string;
  channelId: string;
  title: string;
  startsAt: number;
  durationMinutes: number;
  timeZone: string;
  notes: string | null;
  location: string | null;
  /** Null until the select step runs, or if the stored JSON is unreadable. */
  audience: MeetingDraftAudience | null;
  createdAt: number;
  expiresAt: number;
}

interface MeetingDraftDbRow {
  id: string;
  created_by_user_id: string;
  channel_id: string;
  title: string;
  starts_at: number;
  duration_minutes: number;
  time_zone: string;
  notes: string | null;
  location: string | null;
  audience_json: string | null;
  created_at: number;
  expires_at: number;
}

/**
 * Defensive parse, in the spirit of `outbox.ts` `parsePayload`: a draft whose
 * `audience_json` is malformed, hand-edited, or written by an older shape must
 * read back as `audience: null` rather than throwing in the middle of an
 * interaction handler. A half-valid object yields null too -- a partially
 * understood audience is worse than none, because the caller would book it.
 */
function parseAudience(raw: string | null): MeetingDraftAudience | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const kind = obj.audienceKind;
    if (kind !== "picked" && kind !== "f26_roster") return null;
    if (!Array.isArray(obj.participants)) return null;
    const participants: MeetingDraftParticipant[] = [];
    for (const entry of obj.participants) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const { userId, displayName } = entry as Record<string, unknown>;
      if (typeof userId !== "string" || typeof displayName !== "string") return null;
      participants.push({ userId, displayName });
    }
    return { audienceKind: kind, participants };
  } catch {
    return null;
  }
}

function mapRow(row: MeetingDraftDbRow): MeetingDraftRow {
  return {
    id: row.id,
    createdByUserId: row.created_by_user_id,
    channelId: row.channel_id,
    title: row.title,
    startsAt: row.starts_at,
    durationMinutes: row.duration_minutes,
    timeZone: row.time_zone,
    notes: row.notes,
    location: row.location,
    audience: parseAudience(row.audience_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function createMeetingDraft(input: {
  createdByUserId: string;
  channelId: string;
  title: string;
  startsAt: number;
  durationMinutes: number;
  timeZone: string;
  notes: string | null;
  location: string | null;
  now?: number;
}): MeetingDraftRow {
  const now = input.now ?? Date.now();
  const title = input.title.trim().slice(0, MAX_TITLE_LENGTH);
  if (!title) throw new Error("Meeting title is required.");
  const timeZone = input.timeZone.trim() || "America/New_York";
  const notes = input.notes?.trim().slice(0, MAX_NOTES_LENGTH) || null;
  const location = input.location?.trim().slice(0, MAX_LOCATION_LENGTH) || null;
  const id = crypto.randomUUID();
  const row = getDb()
    .query<
      MeetingDraftDbRow,
      [
        string, string, string, string, number, number,
        string, string | null, string | null, number, number,
      ]
    >(
      `INSERT INTO meeting_drafts (
         id, created_by_user_id, channel_id, title, starts_at, duration_minutes,
         time_zone, notes, location, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      id,
      input.createdByUserId,
      input.channelId,
      title,
      input.startsAt,
      input.durationMinutes,
      timeZone,
      notes,
      location,
      now,
      now + MEETING_DRAFT_TTL_MS,
    );
  if (!row) throw new Error("createMeetingDraft: insert succeeded but row missing");
  return mapRow(row);
}

/**
 * Null when missing, expired, or owned by someone else.
 *
 * Ownership and expiry are both in the predicate on purpose: a draft is only
 * ever readable by the user who created it, and a row that is past `expires_at`
 * but not yet swept must already be invisible. Neither check is the caller's to
 * remember.
 */
export function getMeetingDraft(
  id: string,
  requestedByUserId: string,
  now: number = Date.now(),
): MeetingDraftRow | null {
  const row = getDb()
    .query<MeetingDraftDbRow, [string, string, number]>(
      `SELECT * FROM meeting_drafts
       WHERE id = ? AND created_by_user_id = ? AND expires_at > ?`,
    )
    .get(id, requestedByUserId, now);
  return row ? mapRow(row) : null;
}

/**
 * Persist the resolved audience chosen in the select step. Returns null if the
 * draft is missing, expired, or not owned by this user.
 *
 * A Discord button click does not carry the values of a select menu in the same
 * message, so the audience has to survive the hop from the select interaction to
 * the final Confirm click.
 *
 * This write also pushes `expires_at` out by a fresh TTL. The user is visibly
 * mid-flow, and the clock exists to track the life of the ephemeral components
 * they are interacting with -- which Discord likewise measures from the latest
 * interaction, not from the first. Without the refresh, a user who spends twelve
 * minutes picking attendees gets three minutes to hit Confirm.
 */
export function setMeetingDraftAudience(
  id: string,
  requestedByUserId: string,
  audience: MeetingDraftAudience,
  now: number = Date.now(),
): MeetingDraftRow | null {
  const participants = audience.participants
    .slice(0, MAX_PARTICIPANTS)
    .map((p) => ({ userId: p.userId, displayName: p.displayName }));
  const payload = JSON.stringify({ audienceKind: audience.audienceKind, participants });
  const row = getDb()
    .query<MeetingDraftDbRow, [string, number, string, string, number]>(
      `UPDATE meeting_drafts
       SET audience_json = ?, expires_at = ?
       WHERE id = ? AND created_by_user_id = ? AND expires_at > ?
       RETURNING *`,
    )
    .get(payload, now + MEETING_DRAFT_TTL_MS, id, requestedByUserId, now);
  return row ? mapRow(row) : null;
}

/**
 * Consume a draft exactly once; null if already consumed, expired, or not owned.
 *
 * The read and the delete are a single `DELETE ... RETURNING`, so two concurrent
 * clicks on "Confirm" cannot both come away with the draft and book the meeting
 * twice. Splitting this into a SELECT then a DELETE reopens that hole -- keep it
 * one statement.
 */
export function claimMeetingDraft(
  id: string,
  requestedByUserId: string,
  now: number = Date.now(),
): MeetingDraftRow | null {
  const row = getDb()
    .query<MeetingDraftDbRow, [string, string, number]>(
      `DELETE FROM meeting_drafts
       WHERE id = ? AND created_by_user_id = ? AND expires_at > ?
       RETURNING *`,
    )
    .get(id, requestedByUserId, now);
  return row ? mapRow(row) : null;
}

/** Housekeeping; returns rows removed. */
export function deleteExpiredMeetingDrafts(now: number = Date.now()): number {
  const res = getDb().query(`DELETE FROM meeting_drafts WHERE expires_at <= ?`).run(now);
  return Number(res.changes ?? 0);
}
