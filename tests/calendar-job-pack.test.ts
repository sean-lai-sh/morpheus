import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  applyCoordinatorJobComplete,
  buildCalendarJobPack,
  coordinatorJobMessageId,
  parseCalendarCompleteReply,
  parseCoordinatorJobContent,
  redactCalendarJobContent,
  serializeCalendarJobPack,
} from "../src/coordinator/calendar-job.ts";
import { completeJobWithReply } from "../src/bot/reply.ts";
import { claimJob, enqueueJob, getJob } from "../src/storage/jobs.ts";
import { applyCalendarSyncResult, createScheduledMeeting, getMeeting } from "../src/storage/coordinator-meetings.ts";
import { getDb } from "../src/storage/db.ts";
import { parseEnv } from "../src/config.ts";
import { withTempDb } from "./helpers.ts";
import { EBOARD, SPONSORS, withWorkspaceConfig } from "./jobs-fixture.ts";

const TOKEN = "test-discord-bot-token-value-never-in-payload";
const db = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;

beforeAll(() => {
  process.env.DISCORD_BOT_TOKEN = TOKEN;
  process.env.DISCORD_POST_REPLIES = "true";
  cfg = withWorkspaceConfig();
  getDb();
});

afterAll(() => {
  cfg.cleanup();
  db.cleanup();
});

describe("calendar job pack", () => {
  test("structured JSON contains meeting fields and no bot token", () => {
    const pack = buildCalendarJobPack({
      kind: "meeting.calendar_sync",
      meeting: {
        id: "meet-1",
        title: "Eboard sync",
        startsAt: Date.parse("2026-09-10T17:00:00Z"),
        endsAt: Date.parse("2026-09-10T18:00:00Z"),
        timeZone: "America/New_York",
        notes: "Agenda in thread",
        calendarEventId: null,
      },
      outboxId: "outbox-1",
      version: 1,
      participantCount: 3,
    });
    const content = redactCalendarJobContent(serializeCalendarJobPack(pack));
    expect(content).not.toContain(TOKEN);
    expect(content).not.toContain("DISCORD_BOT_TOKEN");
    expect(content).not.toMatch(/@gmail\.com|@nyu\.edu/i);
    expect(content).toContain("meet-1");
    expect(content).toContain("hello@techatnyu.org");
    expect(parseCoordinatorJobContent(content)?.kind).toBe("meeting.calendar_sync");
    expect(coordinatorJobMessageId("outbox-1")).toBe("coordinator-outbox:outbox-1");
  });

  test("cancel pack also omits token and emails", () => {
    const pack = buildCalendarJobPack({
      kind: "meeting.calendar_cancel",
      meeting: {
        id: "meet-2",
        title: "Eboard sync",
        startsAt: Date.parse("2026-09-10T17:00:00Z"),
        endsAt: Date.parse("2026-09-10T18:00:00Z"),
        timeZone: "America/New_York",
        notes: null,
        calendarEventId: "evt-1",
      },
      outboxId: "outbox-2",
      version: 2,
      participantCount: 3,
    });
    const content = redactCalendarJobContent(serializeCalendarJobPack(pack));
    expect(content).not.toContain(TOKEN);
    expect(parseCoordinatorJobContent(content)?.kind).toBe("meeting.calendar_cancel");
  });

  test("complete reply parses event id + Meet link", () => {
    expect(
      parseCalendarCompleteReply('{"calendar_event_id":"evt-9","meet_link":"https://meet.google.com/abc-defg-hij"}'),
    ).toEqual({
      calendarEventId: "evt-9",
      meetLink: "https://meet.google.com/abc-defg-hij",
      cancelled: false,
    });
  });

  test("job complete applies calendar result and never posts a Discord reply", async () => {
    const meetingId = crypto.randomUUID();
    createScheduledMeeting({
      id: meetingId,
      createdByUserId: "creator-1",
      title: "Calendar complete",
      startsAt: Date.now() + 3_600_000,
      durationMinutes: 30,
      channelId: SPONSORS,
      participants: [{ userId: "u-1" }],
    });
    const pack = buildCalendarJobPack({
      kind: "meeting.calendar_sync",
      meeting: getMeeting(meetingId)!,
      outboxId: "outbox-complete",
      version: 1,
      participantCount: 1,
    });
    const content = serializeCalendarJobPack(pack);
    expect(content).not.toContain(TOKEN);
    const { job } = enqueueJob({
      discordMessageId: coordinatorJobMessageId("outbox-complete"),
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "creator-1",
      namespace: EBOARD,
      content,
    });
    claimJob(job.id, "grok-eboard");
    const result = await completeJobWithReply(
      job.id,
      "grok-eboard",
      { reply: JSON.stringify({ calendar_event_id: "evt-applied", meet_link: "https://meet.google.com/zzz-zzzz-zzz" }) },
      {
        postReplies: true,
        client: {
          channels: {
            fetch: async () => {
              throw new Error("must not fetch Discord for a coordinator calendar job");
            },
          },
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.posted).toBe(false);
    expect(getJob(job.id)?.status).toBe("completed");
    expect(getMeeting(meetingId)?.calendarEventId).toBe("evt-applied");
    expect(getMeeting(meetingId)?.meetLink).toBe("https://meet.google.com/zzz-zzzz-zzz");
  });

  test("applyCoordinatorJobComplete ignores cancel kinds", () => {
    applyCoordinatorJobComplete(
      serializeCalendarJobPack(
        buildCalendarJobPack({
          kind: "meeting.calendar_cancel",
          meeting: {
            id: "nope",
            title: "x",
            startsAt: Date.now() + 1000,
            endsAt: Date.now() + 2000,
            timeZone: "America/New_York",
            notes: null,
            calendarEventId: "evt",
          },
          outboxId: "x",
          version: 1,
          participantCount: 0,
        }),
      ),
      '{"cancelled":true}',
    );
    expect(getMeeting("nope")).toBeNull();
  });

  test("env token is redacted if it leaked into notes", () => {
    const env = parseEnv({
      DISCORD_BOT_TOKEN: TOKEN,
      DISCORD_GUILD_ID: "987654321098765432",
    });
    void env;
    const pack = buildCalendarJobPack({
      kind: "meeting.calendar_sync",
      meeting: {
        id: "meet-3",
        title: "Leak test",
        startsAt: Date.now() + 1000,
        endsAt: Date.now() + 2000,
        timeZone: "America/New_York",
        notes: `do not send ${TOKEN}`,
        calendarEventId: null,
      },
      outboxId: "outbox-3",
      version: 1,
      participantCount: 1,
    });
    const content = redactCalendarJobContent(serializeCalendarJobPack(pack));
    expect(content).not.toContain(TOKEN);
    expect(content).toContain("[redacted]");
  });
});

describe("applyCalendarSyncResult version guard", () => {
  test("stale version does not overwrite", () => {
    const id = crypto.randomUUID();
    createScheduledMeeting({
      id,
      createdByUserId: "creator-1",
      title: "Stale",
      startsAt: Date.now() + 4_000_000,
      durationMinutes: 30,
      channelId: SPONSORS,
      participants: [{ userId: "u-1" }],
    });
    applyCalendarSyncResult({ meetingId: id, version: 99, calendarEventId: "nope" });
    expect(getMeeting(id)?.calendarEventId).toBeNull();
  });
});
