import { createHash } from "node:crypto";
import { logger } from "../logger.ts";

/**
 * Google Calendar v3 REST client.
 *
 * Runs on this box as `hello@techatnyu.org` (domain-wide delegation), creates or updates
 * the Eboard event and attaches a Google Meet conference. No `googleapis` dependency;
 * plain `fetch` against the REST endpoints.
 *
 * Privacy invariant: attendee email addresses never reach a log line or an error message.
 * Logs carry counts; errors carry HTTP status and Google's message with any address-shaped
 * substring redacted. Access tokens never leave the Authorization header.
 *
 * Idempotency invariant: every event this module creates carries a Google event id derived
 * from the meeting id (`calendarEventIdFor`). A retried POST, a concurrent sweep, or a later
 * re-sync therefore lands on the SAME event (Google answers 409, which we turn into a PATCH)
 * instead of minting a second one and mailing the whole guest list twice.
 */

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/calendars";

export interface CalendarEventInput {
  calendarId: string;
  /**
   * Stable meeting identity. The Google event id is derived from it, so the create is
   * idempotent across retries, fallbacks, and concurrent dispatchers.
   */
  meetingId: string;
  title: string;
  /** ISO-8601 instant. */
  startsAt: string;
  endsAt: string;
  timeZone: string;
  description: string | null;
  /** Free text: a room, a Zoom URL, an address. Shown on the invite. */
  location: string | null;
  attendeeEmails: string[];
  requestMeet: boolean;
  /** Present => update that event in place; absent/null => create (with the derived id). */
  eventId?: string | null;
  /** Aborts the in-flight fetch and any backoff sleep. */
  signal?: AbortSignal;
}

export interface CalendarEventResult {
  calendarEventId: string;
  meetLink: string | null;
  htmlLink: string | null;
}

export interface CalendarClient {
  upsertEvent(input: CalendarEventInput): Promise<CalendarEventResult>;
  /** `null` when the event does not exist or is cancelled. */
  getEvent(input: { calendarId: string; eventId: string; signal?: AbortSignal }): Promise<CalendarEventResult | null>;
  cancelEvent(input: { calendarId: string; eventId: string; signal?: AbortSignal }): Promise<void>;
}

/** Minimal structural shape of the token source; the concrete impl lives in google-auth.ts. */
interface TokenSource {
  getAccessToken(): Promise<string>;
}

/**
 * Typed failure so callers branch on fields, never on string matching.
 * `notFound` is true for 404/410: a PATCH that 404s means the event was deleted
 * upstream and the caller may choose to re-create it.
 * `calendarEventId` is set when the event itself exists but the call still failed
 * (e.g. the Meet conference never materialised), so the caller can persist the id
 * rather than create again.
 */
export class CalendarApiError extends Error {
  readonly status: number;
  readonly notFound: boolean;
  readonly retryable: boolean;
  readonly aborted: boolean;
  readonly calendarEventId: string | null;
  readonly reason: "http" | "aborted" | "no-event-id" | "meet-pending" | "meet-failed";

  constructor(
    message: string,
    opts: {
      status: number;
      retryable?: boolean;
      aborted?: boolean;
      calendarEventId?: string | null;
      reason?: CalendarApiError["reason"];
    },
  ) {
    super(message);
    this.name = "CalendarApiError";
    this.status = opts.status;
    this.notFound = opts.status === 404 || opts.status === 410;
    this.retryable = opts.retryable ?? isRetryableStatus(opts.status);
    this.aborted = opts.aborted ?? false;
    this.calendarEventId = opts.calendarEventId ?? null;
    this.reason = opts.reason ?? (this.aborted ? "aborted" : "http");
  }
}

function isRetryableStatus(status: number): boolean {
  // 429 and 5xx only. A 403 means the delegation is not authorized; retrying it burns quota
  // and never succeeds. Every other 4xx is a bad request that will fail identically.
  return status === 429 || (status >= 500 && status <= 599);
}

