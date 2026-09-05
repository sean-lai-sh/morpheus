export const TASK_REMINDER_POLICIES = [
  "daily_until_done",
  "one_day_before",
  "one_hour_before",
  "one_day_and_five_hours",
  "none",
] as const;

export type TaskReminderPolicy = (typeof TASK_REMINDER_POLICIES)[number];
export type DualReminderSlot = "one_day" | "five_hours";

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const FIVE_HOURS_MS = 5 * 60 * 60_000;

export function isTaskReminderPolicy(value: unknown): value is TaskReminderPolicy {
  return typeof value === "string" && (TASK_REMINDER_POLICIES as readonly string[]).includes(value);
}

export function effectiveTaskReminderPolicy(
  override: TaskReminderPolicy | undefined,
  preference: TaskReminderPolicy | undefined,
): TaskReminderPolicy {
  return override ?? preference ?? "daily_until_done";
}

/**
 * Returns the first occurrence at or after now. An already-missed reminder
 * becomes an immediate catch-up notification instead of disappearing.
 */
export function nextTaskReminderAt(input: {
  policy: TaskReminderPolicy;
  dueAt?: Date;
  now?: Date;
  after?: Date;
}): Date | undefined {
  if (!input.dueAt || input.policy === "none") return undefined;
  const now = input.now ?? new Date();
  if (input.policy === "one_day_before" || input.policy === "one_day_and_five_hours") {
    return atOrNow(new Date(input.dueAt.getTime() - DAY_MS), now);
  }
  if (input.policy === "one_hour_before") return atOrNow(new Date(input.dueAt.getTime() - HOUR_MS), now);

  const first = new Date(input.dueAt.getTime() - DAY_MS);
  if (!input.after) return atOrNow(first, now);
  const next = new Date(input.after.getTime() + DAY_MS);
  return next > now ? next : now;
}

function atOrNow(candidate: Date, now: Date): Date {
  return candidate > now ? candidate : now;
}

export function isRecurringTaskReminder(policy: TaskReminderPolicy): boolean {
  return policy === "daily_until_done";
}

export function formatReminderPolicy(policy: TaskReminderPolicy): string {
  return {
    daily_until_done: "daily until done",
    one_day_before: "one day before due",
    one_hour_before: "one hour before due",
    one_day_and_five_hours: "1 day and 5 hours before due",
    none: "no reminders",
  }[policy];
}

export function dualReminderSlots(
  dueAt: Date,
  now: Date = new Date(),
): Array<{ slot: DualReminderSlot; at: Date }> {
  return [
    { slot: "one_day", at: atOrNow(new Date(dueAt.getTime() - DAY_MS), now) },
    { slot: "five_hours", at: atOrNow(new Date(dueAt.getTime() - FIVE_HOURS_MS), now) },
  ];
}

/**
 * The slot to fire NEXT, skipping any that already elapsed. Without this a todo
 * created inside the window (`add a todo ... by friday 2pm`, said Friday
 * morning) immediately posts a channel ping labelled "1-day reminder", because
 * `dualReminderSlots` clamps a past slot to now. Under five hours out, the
 * five-hour slot fires now under its own honest label; past due, nothing.
 */
export function nextDualReminderSlot(
  dueAt: Date,
  now: Date = new Date(),
): { slot: DualReminderSlot; at: Date } | null {
  // Raw offsets, not `dualReminderSlots` -- that one clamps a past slot to now,
  // which is exactly the elapsed case this has to skip. `>=` so firing exactly
  // at T-1d still uses the one-day slot.
  const raw: Array<{ slot: DualReminderSlot; at: Date }> = [
    { slot: "one_day", at: new Date(dueAt.getTime() - DAY_MS) },
    { slot: "five_hours", at: new Date(dueAt.getTime() - FIVE_HOURS_MS) },
  ];
  const upcoming = raw.find((entry) => entry.at.getTime() >= now.getTime());
  if (upcoming) return upcoming;
  if (dueAt.getTime() <= now.getTime()) return null;
  return { slot: "five_hours", at: new Date(now.getTime()) };
}

export function isDualReminderSlot(value: unknown): value is DualReminderSlot {
  return value === "one_day" || value === "five_hours";
}
