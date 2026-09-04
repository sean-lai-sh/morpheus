import { describe, expect, test } from "bun:test";
import { parseDurationInput, parseWhenInput, WhenParseError } from "../src/coordinator/when-input.ts";
import { parseMeetingStart } from "../src/coordinator/audience.ts";

const TZ = "America/New_York";

/** Friday 2026-08-28, 10:00 EDT. Every test pins `now`; never Date.now(). */
const NOW = Date.parse("2026-08-28T14:00:00Z");

const when = (raw: string, now: number = NOW) => parseWhenInput(raw, TZ, now).toISOString();

const wallClock = (date: Date) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);

describe("parseWhenInput — forms that already worked", () => {
  test("ISO-8601 with Z matches parseMeetingStart exactly", () => {
    const raw = "2026-09-04T18:00:00Z";
    expect(when(raw)).toBe(parseMeetingStart(raw, TZ, NOW).toISOString());
    expect(when(raw)).toBe("2026-09-04T18:00:00.000Z");
  });

  test("ISO-8601 with a numeric offset matches parseMeetingStart exactly", () => {
    const raw = "2026-09-04T14:00:00-04:00";
    expect(when(raw)).toBe(parseMeetingStart(raw, TZ, NOW).toISOString());
    expect(when(raw)).toBe("2026-09-04T18:00:00.000Z");
  });

  test("YYYY-MM-DD HH:mm is interpreted in the given zone, same as parseMeetingStart", () => {
    const raw = "2026-09-04 14:00";
    expect(when(raw)).toBe(parseMeetingStart(raw, TZ, NOW).toISOString());
    expect(when(raw)).toBe("2026-09-04T18:00:00.000Z");
  });

  test("YYYY-MM-DDTHH:mm and stray seconds still land on the same instant", () => {
    expect(when("2026-09-04T14:00")).toBe("2026-09-04T18:00:00.000Z");
    expect(when("2026-09-04 14:00:00")).toBe("2026-09-04T18:00:00.000Z");
  });
});

describe("parseWhenInput — relative days", () => {
  test("today", () => {
    expect(when("today 5pm")).toBe("2026-08-28T21:00:00.000Z");
  });

  test("tomorrow and tmr", () => {
    expect(when("tomorrow 3pm")).toBe("2026-08-29T19:00:00.000Z");
    expect(when("tmr 3:30pm")).toBe("2026-08-29T19:30:00.000Z");
    expect(when("tmrw 3:30pm")).toBe("2026-08-29T19:30:00.000Z");
  });

  test("today rolls the calendar date, not raw epoch ms", () => {
    // 23:30 EDT on Aug 28 is already Aug 29 in UTC; "tomorrow" is Aug 29 *local*,
    // not Aug 30 as naive epoch-ms arithmetic on the UTC date would give.
    const lateNight = Date.parse("2026-08-29T03:30:00Z");
    expect(when("tomorrow 9am", lateNight)).toBe("2026-08-29T13:00:00.000Z");
    expect(when("today 11:45pm", lateNight)).toBe("2026-08-29T03:45:00.000Z");
  });
});

describe("parseWhenInput — weekdays", () => {
  test("plain weekday is the next occurrence strictly after now (today counts if still ahead)", () => {
    // now is Friday 10:00 EDT, so "friday 2pm" is today.
    expect(when("friday 2pm")).toBe("2026-08-28T18:00:00.000Z");
    expect(when("fri 2pm")).toBe("2026-08-28T18:00:00.000Z");
    expect(when("monday 2pm")).toBe("2026-08-31T18:00:00.000Z");
    expect(when("wed 9:30am")).toBe("2026-09-02T13:30:00.000Z");
  });

  test("plain weekday skips a week once today's time has passed", () => {
    const afternoon = Date.parse("2026-08-28T20:00:00Z"); // Friday 16:00 EDT
    expect(when("friday 2pm", afternoon)).toBe("2026-09-04T18:00:00.000Z");
  });

  test("`next <weekday>` is 7 days after the plain reading", () => {
    expect(when("next friday 2pm")).toBe("2026-09-04T18:00:00.000Z");
    expect(when("next monday 2pm")).toBe("2026-09-07T18:00:00.000Z");
    const afternoon = Date.parse("2026-08-28T20:00:00Z");
    expect(when("next friday 2pm", afternoon)).toBe("2026-09-11T18:00:00.000Z");
  });

  test("`this <weekday>` reads like the plain form", () => {
    expect(when("this friday 2pm")).toBe(when("friday 2pm"));
  });
});

