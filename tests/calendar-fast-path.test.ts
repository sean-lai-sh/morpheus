import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { publishOutboxEvent, type CalendarFastPath as CalendarFastPathFn } from "../src/coordinator/publisher.ts";
import { coordinatorJobMessageId } from "../src/coordinator/calendar-job.ts";
import {
  tryMiniCalendarCancel,
  tryMiniCalendarSync,
  type FastPathOutcome,
} from "../src/coordinator/calendar-fast-path.ts";
import {
  CalendarApiError,
  calendarEventIdFor,
  type CalendarClient,
  type CalendarEventInput,
  type CalendarEventResult,
} from "../src/coordinator/calendar-client.ts";
import {
  cancelMeeting,
  createScheduledMeeting,
  getMeeting,
} from "../src/storage/coordinator-meetings.ts";
import { applyRosterSeedResult, listAllRosterBindings } from "../src/storage/roster-map.ts";
import { getDb } from "../src/storage/db.ts";
import { getJobByDiscordMessageId } from "../src/storage/jobs.ts";
import { getOutboxEvent } from "../src/storage/outbox.ts";
import { withTempDb } from "./helpers.ts";
import { SPONSORS, withWorkspaceConfig } from "./jobs-fixture.ts";

const db = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;

beforeAll(() => {
  cfg = withWorkspaceConfig();
  getDb();
  applyRosterSeedResult({
    mappings: [
      { discord_id: "100000000000000001", email: "ada@nyu.edu", name: "Ada", disc: "ada", confidence: "disc" },
      { discord_id: "100000000000000002", email: "grace@nyu.edu", name: "Grace", disc: "grace", confidence: "disc" },
    ],
  });
});
afterAll(() => {
  cfg.cleanup();
  db.cleanup();
});

/** Records what the Mini would have sent to Google. */
function recordingClient(over: Partial<CalendarClient> = {}) {
  const upserts: CalendarEventInput[] = [];
  const cancels: Array<{ calendarId: string; eventId: string }> = [];
  const lookups: Array<{ calendarId: string; eventId: string }> = [];
  const client: CalendarClient = {
    async upsertEvent(input) {
      upserts.push(input);
      return {
        calendarEventId: "evt-123",
        meetLink: "https://meet.google.com/abc-defg-hij",
        htmlLink: null,
      };
    },
    async getEvent(input) {
      lookups.push({ calendarId: input.calendarId, eventId: input.eventId });
      return null;
    },
    async cancelEvent(input) {
      cancels.push({ calendarId: input.calendarId, eventId: input.eventId });
    },
    ...over,
  };
  return { client, upserts, cancels, lookups };
}

const FOUND: CalendarEventResult = {
  calendarEventId: calendarEventIdFor("m-1"),
  meetLink: "https://meet.google.com/found-link",
  htmlLink: null,
};

const SYNC_INPUT = {
  meetingId: "m-1",
  title: "Eboard sync",
  startsAt: "2026-09-01T18:00:00.000Z",
  endsAt: "2026-09-01T18:30:00.000Z",
  timeZone: "America/New_York",
  notes: null,
  location: null,
  calendarEventId: null,
};

describe("tryMiniCalendarSync resolves attendees locally", () => {
  test("picked audience invites the bound participants and returns the Meet link", async () => {
    const { client, upserts } = recordingClient();
    const out = await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "picked", participantIds: ["100000000000000001"] },
      { client, calendarId: "hello@techatnyu.org", env: {} },
    );

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.calendarEventId).toBe("evt-123");
    expect(out.meetLink).toBe("https://meet.google.com/abc-defg-hij");
    expect(out.attendeeCount).toBe(1);

    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.attendeeEmails).toEqual(["ada@nyu.edu"]);
    expect(upserts[0]!.requestMeet).toBe(true);
    expect(upserts[0]!.calendarId).toBe("hello@techatnyu.org");
  });

  test("f26_roster invites every seeded binding without a round trip to Grok", async () => {
    const { client, upserts } = recordingClient();
    const out = await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "f26_roster", participantIds: [] },
      { client, env: {} },
    );
    expect(out.ok).toBe(true);
    // Every binding, not a hand-picked subset: the migrate-time
    // MANUAL_ROSTER_BINDINGS rows are part of the roster too, so assert against
    // the table rather than a literal list.
    const expected = listAllRosterBindings().map((row) => row.email.toLowerCase());
    expect(upserts[0]!.attendeeEmails).toEqual(expected);
    expect(upserts[0]!.attendeeEmails).toContain("ada@nyu.edu");
    expect(upserts[0]!.attendeeEmails).toContain("grace@nyu.edu");
  });

  test("f26_roster with one unbound extra still invites the roster and reports the extra", async () => {
    // Grok has no roster map either, so aborting the whole insert over one
    // unmapped snowflake would just fail slower. Invite everyone we can name.
    const { client, upserts } = recordingClient();
    const out = await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "f26_roster", participantIds: ["100000000000000001", "100000000000000009"] },
      { client, env: {} },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.unresolvedCount).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.attendeeEmails).toContain("ada@nyu.edu");
    expect(upserts[0]!.attendeeEmails).toContain("grace@nyu.edu");
  });

  test("the upsert carries the meeting id and an abort signal", async () => {
    const { client, upserts } = recordingClient();
    await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "picked", participantIds: ["100000000000000001"] },
      { client, env: {} },
    );
    expect(upserts[0]!.meetingId).toBe("m-1");
    expect(upserts[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("an existing calendarEventId updates in place rather than creating a second event", async () => {
    const { client, upserts } = recordingClient();
    await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "picked", participantIds: ["100000000000000001"], calendarEventId: "evt-prev" },
      { client, env: {} },
    );
    expect(upserts[0]!.eventId).toBe("evt-prev");
  });
});

