import { logger } from "../logger.ts";
import { resolveAttendeeEmails, type MeetingAudienceKind } from "./attendees.ts";
import {
  CalendarApiError,
  calendarEventIdFor,
  createGoogleCalendarClient,
  type CalendarClient,
  type CalendarEventResult,
} from "./calendar-client.ts";
import { createGoogleTokenSource, parseGoogleAuthEnv } from "./google-auth.ts";

/**
 * Why the Mini could not finish the insert itself.
 *
 * Two families. The first hands off to Grok exactly as before, so a miss
 * degrades to the old behaviour rather than dropping the meeting:
 *   not-configured, disabled, no-attendees, unresolved-participants,
 *   missing-event-id, api-error (proven: no event exists under our id).
 *
 * The second must NOT go to Grok, because the event may already exist and a
 * second create would mail the whole guest list twice. The caller keeps the
 * outbox row pending so the sweeper retries the Mini path:
 *   meet-pending  -- the event exists (`calendarEventId` set) but Google has
 *                    not provisioned the Meet yet, or it failed.
 *   unknown-state -- the call timed out / errored AND the lookup that would
 *                    prove absence also failed.
 */
export type FastPathSkip =
  | "not-configured"
  | "disabled"
  | "no-attendees"
  | "unresolved-participants"
  | "missing-event-id"
  | "api-error"
  | "meet-pending"
  | "meet-failed"
  | "unknown-state";

export const DEFERRING_SKIPS: ReadonlySet<FastPathSkip> = new Set<FastPathSkip>([
  "meet-pending",
  "meet-failed",
  "unknown-state",
]);

export type FastPathOutcome =
  | {
      ok: true;
      calendarEventId: string | null;
      meetLink: string | null;
      attendeeCount: number;
      /** `f26_roster` extras that had no binding and were left off; always 0 for `picked`. */
      unresolvedCount?: number;
    }
  | { ok: false; skip: FastPathSkip; calendarEventId?: string | null };

export interface CalendarFastPathDeps {
  client?: CalendarClient | null;
  calendarId?: string;
  env?: NodeJS.ProcessEnv;
  /** Whole-path budget (token + create + Meet poll). Past it we abort and look the event up. */
  timeoutMs?: number;
  /** Budget for the single existence check after a timeout or error. */
  lookupTimeoutMs?: number;
}

/**
 * The Discord handler awaits this before answering; Google is normally well
 * under a second. Past the budget the fetch is aborted (not just abandoned)
 * so a hung TLS handshake cannot pin the sweeper's `Promise.all`.
 */
export const DEFAULT_FAST_PATH_TIMEOUT_MS = 5_000;
export const DEFAULT_LOOKUP_TIMEOUT_MS = 2_000;

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

