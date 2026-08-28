import { describe, expect, test } from "bun:test";
import { isMeetingIntent, parseMeetingRequest } from "../src/coordinator/meeting-request.ts";

const FRIDAY_MORNING = Date.parse("2026-08-28T07:36:00Z"); // Friday, before 6:30pm ET

describe("meeting intent", () => {
  test("detects book eboard + meet with, ignores agenda questions", () => {
    expect(isMeetingIntent("<@bot> book eboard Friday 6:30 ET", "bot")).toBe(true);
    expect(isMeetingIntent("meet with Pope and Jennifer tomorrow 3pm")).toBe(true);
    expect(isMeetingIntent("what's on the meeting agenda")).toBe(false);
    expect(isMeetingIntent("can you summarize last week's eboard notes")).toBe(false);
  });

  test("parses book eboard Friday 6:30 ET as F26 weekly", () => {
    const parsed = parseMeetingRequest("<@99> book eboard Friday 6:30 ET", {
      now: FRIDAY_MORNING,
      botUserId: "99",
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe("Tech@NYU Eboard");
    expect(parsed!.audienceKind).toBe("f26_roster");
    expect(parsed!.calendar).toBe("eboard");
    expect(parsed!.recurrence).toBe("weekly");
    expect(parsed!.conference).toBe(true);
    expect(parsed!.timeZone).toBe("America/New_York");
    expect(parsed!.durationMinutes).toBe(60);
    const local = new Date(parsed!.startsAt).toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
    expect(local).toMatch(/Fri/);
    expect(local).toMatch(/6:30/);
    expect(JSON.stringify(parsed)).not.toMatch(/@nyu\.edu/i);
  });

  test("parses meet with Pope and Jennifer tomorrow 3pm", () => {
    const parsed = parseMeetingRequest("meet with Pope and Jennifer tomorrow 3pm", {
      now: FRIDAY_MORNING,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.requestedNames).toEqual(["Pope", "Jennifer"]);
    expect(parsed!.audienceKind).toBe("picked");
    expect(parsed!.title).toBe("Meeting with Pope and Jennifer");
    const local = new Date(parsed!.startsAt).toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
    expect(local).toMatch(/3:00/);
  });

  test("once / this Friday is not weekly", () => {
    const parsed = parseMeetingRequest("book eboard this Friday 6:30 ET", { now: FRIDAY_MORNING });
    expect(parsed!.recurrence).toBe("none");
  });

  test("real cal-invite job 1a493bac: Sept 4 6-8pm + Eboard role + F26 sheet", () => {
    const text =
      "make a cal invite for Sept 4 EST 6-8pm and invite the Eboard Discord role <@&1203562091500404782> via the F26 contact sheet (gid 1079418365)";
    expect(isMeetingIntent(text)).toBe(true);
    const parsed = parseMeetingRequest(text, { now: FRIDAY_MORNING });
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe("Tech@NYU Eboard");
    expect(parsed!.audienceKind).toBe("f26_roster");
    expect(parsed!.calendar).toBe("eboard");
    expect(parsed!.recurrence).toBe("none");
    expect(parsed!.conference).toBe(true);
    expect(parsed!.timeZone).toBe("America/New_York");
    expect(parsed!.durationMinutes).toBe(120);
    expect(parsed!.location).toBe("TBD");
    expect(parsed!.requestedNames).toEqual([]);
    expect(parsed!.locked).toContain("start");
    expect(parsed!.locked).toContain("attendees");
    const local = new Date(parsed!.startsAt).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    expect(local).toMatch(/Sep/);
    expect(local).toMatch(/4/);
    expect(local).toMatch(/6:00/);
    expect(JSON.stringify(parsed)).not.toMatch(/@nyu\.edu/i);
  });

  test("weekly reshape keeps until 2026-12-15 and does not treat Haley as optional", () => {
    const parsed = parseMeetingRequest(
      "book eboard Friday 6:30 ET weekly until 2026-12-15",
      { now: FRIDAY_MORNING },
    );
    expect(parsed!.recurrence).toBe("weekly");
    expect(parsed!.recurrenceUntil).toBe("2026-12-15");
    expect(parsed!.durationMinutes).toBe(60);
  });
});
