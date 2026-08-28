import { getChannel } from "../config.ts";
import { redactSecrets } from "../notify/grok-dispatch.ts";
import { applyCalendarSyncResult, type MeetingRow } from "../storage/coordinator-meetings.ts";

export const CALENDAR_SYNC_KIND = "meeting.calendar_sync" as const;
export const CALENDAR_CANCEL_KIND = "meeting.calendar_cancel" as const;

export type CalendarJobKind = typeof CALENDAR_SYNC_KIND | typeof CALENDAR_CANCEL_KIND;

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
  participantCount: number;
  calendarEventId: string | null;
  instruction: string;
}

export function coordinatorJobMessageId(outboxId: string): string {
  return `coordinator-outbox:${outboxId}`;
}

export function isCoordinatorJobMessageId(discordMessageId: string): boolean {
  return discordMessageId.startsWith("coordinator-outbox:");
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

const SYNC_INSTRUCTION =
  "Create or update the Eboard Google Calendar event as hello@techatnyu.org. Request a Google Meet conference. Then complete this job with JSON only: {\"calendar_event_id\":\"...\",\"meet_link\":\"https://meet.google.com/...\"}. Do not include attendee emails. Mini does not hold Google secrets.";

const CANCEL_INSTRUCTION =
  "Cancel the Eboard Google Calendar event as hello@techatnyu.org using calendar_event_id when present. Then complete this job with JSON only: {\"cancelled\":true}. Do not include attendee emails. Mini does not hold Google secrets.";

export function buildCalendarJobPack(input: {
  kind: CalendarJobKind;
  meeting: Pick<
    MeetingRow,
    "id" | "title" | "startsAt" | "endsAt" | "timeZone" | "notes" | "calendarEventId"
  >;
  outboxId: string;
  version: number;
  participantCount: number;
}): CalendarJobPack {
  return {
    kind: input.kind,
    meetingId: input.meeting.id,
    version: input.version,
    outboxId: input.outboxId,
    title: input.meeting.title,
    startsAt: new Date(input.meeting.startsAt).toISOString(),
    endsAt: new Date(input.meeting.endsAt).toISOString(),
    timeZone: input.meeting.timeZone,
    notes: input.meeting.notes,
    participantCount: input.participantCount,
    calendarEventId: input.meeting.calendarEventId,
    instruction: input.kind === CALENDAR_SYNC_KIND ? SYNC_INSTRUCTION : CANCEL_INSTRUCTION,
  };
}

/** Structured job content for Grok. Never includes tokens, webhook secrets, or emails. */
export function serializeCalendarJobPack(pack: CalendarJobPack): string {
  return JSON.stringify(pack);
}

export function redactCalendarJobContent(content: string): string {
  return redactSecrets(content);
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
