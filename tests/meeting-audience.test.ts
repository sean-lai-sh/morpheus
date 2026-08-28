import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  audienceSelectionsFromMentions,
  meetingAudienceFromSelections,
} from "../src/coordinator/audience.ts";
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
  test("role selection is f26_roster and does not expand members", () => {
    const selections = audienceSelectionsFromMentions({
      users: [],
      roleIds: ["1203562091500404782"],
    });
    const audience = meetingAudienceFromSelections(selections);
    expect(audience.audienceKind).toBe("f26_roster");
    expect(audience.userSelections).toEqual([]);
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
        roleIds: ["1203562091500404782"],
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
