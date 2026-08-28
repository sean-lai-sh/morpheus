import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  audienceSelectionsFromMentions,
  collectMentionRoleIds,
  extractMentionableAudience,
  extractRoleSnowflakes,
  meetingAudienceFromSelections,
} from "../src/coordinator/audience.ts";
import { EBOARD_ROLE_ID } from "../src/coordinator/roster-map.ts";
import { buildCalendarJobPack, serializeCalendarJobPack } from "../src/coordinator/calendar-job.ts";
import { looksLikeMeetingMention, extractMeetingTitle } from "../src/bot/meeting-mention.ts";
import { parseAbsoluteWhen } from "../src/coordinator/when.ts";
import { createScheduledMeeting, getMeeting, getMeetingParticipants } from "../src/storage/coordinator-meetings.ts";
import { getDb } from "../src/storage/db.ts";
import { withTempDb } from "./helpers.ts";

const db = withTempDb();
beforeAll(() => {
  getDb();
});
afterAll(() => db.cleanup());

describe("meeting audience", () => {
  test("Eboard role snowflake is f26_roster and does not expand members", () => {
    const selections = audienceSelectionsFromMentions({
      users: [],
      roleIds: [EBOARD_ROLE_ID],
    });
    const audience = meetingAudienceFromSelections(selections);
    expect(audience.audienceKind).toBe("f26_roster");
    expect(audience.userSelections).toEqual([]);
  });

  test("picker value is the Eboard snowflake even when resolved.roles is empty", () => {
    const selections = extractMentionableAudience({
      values: [EBOARD_ROLE_ID, "11"],
      resolved: {
        users: { "11": { username: "sean", global_name: "Sean" } },
        roles: {},
      },
    });
    expect(selections.some((row) => row.kind === "role" && row.id === EBOARD_ROLE_ID)).toBe(true);
    const audience = meetingAudienceFromSelections(selections);
    expect(audience.audienceKind).toBe("f26_roster");
    expect(audience.userSelections.map((u) => u.id)).toEqual(["11"]);
  });

  test("the word eboard is not a role detect", () => {
    expect(extractRoleSnowflakes("please invite eboard to the meeting Friday 3pm")).toEqual([]);
    expect(collectMentionRoleIds({ content: "invite Eboard and eboard", cachedRoleIds: [] })).toEqual([]);
    const audience = meetingAudienceFromSelections(
      audienceSelectionsFromMentions({
        users: [{ id: "11", displayName: "Sean" }],
        roleIds: [],
      }),
    );
    expect(audience.audienceKind).toBe("picked");
  });

  test("<@&snowflake> in content is detected without the roles cache", () => {
    const ids = collectMentionRoleIds({
      content: `<@123> meeting Friday 3pm <@&${EBOARD_ROLE_ID}>`,
      cachedRoleIds: [],
    });
    expect(ids).toEqual([EBOARD_ROLE_ID]);
    expect(meetingAudienceFromSelections(audienceSelectionsFromMentions({ users: [], roleIds: ids })).audienceKind).toBe(
      "f26_roster",
    );
  });

  test("unmapped role is not the F26 dump", () => {
    const audience = meetingAudienceFromSelections(
      audienceSelectionsFromMentions({
        users: [],
        roleIds: ["999999999999999999"],
      }),
    );
    expect(audience.audienceKind).toBe("picked");
  });

  test("explicit users stay picked snowflakes", () => {
    const audience = meetingAudienceFromSelections(
      audienceSelectionsFromMentions({
        users: [{ id: "11", displayName: "Sean" }],
        roleIds: [],
      }),
    );
    expect(audience.audienceKind).toBe("picked");
    expect(audience.userSelections.map((u) => u.id)).toEqual(["11"]);
  });

  test("role + extra users keeps snowflakes on f26_roster", () => {
    const audience = meetingAudienceFromSelections(
      audienceSelectionsFromMentions({
        users: [{ id: "11", displayName: "Sean" }],
        roleIds: [EBOARD_ROLE_ID],
      }),
    );
    expect(audience.audienceKind).toBe("f26_roster");
    expect(audience.userSelections.map((u) => u.id)).toEqual(["11"]);
  });

  test("f26_roster meeting may have zero participants; pack has audience and no emails", () => {
    const id = crypto.randomUUID();
    const created = createScheduledMeeting({
      id,
      createdByUserId: "creator-1",
      title: "Eboard",
      startsAt: Date.now() + 3_600_000,
      durationMinutes: 60,
      channelId: "1001",
      participants: [],
      audienceKind: "f26_roster",
    });
    expect(getMeeting(id)?.audienceKind).toBe("f26_roster");
    expect(getMeetingParticipants(id)).toEqual([]);
    const pack = buildCalendarJobPack({
      kind: "meeting.calendar_sync",
      meeting: created.meeting,
      outboxId: "ob-1",
      version: 1,
      participantCount: 0,
      participantIds: [],
    });
    const json = serializeCalendarJobPack(pack);
    expect(pack.audience).toBe("f26_roster");
    expect(pack.participant_ids).toEqual([]);
    expect(json).not.toMatch(/@nyu\.edu|@gmail\.com/i);
  });

  test("f26 pack keeps extra user snowflakes and still has no emails", () => {
    const pack = buildCalendarJobPack({
      kind: "meeting.calendar_sync",
      meeting: {
        id: "meet-role",
        title: "Eboard",
        startsAt: Date.now() + 3_600_000,
        endsAt: Date.now() + 7_200_000,
        timeZone: "America/New_York",
        notes: `invite <@&${EBOARD_ROLE_ID}>`,
        calendarEventId: null,
        audienceKind: "f26_roster",
      },
      outboxId: "ob-role",
      version: 1,
      participantCount: 1,
      participantIds: ["11"],
    });
    const json = serializeCalendarJobPack(pack);
    expect(pack.audience).toBe("f26_roster");
    expect(pack.participant_ids).toEqual(["11"]);
    expect(json).toContain(EBOARD_ROLE_ID);
    expect(json).toContain("hello@techatnyu.org");
    expect(json.replace(/hello@techatnyu\.org/gi, "")).not.toMatch(/@nyu\.edu|@gmail\.com/i);
  });

  test("picked meeting still requires an attendee", () => {
    expect(() =>
      createScheduledMeeting({
        createdByUserId: "creator-1",
        title: "1:1",
        startsAt: Date.now() + 3_600_000,
        durationMinutes: 30,
        participants: [],
        audienceKind: "picked",
      }),
    ).toThrow("Add at least one attendee.");
  });
});

describe("mention door helpers", () => {
  test("meeting hint + title strip mentions", () => {
    expect(looksLikeMeetingMention("please schedule a meeting Friday 3pm")).toBe(true);
    expect(looksLikeMeetingMention("what is the weather")).toBe(false);
    expect(extractMeetingTitle("<@123> meeting Friday 3pm with <@456>")).toContain("meeting Friday 3pm");
  });

  test("parseAbsoluteWhen accepts Friday 3pm and ISO", () => {
    const friday = parseAbsoluteWhen("book a meeting Friday 3pm", new Date("2026-08-24T12:00:00-04:00"));
    expect(friday).not.toBeNull();
    expect(friday!.startsAt.getTime()).toBeGreaterThan(Date.parse("2026-08-24T12:00:00-04:00"));
    const iso = parseAbsoluteWhen("meet 2026-09-04 18:00", new Date("2026-08-28T12:00:00Z"));
    expect(iso?.startsAt.toISOString()).toBe(new Date("2026-09-04T22:00:00.000Z").toISOString());
  });
});
