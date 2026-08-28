import { dateInTimeZone } from "./audience.ts";

/** Thrown with a message safe to show the user verbatim in Discord. */
export class WhenParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhenParseError";
  }
}

/*
 * Grammar for the explicit "When" modal field. This parser only ever runs on a
 * field a human deliberately typed into, and its result is echoed back for
 * confirmation before anything is booked — but it still refuses to guess.
 * The old src/coordinator/when.ts sniffed ordinary chat and turned
 * "monday, I need 2 revisions" into a 02:00 booking; the rule below ("a bare
 * number is never a time") is the direct descendant of that bug.
 *
 *   when   := [ "at" | "on" ] date time
 *   date   := "today" | "tomorrow" | "tmr" | "tmrw"
 *           | [ "next" | "this" | "coming" ] weekday
 *           | month day [ year ] | day month [ year ]
 *           | MM "/" DD [ "/" YY(YY) ]        (US order — see below)
 *           | YYYY "-" MM "-" DD
 *   time   := H[:MM] ( "am" | "pm" | "a" | "p" )   -- 12-hour
 *           | H:MM                                 -- 24-hour clock
 *
 * Deliberately NOT accepted (each would be a guess):
 *   - a bare number with no colon and no meridiem ("3", "friday 3")
 *   - a time with no day ("2pm") — could mean today or tomorrow
 *   - a day with no time ("friday") — no defensible default hour
 *   - DD/MM order: "9/4" is September 4. This is a US university org, and
 *     slash dates are the one genuinely ambiguous convention here, so we pin
 *     US order rather than sniff. Users who want the other order can type a
 *     month name ("4 sep 2pm") or an ISO date.
 */

const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;

const EXAMPLE = "Try `friday 2pm`, `tomorrow 3:30pm`, `sep 4 2pm`, or `2026-09-04 14:00`.";
const BLANK = `Enter a start time. ${EXAMPLE}`;
const UNPARSEABLE = `I couldn't read that start time. ${EXAMPLE}`;
const NEEDS_DAY = `I need a day as well as a time. ${EXAMPLE}`;
const BARE_NUMBER =
  "I couldn't tell what time you meant — add am/pm or use a 24-hour clock, like `2pm` or `14:00`. " +
  "A bare number like `3` is too easy to get wrong, so I won't guess at it.";
const BAD_TIME = "That isn't a time I recognize. Use something like `2pm`, `2:30pm`, or `14:00`.";
const BAD_DATE = "That date isn't on the calendar. Check the day and month, like `sep 4 2pm`.";
const NOT_FUTURE = "Meeting start time must be in the future.";
const TOO_FAR = "That start time is more than a year away — check the year and try again.";

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  weds: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

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

const WEEKDAY_ALT = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join("|");
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

interface Ymd {
  year: number;
  month: number;
  day: number;
}

interface Clock {
  hour: number;
  minute: number;
}

/** Calendar date "now" falls on in `timeZone`. */
function calendarDateInZone(epochMs: number, timeZone: string): Ymd {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const year = values.year;
  const month = values.month;
  const day = values.day;
  if (year === undefined || month === undefined || day === undefined) throw new WhenParseError(UNPARSEABLE);
  return { year, month, day };
}

/** Pure calendar arithmetic — never epoch-ms arithmetic, so DST can't shift the day. */
function addDays(ymd: Ymd, days: number): Ymd {
  const moved = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

function weekdayOf(ymd: Ymd): number {
  return new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day)).getUTCDay();
}

function isRealDate(ymd: Ymd): boolean {
  if (ymd.month < 1 || ymd.month > 12 || ymd.day < 1 || ymd.day > 31) return false;
  const probe = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
  return (
    probe.getUTCFullYear() === ymd.year &&
    probe.getUTCMonth() === ymd.month - 1 &&
    probe.getUTCDate() === ymd.day
  );
}

function formatYmd(ymd: Ymd): string {
  return `${String(ymd.year).padStart(4, "0")}-${String(ymd.month).padStart(2, "0")}-${String(ymd.day).padStart(2, "0")}`;
}

/** Compare calendar dates only (no clock), for "has this date already passed?". */
function compareYmd(a: Ymd, b: Ymd): number {
  return (
    Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)
  );
}

/**
 * Wall clock -> instant. Every conversion in this file goes through
 * `dateInTimeZone` so a 2pm meeting is 2pm local on both sides of a DST change.
 */
