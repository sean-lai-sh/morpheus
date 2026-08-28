import { describe, expect, test } from "bun:test";
import {
  CalendarApiError,
  createGoogleCalendarClient,
  type CalendarEventInput,
} from "../src/coordinator/calendar-client.ts";

const TOKEN = "ya29.fake-access-token-must-never-appear-anywhere";
const CALENDAR_ID = "hello@techatnyu.org";
const ATTENDEE = "someone.private@nyu.edu";

const tokenSource = { getAccessToken: async () => TOKEN };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

function recorder(responses: Array<() => Response>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: any, init: any) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k] = v;
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const make = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return make!();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const slept: number[] = [];
function client(responses: Array<() => Response>) {
  const { calls, fetchImpl } = recorder(responses);
  const api = createGoogleCalendarClient({
    tokenSource,
    fetchImpl,
    sleepImpl: async (ms) => {
      slept.push(ms);
    },
    baseDelayMs: 1,
  });
  return { calls, api };
}

function baseInput(overrides: Partial<CalendarEventInput> = {}): CalendarEventInput {
  return {
    calendarId: CALENDAR_ID,
    title: "Eboard Sync",
    startsAt: "2026-09-01T18:00:00.000Z",
    endsAt: "2026-09-01T19:00:00.000Z",
    timeZone: "America/New_York",
    description: "Weekly sync",
    attendeeEmails: [ATTENDEE],
    requestMeet: true,
    ...overrides,
  };
}