describe("tryMiniCalendarSync skips rather than sending a partial invite", () => {
  test("an unbound participant skips to Grok and books nothing", async () => {
    const { client, upserts } = recordingClient();
    const out = await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "picked", participantIds: ["100000000000000001", "100000000000000009"] },
      { client, env: {} },
    );
    expect(out).toEqual({ ok: false, skip: "unresolved-participants" });
    // The critical assertion: no event was created with a silently short guest list.
    expect(upserts).toHaveLength(0);
  });

  test("no credentials configured is a skip, not a crash", async () => {
    const out = await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "picked", participantIds: ["100000000000000001"] },
      { client: null, env: {} },
    );
    expect(out).toEqual({ ok: false, skip: "not-configured" });
  });

  test("MINI_CALENDAR_INSERT=false forces the Grok path even with a client", async () => {
    const { client, upserts } = recordingClient();
    const out = await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "picked", participantIds: ["100000000000000001"] },
      { client, env: { MINI_CALENDAR_INSERT: "false" } },
    );
    expect(out).toEqual({ ok: false, skip: "disabled" });
    expect(upserts).toHaveLength(0);
  });

  test("an empty roster skips instead of booking an event with no guests", async () => {
    const { client } = recordingClient();
    const out = await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "picked", participantIds: [] },
      { client, env: {} },
    );
    expect(out).toEqual({ ok: false, skip: "no-attendees" });
  });

  test("a Calendar API failure degrades to Grok only once a lookup proves no event exists", async () => {
    const { client, lookups } = recordingClient({
      async upsertEvent() {
        throw new Error("boom");
      },
    });
    const out = await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "picked", participantIds: ["100000000000000001"] },
      { client, env: {} },
    );
    expect(out).toEqual({ ok: false, skip: "api-error" });
    expect(lookups).toEqual([{ calendarId: "primary", eventId: calendarEventIdFor("m-1") }]);
  });

  test("a failure whose create actually landed is a success, not a Grok duplicate", async () => {
    const { client } = recordingClient({
      async upsertEvent() {
        throw new CalendarApiError("calendar create failed (503)", { status: 503 });
      },
      async getEvent() {
        return FOUND;
      },
    });
    const out = await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "picked", participantIds: ["100000000000000001"] },
      { client, env: {} },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.calendarEventId).toBe(FOUND.calendarEventId);
    expect(out.meetLink).toBe(FOUND.meetLink);
  });

  test("a failure where the lookup itself fails is unknown-state (retry later, never Grok)", async () => {
    const { client } = recordingClient({
      async upsertEvent() {
        throw new Error("boom");
      },
      async getEvent() {
        throw new Error("lookup boom");
      },
    });
    const out = await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "picked", participantIds: ["100000000000000001"] },
      { client, env: {} },
    );
    expect(out).toEqual({ ok: false, skip: "unknown-state" });
  });

  test("an event without its Meet yet is meet-pending and carries the id", async () => {
    const { client } = recordingClient({
      async upsertEvent() {
        throw new CalendarApiError("conference not ready", {
          status: 200,
          retryable: false,
          calendarEventId: "evt-half",
          reason: "meet-pending",
        });
      },
    });
    const out = await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "picked", participantIds: ["100000000000000001"] },
      { client, env: {} },
    );
    expect(out).toEqual({ ok: false, skip: "meet-pending", calendarEventId: "evt-half" });
  });

  test("a never-resolving client is aborted at the deadline, then looked up, within the budget", async () => {
    const { client, lookups } = recordingClient({
      upsertEvent(input) {
        return new Promise((_, reject) => {
          input.signal?.addEventListener("abort", () =>
            reject(new CalendarApiError("aborted", { status: 0, retryable: false, aborted: true })),
          );
        });
      },
    });
    const started = Date.now();
    const out = await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "picked", participantIds: ["100000000000000001"] },
      { client, env: {}, timeoutMs: 30 },
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out).toEqual({ ok: false, skip: "api-error" });
    expect(lookups).toHaveLength(1);
  });
});

