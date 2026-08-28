import { getChannel } from "../config.ts";
import { redactSecrets } from "../notify/grok-dispatch.ts";
import { applyCalendarSyncResult, getMeeting, type MeetingRow } from "../storage/coordinator-meetings.ts";
import {
  containsEmail,
  packDiscordIdentity,
  stripEmails,
  type CalendarTarget,
  type DiscordIdentity,
  type MeetingAudienceKind,
  type MeetingRecurrence,
  type MeetingSource,
  type PackedDiscordIdentity,
} from "./identity.ts";

export const CALENDAR_SYNC_KIND = "meeting.calendar_sync" as const;
export const CALENDAR_CANCEL_KIND = "meeting.calendar_cancel" as const;

export type CalendarJobKind = typeof CALENDAR_SYNC_KIND | typeof CALENDAR_CANCEL_KIND;

/** Public calendar ids Grok writes as hello@. Not Mini secrets. */
export const EBOARD_CALENDAR_ID =
  "c_9933b833e4985f99fdaf9ce9b7ef54b7bbc478e506c9e83e99743697b82863fb@group.calendar.google.com";
export const LEADERSHIP_CALENDAR_ID = "primary";

export const ROSTER_SHEET_ID = "1NlApvtFAhFTMNafGoVksrYpJhi_oz5dlA6pml5VQ3rw";
export const ROSTER_TAB = "F26";

export interface CalendarJobPack {
  kind: CalendarJobKind;
  meetingId: string;
  version: number;
  outboxId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  notes: string | null;
  calendar: CalendarTarget;
  calendar_id: string;
  conference: boolean;
  recurrence: MeetingRecurrence;
  audience: MeetingAudienceKind;
  requester: PackedDiscordIdentity;
  participants: PackedDiscordIdentity[];
  requested_names: string[];
  source: MeetingSource;
  source_text: string | null;
  source_message_id: string | null;
  participantCount: number;
  calendarEventId: string | null;
  mapper: {
    sheet_id: string;
    tab: string;
    match_order: ["disc", "username", "first_last"];
    empty_disc_fallback: "first_last";
  };
  instruction: string;
}

export function coordinatorJobMessageId(outboxId: string): string {
  return `coordinator-outbox:${outboxId}`;
}

export function isCoordinatorJobMessageId(discordMessageId: string): boolean {
  return discordMessageId.startsWith("coordinator-outbox:");
}

export function isRealDiscordSnowflake(id: string | null | undefined): boolean {
  return Boolean(id && /^\d{16,22}$/.test(id));
}

export function parseCoordinatorJobContent(content: string): CalendarJobPack | null {
  try {
    const parsed = JSON.parse(content) as Partial<CalendarJobPack>;
    if (parsed.kind !== CALENDAR_SYNC_KIND && parsed.kind !== CALENDAR_CANCEL_KIND) return null;
    if (typeof parsed.meetingId !== "string" || typeof parsed.version !== "number") return null;
    return parsed as CalendarJobPack;
  } catch {
    return null;
  }
}

const MAPPER_HINT =
  "Map attendees on Grok via Drive roster sheet 1NlApvtFAhFTMNafGoVksrYpJhi_oz5dlA6pml5VQ3rw tab F26: Disc handle, then username, then First+Last vs guild_nick/global_name. Empty Disc → First+Last. audience=f26_roster means invite every F26 Preferred Email (optional senior advs), not the picker. Never expect emails in this pack.";

const SYNC_INSTRUCTION =
  `Create or update the Google Calendar event as hello@techatnyu.org. calendar=eboard writes the Eboard Calendar (${EBOARD_CALENDAR_ID}); calendar=leadership writes hello@ primary. Request a Google Meet conference unless conference=false. Recurrence weekly uses America/New_York through the F26 term (default until 2026-12-14) unless source_text says otherwise. ${MAPPER_HINT} Then complete this job with JSON only: {"calendar_event_id":"...","meet_link":"https://meet.google.com/..."}. Do not include attendee emails in the complete reply. Mini does not hold Google secrets.`;

const CANCEL_INSTRUCTION =
  `Cancel the Google Calendar event as hello@techatnyu.org using calendar_event_id when present (eboard calendar vs hello@ primary per calendar). Then complete this job with JSON only: {"cancelled":true}. Do not include attendee emails. Mini does not hold Google secrets.`;

export function calendarIdFor(target: CalendarTarget): string {
  return target === "leadership" ? LEADERSHIP_CALENDAR_ID : EBOARD_CALENDAR_ID;
}