/** Strips anything address-shaped so attendee (and calendar) emails cannot ride out in an error. */
function redactEmails(text: string): string {
  return text.replace(/[^\s<>()"',;:]+@[^\s<>()"',;:]+/g, "[redacted-email]");
}

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/** RFC 4648 base32hex without padding: exactly the `[0-9a-v]` alphabet Google event ids allow. */
function base32hex(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32HEX[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * Deterministic Google event id for a meeting.
 *
 * Google accepts client-supplied ids on insert as long as they are 5..1024 chars of
 * base32hex (`[0-9a-v]`). Same meeting in, same id out, so a retry after a 5xx, a Grok
 * fallback, or two dispatchers racing all address one event. 20 digest bytes = 32 chars;
 * the `mrph` prefix stays inside the alphabet and marks the id as ours in the Google UI.
 */
export function calendarEventIdFor(meetingId: string): string {
  const digest = createHash("sha256").update(`morpheus-meeting:${meetingId}`).digest();
  return `mrph${base32hex(digest.subarray(0, 20))}`;
}

/**
 * Stable per-event conference request id.
 *
 * Google treats `conferenceData.createRequest.requestId` as an idempotency key: a retry that
 * carries a *fresh* id mints a second conference on the same event. So the id is derived, not
 * random: same event identity in, same id out. Keyed on the event id (itself derived from the
 * meeting id), so two meetings with the same title and slot never share a key.
 */
export function conferenceRequestId(input: Pick<CalendarEventInput, "calendarId" | "meetingId" | "eventId">): string {
  const eventId = input.eventId || calendarEventIdFor(input.meetingId);
  const identity = JSON.stringify(["event", input.calendarId, eventId]);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `morpheus-${digest}`;
}

interface EventRequestBody {
  id?: string;
  status?: "confirmed";
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees: Array<{ email: string }>;
  conferenceData?: {
    createRequest: {
      requestId: string;
      conferenceSolutionKey: { type: "hangoutsMeet" };
    };
  };
}

interface PreparedRequest {
  createUrl: string;
  updateUrl: string;
  eventId: string;
  method: "POST" | "PATCH";
  body: EventRequestBody;
}

/**
 * Builds the URL and the body together, in one place, on purpose.
 *
 * `conferenceData.createRequest` without `?conferenceDataVersion=1` is silently discarded by
 * Google: 200 OK, event created, no Meet link, no error anywhere. Coupling the query string to
 * the body here (rather than trusting two call sites to stay in sync) makes that failure
 * unreachable: nothing else in this module builds an event URL.
 */
function prepareEventRequest(input: CalendarEventInput): PreparedRequest {
  const eventId = input.eventId || calendarEventIdFor(input.meetingId);
  const body: EventRequestBody = {
    summary: input.title,
    start: { dateTime: input.startsAt, timeZone: input.timeZone },
    end: { dateTime: input.endsAt, timeZone: input.timeZone },
    attendees: input.attendeeEmails.map((email) => ({ email })),
  };
  if (input.description !== null) body.description = input.description;
  if (input.location !== null) body.location = input.location;

  // A `createRequest` is only ever sent on a CREATE. Verified against the live
  // API: sending one on a PATCH of an event that already has a conference makes
  // Google mint a *second* Meet and swap the event over to it, so everyone
  // holding the original link is silently sent to a dead room after a title or
  // time edit. The stable `requestId` does not prevent this -- its idempotency
  // covers retries of the original create, not a create against an existing
  // conference. Omitting the field on update preserves whatever conference the
  // event already has.
  //
  // Consequence worth knowing: an update cannot *add* a Meet to an event that
  // never had one. Every event this module creates requests a conference up
  // front, so that case does not arise here.
  if (!input.eventId) {
    body.id = eventId;
    if (input.requestMeet) {
      body.conferenceData = {
        createRequest: {
          requestId: conferenceRequestId(input),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }
  }

  // conferenceDataVersion=1 is set unconditionally, right here alongside the body that needs it.
  // On a Meet request it is load-bearing; on a plain event it tells Google we speak conferenceData,
  // so an update does not strip a conference someone attached by hand.
  const params = new URLSearchParams({ sendUpdates: "all", conferenceDataVersion: "1" });

  // calendarId is an email address; the `@` and any `+` must be percent-encoded in the path.
  const base = `${CALENDAR_API_BASE}/${encodeURIComponent(input.calendarId)}/events`;
  return {
    createUrl: `${base}?${params.toString()}`,
    updateUrl: `${base}/${encodeURIComponent(eventId)}?${params.toString()}`,
    eventId,
    method: input.eventId ? "PATCH" : "POST",
    body,
  };
}

function eventUrl(calendarId: string, eventId: string, params?: URLSearchParams): string {
  const base = `${CALENDAR_API_BASE}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  return params ? `${base}?${params.toString()}` : base;
}

interface GoogleEventResponse {
  id?: string;
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
    createRequest?: { status?: { statusCode?: string } };
  };
}

/**
 * Meet URL lives in `conferenceData.entryPoints[]` with `entryPointType === "video"`;
 * older/simpler responses only carry the top-level `hangoutLink`.
 */
export function extractMeetLink(payload: GoogleEventResponse | null): string | null {
  const entry = payload?.conferenceData?.entryPoints?.find(
    (point) => point.entryPointType === "video" && typeof point.uri === "string" && point.uri.length > 0,
  );
  if (entry?.uri) return entry.uri;
  if (typeof payload?.hangoutLink === "string" && payload.hangoutLink.length > 0) return payload.hangoutLink;
  return null;
}

/** `pending` while Google is still provisioning the conference asynchronously; `failure` is terminal. */
function conferenceStatus(payload: GoogleEventResponse | null): "pending" | "failure" | "success" | null {
  const code = payload?.conferenceData?.createRequest?.status?.statusCode;
  if (code === "pending" || code === "failure" || code === "success") return code;
  return null;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_DELAY_MS);
}

const MAX_RETRY_DELAY_MS = 10_000;

async function readErrorMessage(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return response.statusText || "calendar request failed";
  }
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.length > 0) return redactEmails(message);
  } catch {
    // Non-JSON error body (HTML error page, empty). Fall through.
  }
  return response.statusText || "calendar request failed";
}

async function readJson(response: Response): Promise<GoogleEventResponse | null> {
  try {
    return (await response.json()) as GoogleEventResponse;
  } catch {
    return null;
  }
}

function abortError(op: string): CalendarApiError {
  return new CalendarApiError(`calendar ${op} aborted`, { status: 0, retryable: false, aborted: true });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Resolves with `promise`, or rejects as aborted the moment `signal` fires. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, op: string): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(op));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(op));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export interface CalendarClientDeps {
  tokenSource: TokenSource;
  fetchImpl?: typeof fetch;
  /** Test seam. Defaults to real timers; backoff never sleeps in tests. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Total attempts per request, including the first. Bounded small on purpose. */
  maxAttempts?: number;
  /** First backoff step; doubles per attempt. */
  baseDelayMs?: number;
  /** Extra GETs to wait for an async Meet conference after a create. */
  meetPollAttempts?: number;
  meetPollDelayMs?: number;
}

export function createGoogleCalendarClient(deps: CalendarClientDeps): CalendarClient {
  const doFetch = deps.fetchImpl ?? fetch;
  const rawSleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = Math.max(1, Math.min(deps.maxAttempts ?? 3, 5));
  const baseDelayMs = deps.baseDelayMs ?? 250;
  const meetPollAttempts = Math.max(0, Math.min(deps.meetPollAttempts ?? 3, 10));
  const meetPollDelayMs = deps.meetPollDelayMs ?? 500;

  /** A sleep that ends early when the signal fires, so a deadline never waits out a backoff. */
  function sleep(ms: number, signal: AbortSignal | undefined, op: string): Promise<void> {
    if (!signal) return rawSleep(ms);
    if (signal.aborted) return Promise.reject(abortError(op));
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(abortError(op));
      signal.addEventListener("abort", onAbort, { once: true });
      rawSleep(ms).then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  /**
   * One request with bounded retry on transient failures only.
   * Returns the raw Response on success; throws CalendarApiError otherwise.
   * `okStatuses` lets cancel treat 404/410 as the desired end state.
   */
  async function request(
    op: string,
    init: { url: string; method: string; body?: unknown; signal?: AbortSignal },
    okStatuses: (status: number) => boolean,
  ): Promise<Response> {
    let lastError: CalendarApiError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (init.signal?.aborted) throw abortError(op);
      // Token is fetched per call; the token source owns caching and refresh.
      // The exchange is raced against the signal too: a hung OAuth POST must
      // not outlive the deadline any more than a hung Calendar call.
      const token = await withAbort(deps.tokenSource.getAccessToken(), init.signal, op);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      if (init.body !== undefined) headers["Content-Type"] = "application/json";

      let response: Response;
      try {
        response = await doFetch(init.url, {
          method: init.method,
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          ...(init.signal ? { signal: init.signal } : {}),
        });
      } catch (error) {
        if (isAbort(error) || init.signal?.aborted) throw abortError(op);
        throw error;
      }

      if (response.ok || okStatuses(response.status)) return response;

      const message = await readErrorMessage(response);
      const error = new CalendarApiError(`calendar ${op} failed (${response.status}): ${message}`, {
        status: response.status,
      });
      if (!error.retryable || attempt === maxAttempts) throw error;

      lastError = error;
      const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
      const delay = retryAfter ?? Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
      logger.warn({ op, status: response.status, attempt, maxAttempts, delayMs: delay }, "calendar.request.retry");
      await sleep(delay, init.signal, op);
    }

    /* c8 ignore next */
    throw lastError ?? new CalendarApiError(`calendar ${op} failed`, { status: 0, retryable: false });
  }

  async function fetchEvent(
    calendarId: string,
    eventId: string,
    signal: AbortSignal | undefined,
  ): Promise<GoogleEventResponse | null> {
    const response = await request(
      "get",
      { url: eventUrl(calendarId, eventId), method: "GET", ...(signal ? { signal } : {}) },
      (status) => status === 404 || status === 410,
    );
    if (response.status === 404 || response.status === 410) return null;
    return readJson(response);
  }

  function toResult(payload: GoogleEventResponse | null, fallbackId: string): CalendarEventResult {
    return {
      calendarEventId: payload?.id ?? fallbackId,
      meetLink: extractMeetLink(payload),
      htmlLink: typeof payload?.htmlLink === "string" ? payload.htmlLink : null,
    };
  }

  return {
    async upsertEvent(input: CalendarEventInput): Promise<CalendarEventResult> {
      const prepared = prepareEventRequest(input);
      const signal = input.signal;
      let op = prepared.method === "PATCH" ? "update" : "create";

      let response: Response;
      if (prepared.method === "POST") {
        // 409 = "the requested identifier already belongs to another event": an earlier
        // attempt (ours, a concurrent sweep, or a retried 5xx that had in fact committed)
        // already created it. Converge on that event rather than erroring or re-creating.
        response = await request(
          op,
          { url: prepared.createUrl, method: "POST", body: prepared.body, ...(signal ? { signal } : {}) },
          (status) => status === 409,
        );
        if (response.status === 409) {
          op = "update";
          logger.info({ op: "create" }, "calendar.event.exists; converging via update");
          const { id: _id, conferenceData: _conf, ...patchBody } = prepared.body;
          // The earlier POST already mailed everyone; this PATCH only converges
          // state, so it must not send a second invite (`sendUpdates=none`).
          // `confirmed` revives the row if the earlier copy was deleted; harmless otherwise.
          response = await request(
            op,
            {
              url: eventUrl(
                input.calendarId,
                prepared.eventId,
                new URLSearchParams({ sendUpdates: "none", conferenceDataVersion: "1" }),
              ),
              method: "PATCH",
              body: { ...patchBody, status: "confirmed" },
              ...(signal ? { signal } : {}),
            },
            () => false,
          );
        }
      } else {
        response = await request(
          op,
          { url: prepared.updateUrl, method: "PATCH", body: prepared.body, ...(signal ? { signal } : {}) },
          () => false,
        );
      }

      let payload = await readJson(response);
      const calendarEventId = payload?.id ?? prepared.eventId;
      if (!calendarEventId) {
        throw new CalendarApiError("calendar response carried no event id", {
          status: response.status,
          retryable: false,
          reason: "no-event-id",
        });
      }

      let meetLink = extractMeetLink(payload);
      // Google can answer 200 with the conference still provisioning
      // (`createRequest.status.statusCode === "pending"`): event id present, no video entry
      // yet. A short bounded poll usually sees it land; if it does not, the caller must not
      // treat the sync as finished, so surface the id on a typed error instead of returning
      // a half-result that reads as success.
      if (input.requestMeet && meetLink === null) {
        let status = conferenceStatus(payload);
        for (let poll = 0; poll < meetPollAttempts && meetLink === null && status !== "failure"; poll += 1) {
          await sleep(meetPollDelayMs, signal, op);
          payload = await fetchEvent(input.calendarId, calendarEventId, signal);
          meetLink = extractMeetLink(payload);
          status = conferenceStatus(payload);
        }
        if (meetLink === null) {
          const failed = status === "failure";
          logger.warn({ op, conferenceStatus: status ?? "absent" }, "calendar.event.meet_missing");
          throw new CalendarApiError(
            failed ? "calendar conference creation failed" : "calendar conference not ready",
            {
              status: response.status,
              retryable: false,
              calendarEventId,
              reason: failed ? "meet-failed" : "meet-pending",
            },
          );
        }
      }

      logger.info(
        {
          op,
          attendeeCount: input.attendeeEmails.length,
          requestedMeet: input.requestMeet,
          gotMeet: meetLink !== null,
        },
        "calendar.event.upserted",
      );

      return {
        calendarEventId,
        meetLink,
        htmlLink: typeof payload?.htmlLink === "string" ? payload.htmlLink : null,
      };
    },

    async getEvent(input): Promise<CalendarEventResult | null> {
      const payload = await fetchEvent(input.calendarId, input.eventId, input.signal);
      if (!payload || payload.status === "cancelled") return null;
      return toResult(payload, input.eventId);
    },

    async cancelEvent(input): Promise<void> {
      const url = eventUrl(input.calendarId, input.eventId, new URLSearchParams({ sendUpdates: "all" }));

      // 404/410 mean the event is already gone, which is exactly the state we are asking for.
      await request(
        "cancel",
        { url, method: "DELETE", ...(input.signal ? { signal: input.signal } : {}) },
        (status) => status === 404 || status === 410,
      );
      logger.info({ op: "cancel" }, "calendar.event.cancelled");
    },
  };
}