describe("parseWhenInput — month-name and numeric dates", () => {
  test("month-name forms in both orders", () => {
    expect(when("sep 4 2pm")).toBe("2026-09-04T18:00:00.000Z");
    expect(when("september 4 2:30pm")).toBe("2026-09-04T18:30:00.000Z");
    expect(when("4 sep 2pm")).toBe("2026-09-04T18:00:00.000Z");
    expect(when("sept 4th 2pm")).toBe("2026-09-04T18:00:00.000Z");
  });

  test("no year rolls to next year once the date has passed", () => {
    expect(when("jan 5 2pm")).toBe("2027-01-05T19:00:00.000Z"); // EST, next January
    expect(when("dec 1 2pm")).toBe("2026-12-01T19:00:00.000Z"); // still ahead this year
  });

  test("explicit year is honored", () => {
    expect(when("sep 4 2026 2pm")).toBe("2026-09-04T18:00:00.000Z");
  });

  test("slash dates are US order: MM/DD", () => {
    expect(when("9/4 2pm")).toBe("2026-09-04T18:00:00.000Z");
    expect(when("12/25/2026 6pm")).toBe("2026-12-25T23:00:00.000Z");
    expect(when("12/25/26 6pm")).toBe("2026-12-25T23:00:00.000Z");
  });
});

describe("parseWhenInput — time formats and tolerance", () => {
  test("meridiem spellings", () => {
    expect(when("today 2pm")).toBe("2026-08-28T18:00:00.000Z");
    expect(when("today 2 pm")).toBe("2026-08-28T18:00:00.000Z");
    expect(when("today 2p")).toBe("2026-08-28T18:00:00.000Z");
    expect(when("today 2:30pm")).toBe("2026-08-28T18:30:00.000Z");
    expect(when("today 11:15 AM")).toBe("2026-08-28T15:15:00.000Z");
    expect(when("today 12pm")).toBe("2026-08-28T16:00:00.000Z");
    expect(when("tomorrow 12am")).toBe("2026-08-29T04:00:00.000Z");
  });

  test("colon times with no meridiem are a 24-hour clock", () => {
    expect(when("today 14:00")).toBe("2026-08-28T18:00:00.000Z");
    expect(when("tomorrow 02:30")).toBe("2026-08-29T06:30:00.000Z");
  });

  test("case, extra whitespace, and a leading at/on are tolerated", () => {
    expect(when("  ON   Friday   AT  2PM ")).toBe("2026-08-28T18:00:00.000Z");
    expect(when("on friday at 2pm")).toBe("2026-08-28T18:00:00.000Z");
    expect(when("Next Friday, 2 PM")).toBe("2026-09-04T18:00:00.000Z");
  });
});

