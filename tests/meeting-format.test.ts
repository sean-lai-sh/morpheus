import { describe, expect, test } from "bun:test";
import {
  discordTimestamp,
  draftPreview,
  formatDuration,
  meetingWhenLine,
} from "../src/coordinator/meeting-format.ts";

const START = Date.UTC(2026, 8, 4, 18, 0, 0); // 2026-09-04 18:00Z

describe("discordTimestamp", () => {
  test("emits seconds, not milliseconds", () => {
    expect(discordTimestamp(START, "F")).toBe(`<t:${START / 1000}:F>`);
  });

  test("floors sub-second precision rather than emitting a fraction", () => {
    expect(discordTimestamp(START + 999, "R")).toBe(`<t:${START / 1000}:R>`);
  });
});

describe("formatDuration", () => {
  test("minutes below an hour", () => {
    expect(formatDuration(15)).toBe("15m");
    expect(formatDuration(45)).toBe("45m");
  });

  test("whole hours drop the minutes", () => {
    expect(formatDuration(60)).toBe("1h");
    expect(formatDuration(120)).toBe("2h");
  });

  test("mixed renders both parts", () => {
    expect(formatDuration(90)).toBe("1h30m");
    expect(formatDuration(480)).toBe("8h");
  });
});

describe("meetingWhenLine", () => {
  test("carries absolute, relative, and duration", () => {
    const line = meetingWhenLine(START, 60);
    expect(line).toContain(`<t:${START / 1000}:F>`);
    // The relative form is what makes a mistyped year obvious at a glance.
    expect(line).toContain(`<t:${START / 1000}:R>`);
    expect(line).toContain("1h");
  });
});

describe("draftPreview", () => {
  test("echoes the raw input beside the parsed time", () => {
    const out = draftPreview({
      title: "Eboard sync",
      startsAtMs: START,
      durationMinutes: 60,
      rawWhen: "friday 2pm",
      notes: null,
    });
    expect(out).toContain("**Eboard sync**");
    expect(out).toContain(`<t:${START / 1000}:F>`);
    // The echo is the whole safety story for a forgiving parser.
    expect(out).toContain('read as "friday 2pm"');
  });

  test("notes are quoted, and multi-line notes stay quoted on every line", () => {
    const out = draftPreview({
      title: "T",
      startsAtMs: START,
      durationMinutes: 30,
      rawWhen: "tomorrow 3pm",
      notes: "bring laptops\nagenda in drive",
    });
    expect(out).toContain("> bring laptops");
    expect(out).toContain("> agenda in drive");
  });

  test("absent notes add no stray quote line", () => {
    const out = draftPreview({
      title: "T",
      startsAtMs: START,
      durationMinutes: 30,
      rawWhen: "tomorrow 3pm",
      notes: null,
    });
    // Not a bare `>` check -- the timestamp markup contains one. What matters is
    // that no line is a blockquote.
    expect(out.split("\n").some((line) => line.startsWith(">"))).toBe(false);
  });
});
