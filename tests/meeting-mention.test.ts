import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tryHandleMeetingMention } from "../src/bot/meeting-mention.ts";
import { getMeeting, getMeetingParticipants } from "../src/storage/coordinator-meetings.ts";
import { getDb } from "../src/storage/db.ts";
import { upsertUser } from "../src/storage/users.ts";
import { withTempDb } from "./helpers.ts";
import { SPONSORS, withWorkspaceConfig } from "./jobs-fixture.ts";

const ROLE = "role-eboard";
const db = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;

beforeAll(() => {
  process.env.JOB_TRIGGER_ROLE_IDS = ROLE;
  cfg = withWorkspaceConfig();
  getDb();
  upsertUser("u-pope", "p6ca", "Pope", "Pope Cruz", Date.now());
  upsertUser("u-jen", "HFYJ", "Jennifer", "Jennifer Huang", Date.now());
});

afterAll(() => {
  cfg.cleanup();
  db.cleanup();
  delete process.env.JOB_TRIGGER_ROLE_IDS;
});

const NOW = Date.parse("2026-08-28T12:00:00Z");

function mention(over: Partial<Parameters<typeof tryHandleMeetingMention>[0]> = {}) {
  return tryHandleMeetingMention({
    discordMessageId: "1400000000000000001",
    discordChannelId: SPONSORS,
    parentChannelId: null,
    authorId: "u-sean",
    authorIsBot: false,
    authorRoleIds: [ROLE],
    content: "<@bot> book eboard Friday 6:30 ET",
    mentionedBot: true,
    botUserId: "bot",
    now: NOW,
    author: { userId: "u-sean", username: "Shaszis", globalName: "Sean Lai", guildNick: "Sean" },
    mentioned: [],
    ...over,
  });
}

describe("mention meeting door", () => {
  test("non-meeting mention is not handled", async () => {
    const result = await mention({ content: "<@bot> what is on the agenda", mentionedBot: true });
    expect(result.handled).toBe(false);
    expect(result.reason).toBe("not-meeting");
  });

  test("role gate fail-closes like other job commands", async () => {
    const result = await mention({ authorRoleIds: [] });
    expect(result.handled).toBe(false);
    expect(result.reason).toBe("role-gate");
  });

  test("eboard Friday mention creates the same calendar_sync meeting", async () => {
    const result = await mention();
    expect(result.handled).toBe(true);
    const meeting = getMeeting(result.meetingId!);
    expect(meeting?.title).toBe("Tech@NYU Eboard");
    expect(meeting?.audienceKind).toBe("f26_roster");
    expect(meeting?.source).toBe("mention");
    expect(meeting?.sourceMessageId).toBe("1400000000000000001");
    expect(meeting?.recurrence).toBe("weekly");
    expect(getMeetingParticipants(meeting!.id)).toEqual([]);
    const outbox = getDb()
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM outbox_events WHERE type = 'meeting.calendar_sync_requested' AND aggregate_id = ?`,
      )
      .get(meeting!.id);
    expect(outbox?.n).toBe(1);
  });

  test("role mention + F26 sheet is roster with empty participants", async () => {
    const result = await mention({
      content:
        "<@bot> make a cal invite for Sept 4 EST 6-8pm and invite the Eboard Discord role <@&1203562091500404782> via the F26 contact sheet (gid 1079418365)",
      discordMessageId: "1400000000000000003",
      mentionedRoleIds: ["1203562091500404782"],
      mentioned: [],
    });
    expect(result.handled).toBe(true);
    const meeting = getMeeting(result.meetingId!);
    expect(meeting?.audienceKind).toBe("f26_roster");
    expect(meeting?.calendarTarget).toBe("eboard");
    expect(meeting?.recurrence).toBe("none");
    expect(meeting?.location).toBe("TBD");
    expect((meeting!.endsAt - meeting!.startsAt) / 60_000).toBe(120);
    expect(getMeetingParticipants(meeting!.id)).toEqual([]);
    expect(meeting?.requestedNames).toEqual([]);
    expect(JSON.stringify(meeting)).not.toMatch(/@nyu\.edu/i);
  });

  test("named people resolve from users cache without packing emails", async () => {
    const result = await mention({
      content: "<@bot> meet with Pope and Jennifer tomorrow 3pm",
      discordMessageId: "1400000000000000002",
    });
    expect(result.handled).toBe(true);
    const people = getMeetingParticipants(result.meetingId!);
    expect(people.map((p) => p.username).sort()).toEqual(["HFYJ", "p6ca"]);
    expect(JSON.stringify(people)).not.toMatch(/@nyu\.edu/i);
    expect(getMeeting(result.meetingId!)?.requestedNames ?? []).toEqual([]);
  });
});