function toInstant(ymd: Ymd, clock: Clock, timeZone: string): Date {
  if (!isRealDate(ymd)) throw new WhenParseError(BAD_DATE);
  try {
    return dateInTimeZone(formatYmd(ymd), clock.hour, clock.minute, timeZone);
  } catch {
    throw new WhenParseError(BAD_DATE);
  }
}

/**
 * Trailing time. `(?:^|\s)` keeps the day number of "9/4" or "sep 4" from being
 * read as a time; the meridiem is optional here only so we can reject a bare
 * number with a message that explains itself.
 */
const TIME_TAIL = /(?:^|\s)(?:(?:at|@)\s*)?(\d{1,2})(?::(\d{2}))?\s*(a\.m\.|p\.m\.|am|pm|a|p)?$/;

function readClock(match: RegExpExecArray): Clock {
  const rawHour = Number(match[1]);
  const rawMinute = match[2];
  const meridiem = match[3]?.replace(/\./g, "");
  if (!meridiem && rawMinute === undefined) throw new WhenParseError(BARE_NUMBER);
  const minute = rawMinute === undefined ? 0 : Number(rawMinute);
  if (minute > 59) throw new WhenParseError(BAD_TIME);
  if (meridiem) {
    if (rawHour < 1 || rawHour > 12) throw new WhenParseError(BAD_TIME);
    const isPm = meridiem.startsWith("p");
    const hour = isPm ? (rawHour === 12 ? 12 : rawHour + 12) : rawHour === 12 ? 0 : rawHour;
    return { hour, minute };
  }
  // No meridiem but a colon is present: 24-hour clock. "2:30" is 02:30, not 14:30.
  if (rawHour > 23) throw new WhenParseError(BAD_TIME);
  return { hour: rawHour, minute };
}

/**
 * Plain weekday = the next occurrence strictly after `now`. If today IS that
 * weekday and the time has not passed yet, plain means today.
 * `next <weekday>` = exactly 7 days after the plain reading, so when they would
 * land on the same day (today is Friday, 2pm still ahead) "friday 2pm" is today
 * and "next friday 2pm" is a week out.
 */
function resolveWeekday(name: string, bump: boolean, clock: Clock, timeZone: string, now: number): Date {
  const target = WEEKDAYS[name];
  if (target === undefined) throw new WhenParseError(UNPARSEABLE);
  const today = calendarDateInZone(now, timeZone);
  let ahead = (target - weekdayOf(today) + 7) % 7;
  if (ahead === 0 && toInstant(today, clock, timeZone).getTime() <= now) ahead = 7;
  if (bump) ahead += 7;
  return toInstant(addDays(today, ahead), clock, timeZone);
}

/** No year given: this year, or next year if that date has already gone by. */
function resolveYearless(month: number, day: number, clock: Clock, timeZone: string, now: number): Date {
  const today = calendarDateInZone(now, timeZone);
  const thisYear: Ymd = { year: today.year, month, day };
  if (!isRealDate(thisYear)) throw new WhenParseError(BAD_DATE);
  const candidate = compareYmd(thisYear, today) < 0 ? { ...thisYear, year: today.year + 1 } : thisYear;
  return toInstant(candidate, clock, timeZone);
}

function expandYear(raw: string): number {
  const value = Number(raw);
  return raw.length === 2 ? 2000 + value : value;
}

function resolveDatePart(datePart: string, clock: Clock, timeZone: string, now: number): Date {
  if (/^(?:today|tonite|tonight)$/.test(datePart)) {
    return toInstant(calendarDateInZone(now, timeZone), clock, timeZone);
  }
  if (/^(?:tomorrow|tomorow|tmrw|tmr)$/.test(datePart)) {
    return toInstant(addDays(calendarDateInZone(now, timeZone), 1), clock, timeZone);
  }

  const weekday = new RegExp(`^(?:(next|this|coming)\\s+)?(${WEEKDAY_ALT})$`).exec(datePart);
  if (weekday) return resolveWeekday(weekday[2]!, weekday[1] === "next", clock, timeZone, now);

  const monthFirst = new RegExp(
    `^(${MONTH_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?$`,
  ).exec(datePart);
  const dayFirst = new RegExp(
    `^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALT})(?:\\s+(\\d{4}))?$`,
  ).exec(datePart);
  const named = monthFirst
    ? { month: MONTHS[monthFirst[1]!]!, day: Number(monthFirst[2]), year: monthFirst[3] }
    : dayFirst
      ? { month: MONTHS[dayFirst[2]!]!, day: Number(dayFirst[1]), year: dayFirst[3] }
      : null;
  if (named) {
    return named.year
      ? toInstant({ year: Number(named.year), month: named.month, day: named.day }, clock, timeZone)
      : resolveYearless(named.month, named.day, clock, timeZone, now);
  }

  // US order: MM/DD and MM/DD/YYYY.
  const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(datePart);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    return slash[3]
      ? toInstant({ year: expandYear(slash[3]), month, day }, clock, timeZone)
      : resolveYearless(month, day, clock, timeZone, now);
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(datePart);
  if (iso) {
    return toInstant({ year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }, clock, timeZone);
  }

  throw new WhenParseError(UNPARSEABLE);
}

