import { describe, expect, test } from "bun:test";
import {
  effectiveTaskReminderPolicy,
  isRecurringTaskReminder,
  nextTaskReminderAt,
} from "../src/coordinator/reminders.ts";

describe("task reminder policy", () => {
  const dueAt = new Date("2026-09-10T17:00:00Z");
  const now = new Date("2026-09-01T12:00:00Z");

  test("uses the assignee override before the personal default", () => {
    expect(effectiveTaskReminderPolicy("one_hour_before", "daily_until_done")).toBe("one_hour_before");
    expect(effectiveTaskReminderPolicy(undefined, "one_day_before")).toBe("one_day_before");
    expect(effectiveTaskReminderPolicy(undefined, undefined)).toBe("daily_until_done");
  });

  test("does not schedule undated or disabled tasks", () => {
    expect(nextTaskReminderAt({ policy: "daily_until_done", now })).toBeUndefined();
    expect(nextTaskReminderAt({ policy: "none", dueAt, now })).toBeUndefined();
  });

  test("schedules one-time and recurring policies at their defined boundaries", () => {
    expect(nextTaskReminderAt({ policy: "one_day_before", dueAt, now })?.toISOString()).toBe(
      "2026-09-09T17:00:00.000Z",
    );
    expect(nextTaskReminderAt({ policy: "one_hour_before", dueAt, now })?.toISOString()).toBe(
      "2026-09-10T16:00:00.000Z",
    );
    const first = nextTaskReminderAt({ policy: "daily_until_done", dueAt, now });
    expect(first?.toISOString()).toBe("2026-09-09T17:00:00.000Z");
    expect(nextTaskReminderAt({ policy: "daily_until_done", dueAt, after: first!, now })?.toISOString()).toBe(
      "2026-09-10T17:00:00.000Z",
    );
    expect(isRecurringTaskReminder("daily_until_done")).toBe(true);
    expect(isRecurringTaskReminder("one_day_before")).toBe(false);
    expect(nextTaskReminderAt({ policy: "one_day_and_five_hours", dueAt, now })?.toISOString()).toBe(
      "2026-09-09T17:00:00.000Z",
    );
  });

  test("turns an already missed reminder into a catch-up notification", () => {
    const late = new Date("2026-09-10T16:30:00Z");
    expect(nextTaskReminderAt({ policy: "one_hour_before", dueAt, now: late })?.toISOString()).toBe(
      late.toISOString(),
    );
  });
});
