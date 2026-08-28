import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { publishOutboxEvent } from "../src/coordinator/publisher.ts";
import { coordinatorJobMessageId } from "../src/coordinator/calendar-job.ts";
import {
  tryMiniCalendarCancel,
  tryMiniCalendarSync,
  type FastPathOutcome,
} from "../src/coordinator/calendar-fast-path.ts";
import type { CalendarClient, CalendarEventInput } from "../src/coordinator/calendar-client.ts";
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
  const client: CalendarClient = {
    async upsertEvent(input) {
      upserts.push(input);
      return {
        calendarEventId: "evt-123",
        meetLink: "https://meet.google.com/abc-defg-hij",
        htmlLink: null,
      };
    },
    async cancelEvent(input) {
      cancels.push(input);
    },
    ...over,
  };
  return { client, upserts, cancels };
}

const SYNC_INPUT = {
  meetingId: "m-1",
  title: "Eboard sync",
  startsAt: "2026-09-01T18:00:00.000Z",
  endsAt: "2026-09-01T18:30:00.000Z",
  timeZone: "America/New_York",
  notes: null,
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

  test("a Calendar API failure degrades to Grok instead of losing the meeting", async () => {
    const { client } = recordingClient({
      async upsertEvent() {
        throw new Error("boom");
      },
    });
    const out = await tryMiniCalendarSync(
      { ...SYNC_INPUT, audience: "picked", participantIds: ["100000000000000001"] },
      { client, env: {} },
    );
    expect(out).toEqual({ ok: false, skip: "api-error" });
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

  test("no event id means there is nothing to cancel here", async () => {
    const { client, cancels } = recordingClient();
    const out = await tryMiniCalendarCancel(
      { meetingId: "m-1", calendarEventId: null },
      { client, env: {} },
    );
    expect(out).toEqual({ ok: false, skip: "missing-event-id" });
    expect(cancels).toHaveLength(0);
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