/** The two shapes `parseMeetingStart` accepts today, so nothing regresses. */
function parseAbsoluteForm(trimmed: string, timeZone: string): Date | null {
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const iso = new Date(trimmed);
    if (!Number.isNaN(iso.valueOf())) return iso;
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ tT](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(trimmed);
  if (!match) return null;
  return toInstant(
    { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
    { hour: Number(match[4]), minute: Number(match[5]) },
    timeZone,
  );
}

function parseRelaxedForm(trimmed: string, timeZone: string, now: number): Date {
  const text = trimmed
    .toLowerCase()
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:at|on)\s+/, "")
    .trim();
  const timeMatch = TIME_TAIL.exec(text);
  if (!timeMatch) throw new WhenParseError(UNPARSEABLE);
  const clock = readClock(timeMatch);
  const datePart = text
    .slice(0, timeMatch.index)
    .trim()
    .replace(/\s+(?:at|on|@)$/, "")
    .trim();
  if (!datePart) throw new WhenParseError(NEEDS_DAY);
  return resolveDatePart(datePart, clock, timeZone, now);
}

/**
 * Parse an explicit "When" field to an absolute instant.
 * @param raw   user text
 * @param timeZone IANA zone the wall-clock text is interpreted in
 * @param now   epoch ms, injectable for tests
 */
export function parseWhenInput(raw: string, timeZone: string, now: number = Date.now()): Date {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new WhenParseError(BLANK);
  const startsAt = parseAbsoluteForm(trimmed, timeZone) ?? parseRelaxedForm(trimmed, timeZone, now);
  if (startsAt.getTime() <= now) throw new WhenParseError(NOT_FUTURE);
  if (startsAt.getTime() - now > MAX_FUTURE_MS) throw new WhenParseError(TOO_FAR);
  return startsAt;
}

const MIN_DURATION_MINUTES = 15;
const MAX_DURATION_MINUTES = 480;
const DURATION_RANGE = `Duration must be between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes.`;
const DURATION_SHAPE =
  "I couldn't read that duration. Use minutes or hours, like `30`, `45 min`, `1h`, or `1h30`.";
const DURATION_WHOLE = "Duration has to be a whole number of minutes, like `30` or `1h30`.";

const HOURS_AND_MINUTES = /^(\d{1,3})\s*(?:h|hr|hrs|hour|hours)\s*(?:and\s+)?(\d{1,3})\s*(?:m|min|mins|minute|minutes)?$/;
const HOURS_ONLY = /^(\d{1,3}(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)$/;
const MINUTES_ONLY = /^(\d{1,4}(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)?$/;

function checkedDuration(minutes: number): number {
  if (!Number.isFinite(minutes)) throw new WhenParseError(DURATION_SHAPE);
  if (!Number.isInteger(minutes)) throw new WhenParseError(DURATION_WHOLE);
  if (minutes < MIN_DURATION_MINUTES || minutes > MAX_DURATION_MINUTES) {
    throw new WhenParseError(DURATION_RANGE);
  }
  return minutes;
}

/** Parse a "Duration" field to minutes. Blank => `defaultMinutes`. */
export function parseDurationInput(raw: string, defaultMinutes: number = 30): number {
  const text = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return checkedDuration(defaultMinutes);

  const split = HOURS_AND_MINUTES.exec(text);
  if (split) return checkedDuration(Number(split[1]) * 60 + Number(split[2]));

  const hours = HOURS_ONLY.exec(text);
  if (hours) return checkedDuration(Number(hours[1]) * 60);

  const minutes = MINUTES_ONLY.exec(text);
  if (minutes) return checkedDuration(Number(minutes[1]));

  throw new WhenParseError(DURATION_SHAPE);
}