describe("tryMiniCalendarCancel", () => {
  test("cancels by event id", async () => {
    const { client, cancels } = recordingClient();
    const out = await tryMiniCalendarCancel(
      { meetingId: "m-1", calendarEventId: "evt-123" },
      { client, calendarId: "hello@techatnyu.org", env: {} },
    );
    expect(out.ok).toBe(true);
    expect(cancels).toEqual([{ calendarId: "hello@techatnyu.org", eventId: "evt-123" }]);
  });

  test("no stored event id: checks the deterministic id, and if absent hands off", async () => {
    const { client, cancels, lookups } = recordingClient();
    const out = await tryMiniCalendarCancel(
      { meetingId: "m-1", calendarEventId: null },
      { client, env: {} },
    );
    expect(out).toEqual({ ok: false, skip: "missing-event-id" });
    expect(lookups).toEqual([{ calendarId: "primary", eventId: calendarEventIdFor("m-1") }]);
    expect(cancels).toHaveLength(0);
  });

  test("no stored event id but the Mini's event exists: it is deleted", async () => {
    const { client, cancels } = recordingClient({
      async getEvent() {
        return FOUND;
      },
    });
    const out = await tryMiniCalendarCancel(
      { meetingId: "m-1", calendarEventId: null },
      { client, env: {} },
    );
    expect(out.ok).toBe(true);
    expect(cancels).toEqual([{ calendarId: "primary", eventId: FOUND.calendarEventId }]);
  });
});

