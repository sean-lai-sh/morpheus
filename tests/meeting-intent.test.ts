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
});