export function buildCalendarJobPack(input: {
  kind: CalendarJobKind;
  meeting: Pick<
    MeetingRow,
    | "id"
    | "title"
    | "startsAt"
    | "endsAt"
    | "timeZone"
    | "notes"
    | "calendarEventId"
    | "calendarTarget"
    | "conference"
    | "recurrence"
    | "audienceKind"
    | "source"
    | "sourceText"
    | "sourceMessageId"
    | "requestedNames"
    | "createdByUserId"
    | "createdByUsername"
    | "createdByGlobalName"
    | "createdByGuildNick"
  >;
  outboxId: string;
  version: number;
  participants?: DiscordIdentity[];
  requester?: DiscordIdentity | null;
}): CalendarJobPack {
  const meeting = input.meeting;
  const requester = packDiscordIdentity(
    input.requester ?? {
      userId: meeting.createdByUserId,
      username: meeting.createdByUsername,
      globalName: meeting.createdByGlobalName,
      guildNick: meeting.createdByGuildNick,
    },
  );
  const participants = (input.participants ?? []).map(packDiscordIdentity);
  const notes = meeting.notes ? stripEmails(meeting.notes) : null;
  const sourceText = meeting.sourceText ? stripEmails(meeting.sourceText) : null;
  const requested = (meeting.requestedNames ?? []).map((name) => stripEmails(name)).filter(Boolean);
  return {
    kind: input.kind,
    meetingId: meeting.id,
    version: input.version,
    outboxId: input.outboxId,
    title: meeting.title,
    startsAt: new Date(meeting.startsAt).toISOString(),
    endsAt: new Date(meeting.endsAt).toISOString(),
    timeZone: meeting.timeZone,
    notes,
    calendar: meeting.calendarTarget,
    calendar_id: calendarIdFor(meeting.calendarTarget),
    conference: meeting.conference,
    recurrence: meeting.recurrence,
    audience: meeting.audienceKind,
    requester,
    participants,
    requested_names: requested,
    source: meeting.source,
    source_text: sourceText,
    source_message_id: meeting.sourceMessageId,
    participantCount: participants.length,
    calendarEventId: meeting.calendarEventId,
    mapper: {
      sheet_id: ROSTER_SHEET_ID,
      tab: ROSTER_TAB,
      match_order: ["disc", "username", "first_last"],
      empty_disc_fallback: "first_last",
    },
    instruction: input.kind === CALENDAR_SYNC_KIND ? SYNC_INSTRUCTION : CANCEL_INSTRUCTION,
  };
}

/** Structured job content for Grok. Never includes tokens, webhook secrets, or emails. */
export function serializeCalendarJobPack(pack: CalendarJobPack): string {
  const json = JSON.stringify(pack);
  if (containsEmail(json)) return stripEmails(json);
  return json;
}

export function redactCalendarJobContent(content: string): string {
  return stripEmails(redactSecrets(content));
}

export function parseCalendarCompleteReply(reply: string): {
  calendarEventId?: string;
  meetLink?: string;
  cancelled?: boolean;
} {
  const candidates = [reply.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const calendarEventId =
        typeof parsed.calendar_event_id === "string"
          ? parsed.calendar_event_id
          : typeof parsed.calendarEventId === "string"
            ? parsed.calendarEventId
            : undefined;
      const meetLink =
        typeof parsed.meet_link === "string"
          ? parsed.meet_link
          : typeof parsed.meetLink === "string"
            ? parsed.meetLink
            : undefined;
      const cancelled = parsed.cancelled === true;
      if (calendarEventId || meetLink || cancelled) {
        return { calendarEventId, meetLink, cancelled };
      }
    } catch {
      /* try next candidate */
    }
  }
  return {};
}

export function namespaceForMeetingChannel(
  channelId: string | null,
  resolveChannel: (id: string) => { workspace?: string } | undefined = getChannel,
): string | null {
  if (!channelId) return null;
  const workspace = resolveChannel(channelId)?.workspace;
  return workspace && workspace.length > 0 ? workspace : null;
}

export function applyCoordinatorJobComplete(content: string, reply: string, now: number = Date.now()): void {
  const pack = parseCoordinatorJobContent(content);
  if (!pack || pack.kind !== CALENDAR_SYNC_KIND) return;
  const result = parseCalendarCompleteReply(reply);
  applyCalendarSyncResult({
    meetingId: pack.meetingId,
    version: pack.version,
    calendarEventId: result.calendarEventId,
    meetLink: result.meetLink,
    now,
  });
}

export function formatCalendarCompleteAnnouncement(content: string, reply: string): string | null {
  const pack = parseCoordinatorJobContent(content);
  if (!pack) return null;
  const parsed = parseCalendarCompleteReply(reply);
  if (pack.kind === CALENDAR_CANCEL_KIND || parsed.cancelled) {
    return `Meeting cancelled on Calendar.\nMeeting ID: \`${pack.meetingId}\``;
  }
  const meeting = getMeeting(pack.meetingId);
  const title = meeting?.title ?? pack.title;
  const timeZone = meeting?.timeZone ?? pack.timeZone;
  const startsAt = meeting?.startsAt ?? Date.parse(pack.startsAt);
  const when = Number.isFinite(startsAt)
    ? new Date(startsAt).toLocaleString("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" })
    : pack.startsAt;
  const meet = meeting?.meetLink ?? parsed.meetLink;
  return `📅 **${title}**\n${when}${meet ? `\nMeet: ${meet}` : ""}\nMeeting ID: \`${pack.meetingId}\``;
}