function timeoutFrom(env: NodeJS.ProcessEnv, deps: CalendarFastPathDeps): number {
  if (deps.timeoutMs !== undefined) return deps.timeoutMs;
  const raw = Number(env.MINI_CALENDAR_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FAST_PATH_TIMEOUT_MS;
}

/** Built once per process for the real environment; `null` means credentials are absent. */
let cachedClient: CalendarClient | null | undefined;

export function resetCalendarClientCache(): void {
  cachedClient = undefined;
}

function clientFor(env: NodeJS.ProcessEnv): CalendarClient | null {
  // Only the process environment is cached: a caller-supplied env (tests, a
  // future per-workspace config) is evaluated every time, so an early miss
  // never pins later calls to "not configured".
  const cacheable = env === process.env;
  if (cacheable && cachedClient !== undefined) return cachedClient;
  const config = parseGoogleAuthEnv(env);
  const client = config ? createGoogleCalendarClient({ tokenSource: createGoogleTokenSource(config) }) : null;
  if (cacheable) cachedClient = client;
  return client;
}

function deadline(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Existence check by deterministic id, with its own short budget.
 * `undefined` means the lookup itself failed, which is different from `null`
 * (proven absent): only the latter may hand off to Grok.
 */
async function lookupEvent(
  client: CalendarClient,
  calendarId: string,
  eventId: string,
  timeoutMs: number,
): Promise<CalendarEventResult | null | undefined> {
  const guard = deadline(timeoutMs);
  try {
    return await client.getEvent({ calendarId, eventId, signal: guard.signal });
  } catch {
    return undefined;
  } finally {
    guard.clear();
  }
}

/**
 * The deterministic Calendar path: resolve snowflakes to addresses here, on the
 * box that holds `roster_bindings`, then call Calendar as hello@ directly. No
 * agent turn, no attendee email ever leaving this process.
 *
 * Returns `{ ok: false }` for anything it cannot do confidently; see
 * {@link FastPathSkip} for which of those the caller may hand to Grok.
 */
export async function tryMiniCalendarSync(
  input: {
    meetingId: string;
    title: string;
    startsAt: string;
    endsAt: string;
    timeZone: string;
    notes: string | null;
    location: string | null;
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

  if (resolved.unresolved.length > 0) {
    logger.warn(
      { meeting_id: input.meetingId, audience: input.audience, unresolved: resolved.unresolved.length },
      "calendar fast path: participants have no roster binding",
    );
    // A partial `picked` invite is worse than a slow one: bail to Grok rather
    // than create an event that silently omits someone the organizer chose.
    // `/meet` already refuses unmapped attendees up front, so this is defence
    // in depth. For `f26_roster` the roster itself is the audience; an unmapped
    // extra is reported (`unresolvedCount`) rather than blocking everyone else,
    // since Grok has no roster map either and could not do better.
    if (input.audience === "picked") return { ok: false, skip: "unresolved-participants" };
  }
  if (resolved.emails.length === 0) return { ok: false, skip: "no-attendees" };

  const calendarId = deps.calendarId ?? calendarIdFrom(env);
  const eventId = input.calendarEventId ?? calendarEventIdFor(input.meetingId);
  const guard = deadline(timeoutFrom(env, deps));
  let result: CalendarEventResult;
  try {
    result = await client.upsertEvent({
      calendarId,
      meetingId: input.meetingId,
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timeZone: input.timeZone,
      description: input.notes,
      location: input.location,
      attendeeEmails: resolved.emails,
      requestMeet: true,
      eventId: input.calendarEventId,
      signal: guard.signal,
    });
  } catch (error) {
    guard.clear();
    const apiError = error instanceof CalendarApiError ? error : null;
    // Counts only -- never the addresses, never the token.
    const detail = {
      meeting_id: input.meetingId,
      attendees: resolved.emails.length,
      status: apiError?.status,
      reason: apiError?.reason ?? "thrown",
    };

    // The event exists; only the Meet is missing. Keep the id, retry later.
    if (apiError?.calendarEventId) {
      const skip = apiError.reason === "meet-failed" ? "meet-failed" : "meet-pending";
      logger.warn(detail, `calendar fast path: event exists but Meet is ${skip === "meet-failed" ? "failed" : "not ready"}; deferring`);
      return { ok: false, skip, calendarEventId: apiError.calendarEventId };
    }

    // Anything else (timeout, 5xx after retries, network) may have committed on
    // Google's side. Grok only gets the job once a lookup proves no event exists
    // under our id; otherwise it would create a second one.
    const found = await lookupEvent(client, calendarId, eventId, deps.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS);
    if (found === undefined) {
      logger.error(detail, "calendar fast path failed and the existence check failed too; deferring");
      return { ok: false, skip: "unknown-state" };
    }
    if (found === null) {
      logger.error(detail, "calendar fast path failed; no event exists, falling back to Grok");
      return { ok: false, skip: "api-error" };
    }
    if (found.meetLink === null) {
      logger.warn(detail, "calendar fast path: event landed despite the error; Meet not ready; deferring");
      return { ok: false, skip: "meet-pending", calendarEventId: found.calendarEventId };
    }
    logger.info(detail, "calendar fast path: event landed despite the error");
    result = found;
  } finally {
    guard.clear();
  }

  logger.info(
    {
      meeting_id: input.meetingId,
      attendees: resolved.emails.length,
      roster: resolved.rosterCount,
      unresolved: resolved.unresolved.length,
      updated: Boolean(input.calendarEventId),
    },
    "calendar fast path: event synced by the Mini",
  );
  return {
    ok: true,
    calendarEventId: result.calendarEventId,
    meetLink: result.meetLink,
    attendeeCount: resolved.emails.length,
    unresolvedCount: resolved.unresolved.length,
  };
}

export async function tryMiniCalendarCancel(
  input: { meetingId: string; calendarEventId: string | null },
  deps: CalendarFastPathDeps = {},
): Promise<FastPathOutcome> {
  const env = deps.env ?? process.env;
  if (!isEnabled(env)) return { ok: false, skip: "disabled" };

  const client = deps.client !== undefined ? deps.client : clientFor(env);
  if (!client) return { ok: false, skip: "not-configured" };

  const calendarId = deps.calendarId ?? calendarIdFrom(env);
  let eventId = input.calendarEventId;
  if (!eventId) {
    // The cancel row snapshots `calendarEventId` at cancel time, so a cancel
    // that races the create carries null. The Mini's own events have a
    // deterministic id, so check for one before concluding nothing exists.
    // A Grok-created event has a random id we cannot derive; that case still
    // goes to Grok as before.
    const found = await lookupEvent(
      client,
      calendarId,
      calendarEventIdFor(input.meetingId),
      deps.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS,
    );
    if (found === undefined) return { ok: false, skip: "unknown-state" };
    if (found === null) return { ok: false, skip: "missing-event-id" };
    eventId = found.calendarEventId;
  }

  const guard = deadline(timeoutFrom(env, deps));
  try {
    await client.cancelEvent({ calendarId, eventId, signal: guard.signal });
    logger.info({ meeting_id: input.meetingId }, "calendar fast path: event cancelled by the Mini");
    return { ok: true, calendarEventId: eventId, meetLink: null, attendeeCount: 0 };
  } catch (error) {
    const apiError = error instanceof CalendarApiError ? error : null;
    logger.error(
      { meeting_id: input.meetingId, status: apiError?.status, reason: apiError?.reason ?? "thrown" },
      "calendar fast path cancel failed",
    );
    // A DELETE that timed out may or may not have landed; the sweeper retries
    // the Mini (404 then counts as done) rather than paying Grok to guess.
    return { ok: false, skip: apiError?.aborted ? "unknown-state" : "api-error", calendarEventId: eventId };
  } finally {
    guard.clear();
  }
}