describe("publisher prefers the Mini and falls back to Grok", () => {
  function scheduledMeeting(title: string) {
    return createScheduledMeeting({
      createdByUserId: "creator-fast",
      title,
      startsAt: Date.now() + 3_600_000,
      durationMinutes: 30,
      channelId: SPONSORS,
      participants: [{ userId: "100000000000000001", displayName: "Ada" }],
    });
  }

  test("a successful Mini insert persists the event, marks the outbox, and enqueues NO Grok job", async () => {
    const { meeting, outboxEvents } = scheduledMeeting("Mini fast path");
    const event = outboxEvents[0]!;

    const outcome = await publishOutboxEvent(event, {
      calendarFastPath: async () =>
        ({
          ok: true,
          calendarEventId: "evt-mini",
          meetLink: "https://meet.google.com/mini",
          attendeeCount: 1,
        }) satisfies FastPathOutcome,
      // If the fast path is honored these must never run.
      enqueueCalendar: () => {
        throw new Error("Grok enqueue must not be reached on a successful Mini insert");
      },
      dispatchCalendar: async () => {
        throw new Error("Grok dispatch must not be reached on a successful Mini insert");
      },
    });

    expect(outcome.status).toBe("accepted");
    expect(getOutboxEvent(event.id)?.status).toBe("dispatched");

    const stored = getMeeting(meeting.id);
    expect(stored?.calendarEventId).toBe("evt-mini");
    expect(stored?.meetLink).toBe("https://meet.google.com/mini");

    // No coordinator job row at all — that is the whole point of deterministic.
    expect(getJobByDiscordMessageId(coordinatorJobMessageId(event.id))).toBeNull();
  });

  test("a skipped fast path still hands off to Grok exactly as before", async () => {
    const { outboxEvents } = scheduledMeeting("Grok fallback");
    const event = outboxEvents[0]!;

    const outcome = await publishOutboxEvent(event, {
      calendarFastPath: async () => ({ ok: false, skip: "not-configured" }),
      dispatchCalendar: async () => true,
    });

    expect(outcome.status).toBe("accepted");
    const job = getJobByDiscordMessageId(coordinatorJobMessageId(event.id));
    expect(job).not.toBeNull();
    // `lane` is a column, not a JobRow field -- read it the way the lane suite does.
    const lane = getDb()
      .query<{ lane: string }, [string]>(`SELECT lane FROM jobs WHERE discord_message_id = ?`)
      .get(coordinatorJobMessageId(event.id))?.lane;
    expect(lane).toBe("background");
    // The pack that reaches Grok still carries no addresses.
    expect(job!.content).not.toContain("ada@nyu.edu");
  });

  test("with no fast-path seam the real credential check runs and falls back", async () => {
    const { outboxEvents } = scheduledMeeting("No credentials");
    const event = outboxEvents[0]!;
    const outcome = await publishOutboxEvent(event, { dispatchCalendar: async () => true });
    expect(outcome.status).toBe("accepted");
    expect(getJobByDiscordMessageId(coordinatorJobMessageId(event.id))).not.toBeNull();
  });

  test("meet-pending keeps the outbox pending, stores the id, and never reaches Grok", async () => {
    const { meeting, outboxEvents } = scheduledMeeting("Meet pending");
    const event = outboxEvents[0]!;

    const outcome = await publishOutboxEvent(event, {
      calendarFastPath: async () => ({ ok: false, skip: "meet-pending", calendarEventId: "evt-half" }),
      enqueueCalendar: () => {
        throw new Error("Grok must not be reached while the Mini's event exists");
      },
    });

    expect(outcome.status).toBe("deferred");
    const row = getOutboxEvent(event.id);
    expect(row?.status).toBe("pending");
    // Transient deferrals do not burn dead-letter attempts (see the cap test below).
    expect(row?.attempts).toBe(0);
    expect(getMeeting(meeting.id)?.calendarEventId).toBe("evt-half");
    expect(getMeeting(meeting.id)?.meetLink).toBeNull();
  });

  test("unknown-state also defers rather than handing Grok a possible duplicate", async () => {
    const { outboxEvents } = scheduledMeeting("Unknown state");
    const event = outboxEvents[0]!;
    const outcome = await publishOutboxEvent(event, {
      calendarFastPath: async () => ({ ok: false, skip: "unknown-state" }),
      enqueueCalendar: () => {
        throw new Error("Grok must not be reached in unknown-state");
      },
    });
    expect(outcome.status).toBe("deferred");
    expect(getOutboxEvent(event.id)?.status).toBe("pending");
  });

  test("a meeting cancelled while the insert was in flight gets its event deleted, not orphaned", async () => {
    const { meeting, outboxEvents } = scheduledMeeting("Cancel race");
    const syncEvent = outboxEvents[0]!;
    const calls: string[] = [];

    const outcome = await publishOutboxEvent(syncEvent, {
      calendarFastPath: async (input) => {
        calls.push(`${input.kind}:${input.meeting.calendarEventId ?? "null"}`);
        if (input.kind === "meeting.calendar_sync") {
          // The organizer cancels while Google is still answering the POST.
          cancelMeeting({ meetingId: meeting.id, creatorUserId: "creator-fast" });
          return { ok: true, calendarEventId: "evt-raced", meetLink: "https://meet.google.com/raced", attendeeCount: 1 };
        }
        return { ok: true, calendarEventId: input.meeting.calendarEventId, meetLink: null, attendeeCount: 0 };
      },
      enqueueCalendar: () => {
        throw new Error("Grok must not be reached");
      },
    });

    expect(outcome.status).toBe("accepted");
    // The undo cancel ran with the id the insert just returned.
    expect(calls).toEqual(["meeting.calendar_sync:null", "meeting.calendar_cancel:evt-raced"]);
    expect(getOutboxEvent(syncEvent.id)?.status).toBe("dispatched");
    expect(getMeeting(meeting.id)?.status).toBe("cancelled");
  });

  test("cancel race, undo FAILS: the retry sweep (stale_version) deletes the event before closing the row", async () => {
    const { meeting, outboxEvents } = scheduledMeeting("Cancel race, undo fails");
    const syncEvent = outboxEvents[0]!;
    const cancels: Array<string | null> = [];
    let undoAttempts = 0;

    const fastPath = async (input: Parameters<CalendarFastPathFn>[0]) => {
      if (input.kind === "meeting.calendar_sync") {
        cancelMeeting({ meetingId: meeting.id, creatorUserId: "creator-fast" });
        return { ok: true, calendarEventId: "evt-raced-2", meetLink: "https://meet.google.com/r2", attendeeCount: 1 } as const;
      }
      undoAttempts += 1;
      cancels.push(input.meeting.calendarEventId);
      // First undo: Google 5xx. Second (from the sweep): success.
      if (undoAttempts === 1) return { ok: false, skip: "api-error" } as const;
      return { ok: true, calendarEventId: input.meeting.calendarEventId, meetLink: null, attendeeCount: 0 } as const;
    };
    const noGrok = () => {
      throw new Error("Grok must not be reached");
    };

    const first = await publishOutboxEvent(syncEvent, { calendarFastPath: fastPath, enqueueCalendar: noGrok });
    expect(first.status).toBe("deferred");
    expect(getOutboxEvent(syncEvent.id)?.status).toBe("pending");

    // The sweeper re-reads the row; the meeting version has moved on (cancel).
    const retry = await publishOutboxEvent(getOutboxEvent(syncEvent.id)!, {
      calendarFastPath: fastPath,
      enqueueCalendar: noGrok,
    });
    expect(retry.status).toBe("accepted");
    expect(getOutboxEvent(syncEvent.id)?.status).toBe("dispatched");
    expect(undoAttempts).toBe(2);
    // The second undo went through the cancel path with the meeting's own row
    // (null id there, so the fast path looks up the deterministic id).
    expect(cancels).toEqual(["evt-raced-2", null]);
  });

  test("cancel race, upsert throws and lookup misses: no Grok CREATE on a cancelled meeting", async () => {
    const { meeting, outboxEvents } = scheduledMeeting("Cancel race, Grok create");
    const syncEvent = outboxEvents[0]!;
    const kinds: string[] = [];

    const outcome = await publishOutboxEvent(syncEvent, {
      calendarFastPath: async (input) => {
        kinds.push(input.kind);
        if (input.kind === "meeting.calendar_sync") {
          cancelMeeting({ meetingId: meeting.id, creatorUserId: "creator-fast" });
          // Abort + GET 404: "proven absent" from the fast path's point of view.
          return { ok: false, skip: "api-error" };
        }
        return { ok: false, skip: "missing-event-id" };
      },
      enqueueCalendar: () => {
        throw new Error("Grok must not be handed a create for a cancelled meeting");
      },
    });

    expect(outcome.status).toBe("accepted");
    expect(getOutboxEvent(syncEvent.id)?.status).toBe("dispatched");
    expect(kinds).toEqual(["meeting.calendar_sync", "meeting.calendar_cancel"]);
    expect(getJobByDiscordMessageId(coordinatorJobMessageId(syncEvent.id))).toBeNull();
  });

  test("meet-pending / unknown-state do not count toward the dead-letter cap; meet-failed does", async () => {
    const pending = scheduledMeeting("Deferral cap");
    const event = pending.outboxEvents[0]!;
    for (let i = 0; i < 10; i += 1) {
      await publishOutboxEvent(event, {
        calendarFastPath: async () => ({ ok: false, skip: i % 2 ? "meet-pending" : "unknown-state" }),
      });
    }
    expect(getOutboxEvent(event.id)?.status).toBe("pending");
    expect(getOutboxEvent(event.id)?.attempts).toBe(0);

    const failed = scheduledMeeting("Meet failed");
    const failedEvent = failed.outboxEvents[0]!;
    await publishOutboxEvent(failedEvent, {
      calendarFastPath: async () => ({ ok: false, skip: "meet-failed", calendarEventId: "evt-nomeet" }),
    });
    expect(getOutboxEvent(failedEvent.id)?.attempts).toBe(1);
    expect(getMeeting(failed.meeting.id)?.calendarEventId).toBe("evt-nomeet");
  });

  test("two dispatchers on the same row: the second is deferred while the first is in flight", async () => {
    const { outboxEvents } = scheduledMeeting("Lease");
    const event = outboxEvents[0]!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fastPathCalls = 0;
    const fastPath = async () => {
      fastPathCalls += 1;
      await gate;
      return { ok: true, calendarEventId: "evt-once", meetLink: "https://meet.google.com/once", attendeeCount: 1 } as const;
    };

    const first = publishOutboxEvent(event, { calendarFastPath: fastPath });
    const second = await publishOutboxEvent(event, { calendarFastPath: fastPath });
    expect(second.status).toBe("deferred");
    release();
    expect((await first).status).toBe("accepted");
    expect(fastPathCalls).toBe(1);
  });

  test("a cancel handled by the Mini does not enqueue a Grok cancel job", async () => {
    const { meeting } = scheduledMeeting("Mini cancel");
    const cancelled = cancelMeeting({ meetingId: meeting.id, creatorUserId: "creator-fast" });
    const event = cancelled.outboxEvents[0]!;

    const outcome = await publishOutboxEvent(event, {
      calendarFastPath: async () => ({
        ok: true,
        calendarEventId: "evt-mini",
        meetLink: null,
        attendeeCount: 0,
      }),
      enqueueCalendar: () => {
        throw new Error("Grok enqueue must not be reached on a successful Mini cancel");
      },
    });

    expect(outcome.status).toBe("accepted");
    expect(getJobByDiscordMessageId(coordinatorJobMessageId(event.id))).toBeNull();
  });
});
