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

function sampleMeeting(
  over: Partial<Parameters<typeof buildCalendarJobPack>[0]["meeting"]> = {},
): Parameters<typeof buildCalendarJobPack>[0]["meeting"] {
  return {
    id: "meet-1",
    title: "Eboard sync",
    startsAt: Date.parse("2026-09-10T17:00:00Z"),
    endsAt: Date.parse("2026-09-10T18:00:00Z"),
    timeZone: "America/New_York",
    notes: "Agenda in thread",
    calendarEventId: null,
    calendarTarget: "eboard",
    conference: true,
    recurrence: "none",
    audienceKind: "picked",
    source: "slash",
    sourceText: null,
    sourceMessageId: null,
    requestedNames: [],
    createdByUserId: "creator-1",
    createdByUsername: "Shaszis",
    createdByGlobalName: "Sean Lai",
    createdByGuildNick: "Sean",
    ...over,
  };
}

describe("calendar job pack", () => {
  test("structured JSON contains meeting fields and no bot token", () => {
    const pack = buildCalendarJobPack({
      kind: "meeting.calendar_sync",
      meeting: sampleMeeting(),
      outboxId: "outbox-1",
      version: 1,
      participants: [
        { userId: "u-1", username: "p6ca", globalName: "Pope Cruz", guildNick: "Pope" },
        { userId: "u-2", username: "HFYJ", globalName: "Jennifer Huang", guildNick: "Jennifer" },
      ],
    });
    const content = redactCalendarJobContent(serializeCalendarJobPack(pack));
    expect(content).not.toContain(TOKEN);
    expect(content).not.toContain("DISCORD_BOT_TOKEN");
    expect(content).not.toMatch(/@gmail\.com|@nyu\.edu/i);
    expect(content).toContain("meet-1");
    expect(content).toContain("hello@techatnyu.org");
    expect(content).toContain("p6ca");
    expect(content).toContain("HFYJ");
    expect(content).toContain("Shaszis");
    expect(JSON.parse(content).audience).toBe("picked");
    expect(JSON.parse(content).mapper.sheet_id).toBe("1NlApvtFAhFTMNafGoVksrYpJhi_oz5dlA6pml5VQ3rw");
    expect(JSON.parse(content).participants[0]).toEqual({
      user_id: "u-1",
      username: "p6ca",
      global_name: "Pope Cruz",
      guild_nick: "Pope",
    });
    expect(parseCoordinatorJobContent(content)?.kind).toBe("meeting.calendar_sync");
    expect(coordinatorJobMessageId("outbox-1")).toBe("coordinator-outbox:outbox-1");
  });

  test("cancel pack also omits token and emails", () => {
    const pack = buildCalendarJobPack({
      kind: "meeting.calendar_cancel",
      meeting: sampleMeeting({ id: "meet-2", notes: null, calendarEventId: "evt-1" }),
      outboxId: "outbox-2",
      version: 2,
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

  test("complete replies with Meet announcement when the job is a real Discord message", async () => {
    const meetingId = crypto.randomUUID();
    createScheduledMeeting({
      id: meetingId,
      createdByUserId: "creator-1",
      title: "Mention complete",
      startsAt: Date.now() + 3_600_000,
      durationMinutes: 30,
      channelId: SPONSORS,
      participants: [{ userId: "u-1", username: "p6ca", globalName: "Pope Cruz", guildNick: "Pope" }],
      source: "mention",
      sourceMessageId: "1400000000000000099",
    });
    const pack = buildCalendarJobPack({
      kind: "meeting.calendar_sync",
      meeting: getMeeting(meetingId)!,
      outboxId: "outbox-mention",
      version: 1,
    });
    const { job } = enqueueJob({
      discordMessageId: "1400000000000000099",
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "creator-1",
      namespace: EBOARD,
      content: serializeCalendarJobPack(pack),
      lane: "background",
    });
    claimJob(job.id, "grok-eboard");
    let replied = "";
    const result = await completeJobWithReply(
      job.id,
      "grok-eboard",
      { reply: JSON.stringify({ calendar_event_id: "evt-mention", meet_link: "https://meet.google.com/abc-defg-hij" }) },
      {
        postReplies: true,
        client: {
          channels: {
            fetch: async () => ({
              isTextBased: () => true,
              messages: {
                fetch: async () => ({
                  reply: async (opts: { content: string }) => {
                    replied = opts.content;
                    return { id: "reply-1" };
                  },
                }),
              },
              send: async () => ({ id: "extra" }),
            }),
          },
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.posted).toBe(true);
    expect(replied).toContain("https://meet.google.com/abc-defg-hij");
    expect(replied).toContain("Mention complete");
    expect(replied).not.toMatch(/@nyu\.edu/i);
    expect(getMeeting(meetingId)?.meetLink).toBe("https://meet.google.com/abc-defg-hij");
  });

  test("applyCoordinatorJobComplete ignores cancel kinds", () => {
    applyCoordinatorJobComplete(
      serializeCalendarJobPack(
        buildCalendarJobPack({
          kind: "meeting.calendar_cancel",
          meeting: sampleMeeting({
            id: "nope",
            title: "x",
            startsAt: Date.now() + 1000,
            endsAt: Date.now() + 2000,
            notes: null,
            calendarEventId: "evt",
          }),
          outboxId: "x",
          version: 1,
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
      meeting: sampleMeeting({
        id: "meet-3",
        title: "Leak test",
        startsAt: Date.now() + 1000,
        endsAt: Date.now() + 2000,
        notes: `do not send ${TOKEN} or fh2419@nyu.edu`,
        calendarEventId: null,
      }),
      outboxId: "outbox-3",
      version: 1,
    });
    const content = redactCalendarJobContent(serializeCalendarJobPack(pack));
    expect(content).not.toContain(TOKEN);
    expect(content).not.toContain("fh2419@nyu.edu");
    expect(content).toContain("[redacted]");
    expect(content).toContain("[email omitted]");
  });

  test("f26 roster pack has no participant emails and names the sheet mapper", () => {
    const pack = buildCalendarJobPack({
      kind: "meeting.calendar_sync",
      meeting: sampleMeeting({
        audienceKind: "f26_roster",
        recurrence: "weekly",
        source: "mention",
        sourceText: "book eboard Friday 6:30 ET",
      }),
      outboxId: "outbox-f26",
      version: 1,
    });
    const parsed = JSON.parse(serializeCalendarJobPack(pack));
    expect(parsed.audience).toBe("f26_roster");
    expect(parsed.recurrence).toBe("weekly");
    expect(parsed.recurrence_until).toBe("2026-12-15");
    expect(parsed.location).toBe("TBD");
    expect(parsed.notify).toBe("all");
    expect(parsed.participants).toEqual([]);
    expect(parsed.calendar_id).toBe(
      "c_9933b833e4985f99fdaf9ce9b7ef54b7bbc478e506c9e83e99743697b82863fb@group.calendar.google.com",
    );
    expect(parsed.mapper.tab_gid).toBe("1079418365");
    expect(parsed.mapper.fallback_tab).toBe("S26");
    expect(parsed.mapper.optional_names).toEqual(["Cyan Yan", "Kaylee Chen", "Grace Gao"]);
    expect(parsed.mapper.required_despite_abroad).toEqual(["Haley Ngai"]);
    expect(parsed.instruction).toMatch(/never hello@ primary/i);
    expect(JSON.stringify(parsed)).not.toMatch(/@nyu\.edu/i);
  });

  test("slash pack locks the fields NL guessed on the real job", () => {
    const pack = buildCalendarJobPack({
      kind: "meeting.calendar_sync",
      meeting: sampleMeeting({
        source: "slash",
        location: "TBD",
        recurrence: "weekly",
        recurrenceUntil: "2026-12-15",
        fieldLocks: [
          "title",
          "start",
          "duration",
          "timezone",
          "calendar",
          "recurrence",
          "location",
          "conference",
          "attendees",
        ],
      }),
      outboxId: "outbox-locked",
      version: 1,
    });
    expect(pack.locked).toEqual([
      "title",
      "start",
      "duration",
      "timezone",
      "calendar",
      "recurrence",
      "location",
      "conference",
      "attendees",
    ]);
    expect(pack.notify).toBe("all");
    expect(JSON.stringify(pack)).not.toMatch(/@nyu\.edu/i);
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