describe("parseWhenInput — refusals", () => {
  const rejects = (raw: string, now: number = NOW) => {
    expect(() => parseWhenInput(raw, TZ, now)).toThrow(WhenParseError);
    try {
      parseWhenInput(raw, TZ, now);
      throw new Error("expected a throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/\\d|regex|undefined|NaN/i);
      return message;
    }
  };

  test("blank input", () => {
    expect(rejects("")).toMatch(/enter a start time/i);
    expect(rejects("   ")).toMatch(/enter a start time/i);
  });

  test("a bare number is never a time", () => {
    expect(rejects("today 3")).toMatch(/bare number/i);
    expect(rejects("friday 3")).toMatch(/bare number/i);
    expect(rejects("3")).toMatch(/bare number/i);
    expect(rejects("sep 4")).toMatch(/bare number/i);
  });

  test("a time with no day, and a day with no time", () => {
    expect(rejects("2pm")).toMatch(/day/i);
    expect(rejects("friday")).toMatch(/couldn't read/i);
    expect(rejects("next week")).toMatch(/couldn't read/i);
  });

  test("nonsense and impossible clock/calendar values", () => {
    expect(rejects("whenever you're free")).toMatch(/couldn't read/i);
    expect(rejects("friday at 25:00")).toMatch(/couldn't read|isn't a time/i);
    expect(rejects("friday 14pm")).toMatch(/isn't a time/i);
    expect(rejects("feb 30 2pm")).toMatch(/calendar/i);
    expect(rejects("13/40 2pm")).toMatch(/calendar/i);
  });

  test("the instant must be strictly in the future", () => {
    expect(rejects("2026-08-28 09:00")).toBe("Meeting start time must be in the future.");
    expect(rejects("today 9am")).toBe("Meeting start time must be in the future.");
    expect(rejects("2026-08-28T14:00:00Z")).toBe("Meeting start time must be in the future.");
  });

  test("dates more than about a year out read as a typo", () => {
    expect(rejects("sep 4 2028 2pm")).toMatch(/more than a year/i);
    expect(rejects("2062-09-04 14:00")).toMatch(/more than a year/i);
  });

  test("regression: the old chat-sniffing false positives never book anything", () => {
    // These are what killed src/coordinator/when.ts — "…item 4" became 04:00.
    expect(() => parseWhenInput("by monday, I need 2 revisions", TZ, NOW)).toThrow(WhenParseError);
    expect(() => parseWhenInput("before friday - see item 4", TZ, NOW)).toThrow(WhenParseError);
    expect(() => parseWhenInput("sync with @bob before friday - see item 4", TZ, NOW)).toThrow(
      WhenParseError,
    );
    expect(() => parseWhenInput("monday, I need 2 revisions", TZ, NOW)).toThrow(WhenParseError);
    // And nothing in that family can yield a small-hours instant.
    for (const raw of ["friday 4", "monday 2", "friday - see item 4"]) {
      let parsed: Date | null = null;
      try {
        parsed = parseWhenInput(raw, TZ, NOW);
      } catch {
        parsed = null;
      }
      if (parsed) expect(Number(wallClock(parsed).slice(-5, -3))).toBeGreaterThan(6);
    }
  });
});

describe("parseWhenInput — DST", () => {
  // 2026: spring forward Sun Mar 8, fall back Sun Nov 1 (US).
  const beforeSpring = Date.parse("2026-03-01T15:00:00Z"); // Sun Mar 1, 10:00 EST

  test("2pm stays 2pm local across the spring-forward boundary", () => {
    const est = parseWhenInput("mar 7 2pm", TZ, beforeSpring); // still EST
    const edt = parseWhenInput("mar 9 2pm", TZ, beforeSpring); // after the jump, EDT
    expect(wallClock(est)).toBe("03/07/2026, 14:00");
    expect(wallClock(edt)).toBe("03/09/2026, 14:00");
    expect(est.toISOString()).toBe("2026-03-07T19:00:00.000Z"); // UTC-5
    expect(edt.toISOString()).toBe("2026-03-09T18:00:00.000Z"); // UTC-4
  });

  test("a weekday that crosses spring forward keeps its wall-clock hour", () => {
    const thursday = Date.parse("2026-03-05T15:00:00Z"); // Thu Mar 5, 10:00 EST
    const monday = parseWhenInput("monday 2pm", TZ, thursday); // Mon Mar 9, after the jump
    expect(wallClock(monday)).toBe("03/09/2026, 14:00");
    expect(monday.toISOString()).toBe("2026-03-09T18:00:00.000Z");
  });

  test("2pm stays 2pm local across the fall-back boundary", () => {
    const beforeFall = Date.parse("2026-10-28T14:00:00Z"); // Wed Oct 28, 10:00 EDT
    const edt = parseWhenInput("oct 31 2pm", TZ, beforeFall);
    const est = parseWhenInput("nov 2 2pm", TZ, beforeFall);
    expect(wallClock(edt)).toBe("10/31/2026, 14:00");
    expect(wallClock(est)).toBe("11/02/2026, 14:00");
    expect(edt.toISOString()).toBe("2026-10-31T18:00:00.000Z"); // UTC-4
    expect(est.toISOString()).toBe("2026-11-02T19:00:00.000Z"); // UTC-5
  });
});

describe("parseDurationInput", () => {
  test("plain minutes", () => {
    expect(parseDurationInput("30")).toBe(30);
    expect(parseDurationInput("30m")).toBe(30);
    expect(parseDurationInput("30 min")).toBe(30);
    expect(parseDurationInput("45 minutes")).toBe(45);
    expect(parseDurationInput("90 mins")).toBe(90);
  });

  test("hours, fractional hours, and h+m", () => {
    expect(parseDurationInput("1h")).toBe(60);
    expect(parseDurationInput("1 hour")).toBe(60);
    expect(parseDurationInput("1.5h")).toBe(90);
    expect(parseDurationInput("1h30")).toBe(90);
    expect(parseDurationInput("1h30m")).toBe(90);
    expect(parseDurationInput("1 hr 30 min")).toBe(90);
    expect(parseDurationInput("2hr")).toBe(120);
    expect(parseDurationInput("8 hours")).toBe(480);
  });

  test("blank falls back to the default", () => {
    expect(parseDurationInput("")).toBe(30);
    expect(parseDurationInput("   ")).toBe(30);
    expect(parseDurationInput("", 60)).toBe(60);
  });

  test("out of range and junk are refused with a readable message", () => {
    expect(() => parseDurationInput("10")).toThrow(WhenParseError);
    expect(() => parseDurationInput("10")).toThrow("Duration must be between 15 and 480 minutes.");
    expect(() => parseDurationInput("9h")).toThrow("Duration must be between 15 and 480 minutes.");
    expect(() => parseDurationInput("0")).toThrow("Duration must be between 15 and 480 minutes.");
    expect(() => parseDurationInput("20.5")).toThrow(/whole number/i);
    expect(() => parseDurationInput("a while")).toThrow(/couldn't read that duration/i);
    expect(() => parseDurationInput("soon")).toThrow(WhenParseError);
  });
});