const createdEvent = {
  id: "evt_123",
  htmlLink: "https://calendar.google.com/event?eid=evt_123",
  conferenceData: {
    entryPoints: [
      { entryPointType: "more", uri: "https://tel.meet/abc" },
      { entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" },
    ],
  },
};

describe("create request shape", () => {
  test("POSTs to the events endpoint with the calendarId percent-encoded and conferenceDataVersion=1", async () => {
    const { calls, api } = client([() => jsonResponse(createdEvent)]);
    await api.upsertEvent(baseInput());

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toContain("https://www.googleapis.com/calendar/v3/calendars/hello%40techatnyu.org/events");
    expect(call.url).not.toContain("hello@techatnyu.org");

    const url = new URL(call.url);
    expect(url.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(url.searchParams.get("sendUpdates")).toBe("all");
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("carries a hangoutsMeet createRequest when requestMeet is true, and no conferenceData when false", async () => {
    const withMeet = client([() => jsonResponse(createdEvent)]);
    await withMeet.api.upsertEvent(baseInput({ requestMeet: true }));
    const meetBody = withMeet.calls[0]!.body;
    expect(meetBody.conferenceData.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
    expect(typeof meetBody.conferenceData.createRequest.requestId).toBe("string");
    expect(meetBody.conferenceData.createRequest.requestId.length).toBeGreaterThan(8);

    const noMeet = client([() => jsonResponse({ id: "evt_plain" })]);
    await noMeet.api.upsertEvent(baseInput({ requestMeet: false }));
    expect(noMeet.calls[0]!.body.conferenceData).toBeUndefined();
    // The version flag still rides along so an update never strips an existing conference.
    expect(new URL(noMeet.calls[0]!.url).searchParams.get("conferenceDataVersion")).toBe("1");
  });

  test("times are {dateTime,timeZone} and attendees serialize as [{email}] with sendUpdates=all", async () => {
    const { calls, api } = client([() => jsonResponse(createdEvent)]);
    await api.upsertEvent(baseInput({ attendeeEmails: [ATTENDEE, "second@nyu.edu"] }));

    const body = calls[0]!.body;
    expect(body.start).toEqual({ dateTime: "2026-09-01T18:00:00.000Z", timeZone: "America/New_York" });
    expect(body.end).toEqual({ dateTime: "2026-09-01T19:00:00.000Z", timeZone: "America/New_York" });
    expect(body.attendees).toEqual([{ email: ATTENDEE }, { email: "second@nyu.edu" }]);
    expect(body.summary).toBe("Eboard Sync");
    expect(body.description).toBe("Weekly sync");
    expect(new URL(calls[0]!.url).searchParams.get("sendUpdates")).toBe("all");
  });
});

describe("requestId stability", () => {
  test("is stable across two calls for the same event and differs for a different one", async () => {
    const first = client([() => jsonResponse(createdEvent)]);
    await first.api.upsertEvent(baseInput());
    const second = client([() => jsonResponse(createdEvent)]);
    await second.api.upsertEvent(baseInput());

    const idA = first.calls[0]!.body.conferenceData.createRequest.requestId;
    const idB = second.calls[0]!.body.conferenceData.createRequest.requestId;
    expect(idA).toBe(idB);

    const other = client([() => jsonResponse(createdEvent)]);
    await other.api.upsertEvent(baseInput({ startsAt: "2026-09-08T18:00:00.000Z", title: "Different Meeting" }));
    expect(other.calls[0]!.body.conferenceData.createRequest.requestId).not.toBe(idA);

  });

  test("an update sends no createRequest at all, so the existing Meet link survives", async () => {
    // Regression, caught against the live API: a PATCH carrying a createRequest
    // makes Google mint a SECOND conference and swap the event onto it, so
    // everyone holding the original link lands in a dead room after a rename.
    const patch = client([() => jsonResponse(createdEvent)]);
    await patch.api.upsertEvent(baseInput({ eventId: "evt_123", title: "Renamed Meeting" }));

    expect(patch.calls[0]!.method).toBe("PATCH");
    expect(patch.calls[0]!.body.conferenceData).toBeUndefined();
    // Still declared, so the update does not strip the conference either.
    expect(patch.calls[0]!.url).toContain("conferenceDataVersion=1");
  });
});

describe("meet link extraction", () => {
  test("prefers the video entryPoint", async () => {
    const { api } = client([() => jsonResponse(createdEvent)]);
    const result = await api.upsertEvent(baseInput());
    expect(result.meetLink).toBe("https://meet.google.com/abc-defg-hij");
    expect(result.calendarEventId).toBe("evt_123");
    expect(result.htmlLink).toBe("https://calendar.google.com/event?eid=evt_123");
  });

  test("falls back to hangoutLink", async () => {
    const { api } = client([
      () =>
        jsonResponse({
          id: "evt_h",
          hangoutLink: "https://meet.google.com/fallback-link",
          conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1" }] },
        }),
    ]);
    const result = await api.upsertEvent(baseInput());
    expect(result.meetLink).toBe("https://meet.google.com/fallback-link");
  });

  test("returns null without throwing when neither is present", async () => {
    const { api } = client([() => jsonResponse({ id: "evt_none" })]);
    const result = await api.upsertEvent(baseInput());
    expect(result.meetLink).toBeNull();
    expect(result.htmlLink).toBeNull();
    expect(result.calendarEventId).toBe("evt_none");
  });
});

describe("create vs update routing", () => {
  test("eventId present PATCHes .../events/{id}; absent POSTs to .../events", async () => {
    const patch = client([() => jsonResponse({ ...createdEvent, id: "evt_existing" })]);
    await patch.api.upsertEvent(baseInput({ eventId: "evt_existing" }));
    expect(patch.calls[0]!.method).toBe("PATCH");
    expect(new URL(patch.calls[0]!.url).pathname).toBe(
      "/calendar/v3/calendars/hello%40techatnyu.org/events/evt_existing",
    );

    const post = client([() => jsonResponse(createdEvent)]);
    await post.api.upsertEvent(baseInput({ eventId: null }));
    expect(post.calls[0]!.method).toBe("POST");
    expect(new URL(post.calls[0]!.url).pathname).toBe("/calendar/v3/calendars/hello%40techatnyu.org/events");
  });

  test("a 404 on PATCH surfaces as a typed notFound error, without retrying", async () => {
    const { calls, api } = client([() => jsonResponse({ error: { message: "Not Found" } }, 404)]);
    let caught: unknown;
    try {
      await api.upsertEvent(baseInput({ eventId: "evt_gone" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CalendarApiError);
    expect((caught as CalendarApiError).status).toBe(404);
    expect((caught as CalendarApiError).notFound).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("cancel", () => {
  test("204 succeeds and hits DELETE with sendUpdates=all", async () => {
    const { calls, api } = client([() => new Response(null, { status: 204 })]);
    await api.cancelEvent({ calendarId: CALENDAR_ID, eventId: "evt_123" });
    expect(calls[0]!.method).toBe("DELETE");
    expect(new URL(calls[0]!.url).pathname).toBe("/calendar/v3/calendars/hello%40techatnyu.org/events/evt_123");
    expect(new URL(calls[0]!.url).searchParams.get("sendUpdates")).toBe("all");
  });

  test("404 and 410 also succeed — the event is already gone", async () => {
    const gone404 = client([() => jsonResponse({ error: { message: "Not Found" } }, 404)]);
    await gone404.api.cancelEvent({ calendarId: CALENDAR_ID, eventId: "evt_404" });
    expect(gone404.calls).toHaveLength(1);

    const gone410 = client([() => jsonResponse({ error: { message: "Resource has been deleted" } }, 410)]);
    await gone410.api.cancelEvent({ calendarId: CALENDAR_ID, eventId: "evt_410" });
    expect(gone410.calls).toHaveLength(1);
  });

  test("500 throws after bounded retries", async () => {
    const { calls, api } = client([() => jsonResponse({ error: { message: "Backend error" } }, 500)]);
    let caught: unknown;
    try {
      await api.cancelEvent({ calendarId: CALENDAR_ID, eventId: "evt_boom" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CalendarApiError);
    expect((caught as CalendarApiError).status).toBe(500);
    expect(calls).toHaveLength(3);
  });
});

describe("retry policy", () => {
  test("retries 429 then 503 and then succeeds", async () => {
    const { calls, api } = client([
      () => jsonResponse({ error: { message: "Rate Limit Exceeded" } }, 429),
      () => jsonResponse({ error: { message: "Backend Error" } }, 503),
      () => jsonResponse(createdEvent),
    ]);
    const result = await api.upsertEvent(baseInput());
    expect(calls).toHaveLength(3);
    expect(result.calendarEventId).toBe("evt_123");
  });

  test("does not retry 403", async () => {
    const { calls, api } = client([
      () => jsonResponse({ error: { message: "Delegation denied" } }, 403),
      () => jsonResponse(createdEvent),
    ]);
    await expect(api.upsertEvent(baseInput())).rejects.toBeInstanceOf(CalendarApiError);
    expect(calls).toHaveLength(1);
  });

  test("honors Retry-After", async () => {
    slept.length = 0;
    const { api } = client([
      () => jsonResponse({ error: { message: "Rate Limit Exceeded" } }, 429, { "Retry-After": "2" }),
      () => jsonResponse(createdEvent),
    ]);
    await api.upsertEvent(baseInput());
    expect(slept).toEqual([2000]);
  });
});

describe("secret hygiene", () => {
  test("a thrown CalendarApiError carries neither the bearer token nor any attendee email", async () => {
    const { api } = client([
      () =>
        jsonResponse(
          { error: { message: `Invalid attendee ${ATTENDEE} for calendar ${CALENDAR_ID} (token ok)` } },
          400,
        ),
    ]);

    let caught: CalendarApiError | null = null;
    try {
      await api.upsertEvent(baseInput());
    } catch (err) {
      caught = err as CalendarApiError;
    }

    expect(caught).toBeInstanceOf(CalendarApiError);
    const surfaces = [caught!.message, String(caught), caught!.stack ?? "", JSON.stringify(caught, Object.keys(caught!).concat(["message", "stack"]))].join("\n");
    expect(surfaces).not.toContain(TOKEN);
    expect(surfaces).not.toContain("ya29.");
    expect(surfaces).not.toContain(ATTENDEE);
    expect(surfaces).not.toContain("someone.private");
    expect(surfaces).not.toContain(CALENDAR_ID);
    // Status and Google's (redacted) message still make it through for the caller.
    expect(caught!.status).toBe(400);
    expect(caught!.message).toContain("Invalid attendee");
    expect(caught!.message).toContain("[redacted-email]");
  });
});
