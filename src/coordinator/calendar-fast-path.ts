import { logger } from "../logger.ts";
import { resolveAttendeeEmails, type MeetingAudienceKind } from "./attendees.ts";
import { CalendarApiError, createGoogleCalendarClient, type CalendarClient } from "./calendar-client.ts";
import { createGoogleTokenSource, parseGoogleAuthEnv } from "./google-auth.ts";

/**
 * Why the Mini could not do the insert itself. Every one of these falls back to
 * the Grok handoff, so a fast-path miss degrades to the old behaviour rather
 * than dropping the meeting.
 */
export type FastPathSkip =
  | "not-configured"
  | "disabled"
  | "no-attendees"
  | "unresolved-participants"
  | "missing-event-id"
  | "api-error";

export type FastPathOutcome =
  | { ok: true; calendarEventId: string | null; meetLink: string | null; attendeeCount: number }
  | { ok: false; skip: FastPathSkip };

export interface CalendarFastPathDeps {
  client?: CalendarClient | null;
  calendarId?: string;
  env?: NodeJS.ProcessEnv;
}

function isEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.MINI_CALENDAR_INSERT?.trim().toLowerCase();
  // Default on: if the operator went to the trouble of provisioning a service
  // account, the deterministic path is what they asked for. The flag exists as
  // a kill switch back to Grok without pulling credentials out of Doppler.
  if (raw === undefined || raw === "") return true;
  return raw !== "false" && raw !== "0" && raw !== "no";
}

/**
 * `primary` resolves to the impersonated subject's own calendar, which under
 * domain-wide delegation is hello@techatnyu.org -- the Eboard calendar.
 */
function calendarIdFrom(env: NodeJS.ProcessEnv): string {
  return env.GOOGLE_CALENDAR_ID?.trim() || "primary";
}

/** Built once per process; `null` means credentials are absent. */
let cachedClient: CalendarClient | null | undefined;

export function resetCalendarClientCache(): void {
  cachedClient = undefined;
}

function clientFor(env: NodeJS.ProcessEnv): CalendarClient | null {
  if (cachedClient !== undefined) return cachedClient;
  const config = parseGoogleAuthEnv(env);
  cachedClient = config
    ? createGoogleCalendarClient({ tokenSource: createGoogleTokenSource(config) })
    : null;
  return cachedClient;
}

/**
 * The deterministic Calendar path: resolve snowflakes to addresses here, on the
 * box that holds `roster_bindings`, then call Calendar as hello@ directly. No
 * agent turn, no attendee email ever leaving this process.
 *
 * Returns `{ ok: false }` for anything it cannot do confidently; the caller
 * hands those to Grok exactly as before.
 */
export async function tryMiniCalendarSync(
  input: {
    meetingId: string;
    title: string;
    startsAt: string;
    endsAt: string;
    timeZone: string;
    notes: string | null;
    audience: MeetingAudienceKind;
    participantIds: string[];
    calendarEventId: string | null;
  },
  deps: CalendarFastPathDeps = {},
): Promise<FastPathOutcome> {
  const env = deps.env ?? process.env;
  if (!isEnabled(env)) return { ok: false, skip: "disabled" };

  const client = deps.client !== undefined ? deps.client : clientFor(env);
  if (!client) return { ok: false, skip: "not-configured" };

  const resolved = resolveAttendeeEmails({
    audience: input.audience,
    participantIds: input.participantIds,
  });

  // A partial invite is worse than a slow one: bail to Grok rather than create
  // an event that silently omits someone the organizer picked. `/meet` already
  // refuses unmapped attendees up front, so this is defence in depth.
  if (resolved.unresolved.length > 0) {
    logger.warn(
      { meeting_id: input.meetingId, unresolved: resolved.unresolved.length },
      "calendar fast path: participants have no roster binding",
    );
    return { ok: false, skip: "unresolved-participants" };
  }
  if (resolved.emails.length === 0) return { ok: false, skip: "no-attendees" };

  try {
    const result = await client.upsertEvent({
      calendarId: deps.calendarId ?? calendarIdFrom(env),
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timeZone: input.timeZone,
      description: input.notes,
      attendeeEmails: resolved.emails,
      requestMeet: true,
      eventId: input.calendarEventId,
    });
    logger.info(
      {
        meeting_id: input.meetingId,
        attendees: resolved.emails.length,
        roster: resolved.rosterCount,
        updated: Boolean(input.calendarEventId),
      },
      "calendar fast path: event synced by the Mini",
    );
    return {
      ok: true,
      calendarEventId: result.calendarEventId,
      meetLink: result.meetLink,
      attendeeCount: resolved.emails.length,
    };
  } catch (error) {
    // Counts only -- never the addresses, never the token.
    logger.error(
      {
        meeting_id: input.meetingId,
        attendees: resolved.emails.length,
        status: error instanceof CalendarApiError ? error.status : undefined,
      },
      "calendar fast path failed; falling back to Grok",
    );
    return { ok: false, skip: "api-error" };
  }
}

export async function tryMiniCalendarCancel(
  input: { meetingId: string; calendarEventId: string | null },
  deps: CalendarFastPathDeps = {},
): Promise<FastPathOutcome> {
  const env = deps.env ?? process.env;
  if (!isEnabled(env)) return { ok: false, skip: "disabled" };

  const client = deps.client !== undefined ? deps.client : clientFor(env);
  if (!client) return { ok: false, skip: "not-configured" };
  // Nothing was ever created, so there is nothing for anyone to cancel. Grok
  // cannot do better with no id either, but the old path owns that decision.
  if (!input.calendarEventId) return { ok: false, skip: "missing-event-id" };

  try {
    await client.cancelEvent({
      calendarId: deps.calendarId ?? calendarIdFrom(env),
      eventId: input.calendarEventId,
    });
    logger.info({ meeting_id: input.meetingId }, "calendar fast path: event cancelled by the Mini");
    return { ok: true, calendarEventId: input.calendarEventId, meetLink: null, attendeeCount: 0 };
  } catch (error) {
    logger.error(
      {
        meeting_id: input.meetingId,
        status: error instanceof CalendarApiError ? error.status : undefined,
      },
      "calendar fast path cancel failed; falling back to Grok",
    );
    return { ok: false, skip: "api-error" };
  }
}
