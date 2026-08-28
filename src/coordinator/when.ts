import { dateInTimeZone, parseMeetingStart } from "./audience.ts";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export interface ParsedWhen {
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
}

function parseClock(raw: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(raw.trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const mer = match[3]?.toLowerCase();
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function nextWeekday(from: Date, weekday: number, hour: number, minute: number, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(from);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((p) => [p.type, p.value]));
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const todayIdx = weekdayNames.indexOf(values.weekday ?? "Sun");
  let add = (weekday - todayIdx + 7) % 7;
  const ymd = `${values.year}-${values.month}-${values.day}`;
  let candidate = dateInTimeZone(ymd, hour, minute, timeZone);
  if (add === 0 && candidate.getTime() <= from.getTime()) add = 7;
  if (add > 0) {
    const base = new Date(`${ymd}T00:00:00Z`);
    base.setUTCDate(base.getUTCDate() + add);
    const next = `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}-${String(base.getUTCDate()).padStart(2, "0")}`;
    candidate = dateInTimeZone(next, hour, minute, timeZone);
  }
  return candidate;
}

/**
 * Thin mention parser: ISO / YYYY-MM-DD HH:mm, weekday + time, or month-day + time.
 * Default duration 60 minutes. Not the fat #85 locked-field parser.
 */
export function parseAbsoluteWhen(
  content: string,
  now: Date = new Date(),
  timeZone = "America/New_York",
): ParsedWhen | null {
  const iso = /\b(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)\b/.exec(content);
  if (iso?.[1]) {
    const raw = /[ T]\d/.test(iso[1]) ? iso[1] : `${iso[1]} 15:00`;
    try {
      const startsAt = parseMeetingStart(raw, timeZone, now.getTime());
      return { startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60_000), timeZone };
    } catch {
      /* try softer patterns */
    }
  }

  const dayPat = "sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat";
  const weekdayFirst = new RegExp(
    `\\b(${dayPat})\\b[^0-9]{0,12}(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)`,
    "i",
  ).exec(content);
  const timeFirst = new RegExp(
    `(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm))\\s+\\b(${dayPat})\\b`,
    "i",
  ).exec(content);
  const dayRaw = (weekdayFirst?.[1] ?? timeFirst?.[2])?.toLowerCase();
  const timeRaw = weekdayFirst?.[2] ?? timeFirst?.[1];
  if (dayRaw && timeRaw) {
    const clock = parseClock(timeRaw);
    const dayName = WEEKDAYS.find((d) => d === dayRaw || d.startsWith(dayRaw.slice(0, 3)));
    if (clock && dayName) {
      const startsAt = nextWeekday(now, WEEKDAYS.indexOf(dayName), clock.hour, clock.minute, timeZone);
      if (startsAt.getTime() > now.getTime()) {
        return { startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60_000), timeZone };
      }
    }
  }

  const monthHit =
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s|,)+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i.exec(
      content,
    );
  if (monthHit) {
    const month = MONTHS[monthHit[1]!.toLowerCase()];
    const day = Number(monthHit[2]);
    const clock = parseClock(monthHit[3]!);
    if (month && day >= 1 && day <= 31 && clock) {
      const year = now.getFullYear();
      const ymd = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      try {
        let startsAt = dateInTimeZone(ymd, clock.hour, clock.minute, timeZone);
        if (startsAt.getTime() <= now.getTime()) {
          startsAt = dateInTimeZone(
            `${year + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
            clock.hour,
            clock.minute,
            timeZone,
          );
        }
        return { startsAt, endsAt: new Date(startsAt.getTime() + 60 * 60_000), timeZone };
      } catch {
        return null;
      }
    }
  }

  return null;
}
