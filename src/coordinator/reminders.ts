export const TASK_REMINDER_POLICIES = [
  "daily_until_done",
  "one_day_before",
  "one_hour_before",
  "none",
] as const;

export type TaskReminderPolicy = (typeof TASK_REMINDER_POLICIES)[number];

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

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
  if (input.policy === "one_day_before") return atOrNow(new Date(input.dueAt.getTime() - DAY_MS), now);
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
    none: "no reminders",
  }[policy];
}
