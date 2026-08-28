import { dateInTimeZone } from "./audience.ts";
import type { CalendarTarget, MeetingAudienceKind, MeetingRecurrence } from "./identity.ts";
import { stripEmails } from "./identity.ts";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const TZ_ALIASES: Record<string, string> = {
  et: "America/New_York",
  est: "America/New_York",
  edt: "America/New_York",
  ny: "America/New_York",
  nyc: "America/New_York",
  eastern: "America/New_York",
  pt: "America/Los_Angeles",
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  ct: "America/Chicago",
  cst: "America/Chicago",
  cdt: "America/Chicago",
  utc: "UTC",
  gmt: "UTC",
};

/** Eboard Discord role in JOB_TRIGGER_ROLE_IDS. Role mention + F26 sheet = whole tab. */
export const EBOARD_ROLE_ID = "1203562091500404782";
export const F26_SHEET_GID = "1079418365";
export const DEFAULT_MEETING_LOCATION = "TBD";
export const WEEKLY_UNTIL_DEFAULT = "2026-12-15";

export const SLASH_LOCKED_FIELDS = [
  "title",
  "start",
  "duration",
  "timezone",
  "calendar",
  "recurrence",
  "location",
  "conference",
  "attendees",
] as const;

export type MeetingLockedField = (typeof SLASH_LOCKED_FIELDS)[number];

const BOOK_VERB = /\b(book|schedule|set\s*up|create|make)\b/i;
const MEET_NOUN = /\b(meet(?:ing)?s?|call|sync|eboard|cal(?:endar)?\s+invite|invite)\b/i;
const MEET_WITH = /\bmeet(?:ing)?\s+with\b/i;
const CAL_INVITE = /\bcal(?:endar)?\s+invite\b/i;
const TIMEISH =
  /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}\s*[-–]\s*\d{1,2}\s*(?:am|pm)|tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekly|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

const STOP_NAMES = new Set([
  "a",
  "an",
  "the",
  "me",
  "us",
  "our",
  "my",
  "please",
  "tomorrow",
  "today",
  "tonight",
  "meeting",
  "meet",
  "call",
  "sync",
  "eboard",
  "board",
  "f26",
  "s26",
  "roster",
  "weekly",
  "every",
  "this",
  "next",
  "at",
  "on",
  "for",
  "and",
  "or",
  "with",
  "am",
  "pm",
  "et",
  "est",
  "edt",
  "pt",
  "pst",
  "friday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "saturday",
  "sunday",
  "invite",
  "discord",
  "role",
  "contact",
  "sheet",
  "gid",
  "via",
  "cal",
  "calendar",
  "make",
  "create",
  "sept",
  "sep",
  "september",
]);

export interface ParsedMeetingRequest {
  title: string;
  startsAt: number;
  durationMinutes: number;
  timeZone: string;
  notes: string | null;
  calendar: CalendarTarget;
  conference: boolean;
  recurrence: MeetingRecurrence;
  recurrenceUntil: string | null;
  location: string;
  audienceKind: MeetingAudienceKind;
  requestedNames: string[];
  parseIncomplete: boolean;
  sourceText: string;
  locked: MeetingLockedField[];
}

export function stripBotMentions(text: string, botUserId?: string): string {
  let out = text.replace(/<@!?\d+>/g, " ");
  if (botUserId) out = out.replaceAll(botUserId, " ");
  return out.replace(/\s+/g, " ").trim();
}

export function isMeetingIntent(text: string, botUserId?: string): boolean {
  const t = stripBotMentions(text, botUserId);
  if (!t) return false;
  if (CAL_INVITE.test(t)) return true;
  if (MEET_WITH.test(t)) return true;
  if (BOOK_VERB.test(t) && MEET_NOUN.test(t)) return true;
  if (/\beboard\b/i.test(t) && TIMEISH.test(t) && (BOOK_VERB.test(t) || /\b(meet|meeting|invite)\b/i.test(t))) {
    return true;
  }
  return false;
}

export function parseMeetingRequest(
  raw: string,
  opts: { now?: number; botUserId?: string; source?: "slash" | "mention" } = {},
): ParsedMeetingRequest | null {
  if (!isMeetingIntent(raw, opts.botUserId)) return null;
  const now = opts.now ?? Date.now();
  const sourceText = stripEmails(stripBotMentions(raw, opts.botUserId)).slice(0, 2000);
  const timeZone = detectTimeZone(sourceText);
  const audienceKind = detectAudienceKind(sourceText);
  const calendar = detectCalendar(sourceText, audienceKind);
  const conference = !/\b(no meet|without meet|no(?:\s+google)?\s*(?:meet|link)|skip meet)\b/i.test(sourceText);
  const hasSpecificDate = parseMonthDay(sourceText, timeZone, now) != null;
  const recurrence = detectRecurrence(sourceText, audienceKind, hasSpecificDate);
  const range = parseTimeRange(sourceText);
  const durationMinutes = range?.durationMinutes ?? detectDuration(sourceText);
  const requestedNames = audienceKind === "f26_roster" ? [] : extractRequestedNames(sourceText);
  const parsedStart = parseNaturalStart(sourceText, timeZone, now);
  const parseIncomplete = parsedStart == null;
  const startsAt = parsedStart ?? defaultStart(audienceKind, timeZone, now);
  const title = inferTitle(sourceText, audienceKind, requestedNames);
  const location = detectLocation(sourceText, audienceKind, calendar);
  const recurrenceUntil = recurrence === "weekly" ? detectUntil(sourceText, timeZone, now) : null;
  const locked = inferLockedFields({
    source: opts.source ?? "mention",
    parseIncomplete,
    audienceKind,
  });

  return {
    title,
    startsAt,
    durationMinutes,
    timeZone,
    notes: sourceText || null,
    calendar,
    conference,
    recurrence,
    recurrenceUntil,
    location,
    audienceKind,
    requestedNames,
    parseIncomplete,
    sourceText,
    locked,
  };
}

function detectTimeZone(text: string): string {
  const match = /\b(et|est|edt|pt|pst|pdt|ct|cst|cdt|utc|gmt|ny|nyc|eastern)\b/i.exec(text);
  if (!match?.[1]) return "America/New_York";
  return TZ_ALIASES[match[1].toLowerCase()] ?? "America/New_York";
}

export function detectAudienceKind(text: string): MeetingAudienceKind {
  if (/<@&\d+>/.test(text)) return "f26_roster";
  if (new RegExp(`\\bgid[=:]?\\s*${F26_SHEET_GID}\\b`, "i").test(text)) return "f26_roster";
  if (/docs\.google\.com\/spreadsheets/i.test(text)) return "f26_roster";
  if (/\b(f26|contact sheet|eboard|board roster|the roster|whole board|full board)\b/i.test(text)) {
    return "f26_roster";
  }
  return "picked";
}

function detectCalendar(text: string, audience: MeetingAudienceKind): CalendarTarget {
  if (audience === "f26_roster") return "eboard";
  if (/\b(leadership|hello@)\b/i.test(text)) return "leadership";
  return "eboard";
}

function detectRecurrence(
  text: string,
  audience: MeetingAudienceKind,
  hasSpecificDate: boolean,
): MeetingRecurrence {
  if (/\b(weekly|every week|every friday|recurring)\b/i.test(text)) return "weekly";
  if (hasSpecificDate) return "none";
  if (/\b(once|one[- ]time|this (week|friday|monday|tuesday|wednesday|thursday)|tomorrow|today)\b/i.test(text)) {
    return "none";
  }
  if (audience === "f26_roster" && /\bfriday\b/i.test(text)) return "weekly";
  return "none";
}

function detectDuration(text: string): number {
  const hours = /\b(\d+(?:\.\d+)?)\s*(?:hour|hr)s?\b/i.exec(text);
  if (hours?.[1]) {
    const minutes = Math.round(Number(hours[1]) * 60);
    return clampDuration(minutes);
  }
  const minutes = /\b(\d+)\s*(?:min|minute)s?\b/i.exec(text);
  if (minutes?.[1]) return clampDuration(Number(minutes[1]));
  return 60;
}

function clampDuration(minutes: number): number {
  if (!Number.isFinite(minutes)) return 60;
  return Math.min(480, Math.max(15, Math.round(minutes)));
}

function detectLocation(text: string, audience: MeetingAudienceKind, calendar: CalendarTarget): string {
  const labeled = /\b(?:location|room|place)\s*[:=]\s*([^,.\n]{1,80})/i.exec(text);
  if (labeled?.[1]) return labeled[1].trim().slice(0, 80);
  if (audience === "f26_roster" || calendar === "eboard") return DEFAULT_MEETING_LOCATION;
  return DEFAULT_MEETING_LOCATION;
}

function detectUntil(text: string, timeZone: string, now: number): string {
  const iso = /\buntil\s+(\d{4}-\d{2}-\d{2})\b/i.exec(text);
  if (iso?.[1]) return iso[1];
  const monthDay = /\buntil\s+([A-Za-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?)/i.exec(text);
  if (monthDay?.[1]) {
    const day = parseMonthDay(monthDay[1], timeZone, now);
    if (day) return day;
  }
  return WEEKLY_UNTIL_DEFAULT;
}

function inferTitle(text: string, audience: MeetingAudienceKind, names: string[]): string {
  if (audience === "f26_roster") return "Tech@NYU Eboard";
  const quoted = /["“]([^"”]{2,80})["”]/.exec(text);
  if (quoted?.[1]) return quoted[1].trim();
  if (names.length > 0) return `Meeting with ${names.join(" and ")}`.slice(0, 100);
  const about = /\b(?:about|called|titled)\s+([^.,]{3,80})/i.exec(text);
  if (about?.[1]) return about[1].trim().slice(0, 100);
  return "Meeting";
}

export function extractRequestedNames(text: string): string[] {
  const withClause = /\b(?:with|invite)\s+(.+)$/i.exec(text);
  const clause = withClause?.[1] ?? "";
  if (!clause) return [];
  if (/<@&\d+>|contact sheet|f26|gid\s*1079418365|eboard discord role/i.test(clause)) return [];
  const cleaned = clause
    .replace(/\b(tomorrow|today|tonight|next|this|on|at|for|weekly|every|eboard|f26)\b/gi, " ")
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, " ")
    .replace(/\b(et|est|edt|pt|pst|am|pm)\b/gi, " ")
    .replace(/[<>@!&]/g, " ");
  const parts = cleaned
    .split(/\s*(?:,|and|&)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !STOP_NAMES.has(part.toLowerCase()) && !/^\d+$/.test(part));
  const names: string[] = [];
  for (const part of parts) {
    const tokens = part.split(/\s+/).filter((token) => !STOP_NAMES.has(token.toLowerCase()));
    if (tokens.length === 0 || tokens.length > 3) continue;
    const name = tokens.join(" ");
    if (!names.some((existing) => existing.toLowerCase() === name.toLowerCase())) names.push(name.slice(0, 80));
  }
  return names.slice(0, 25);
}

function defaultStart(audience: MeetingAudienceKind, timeZone: string, now: number): number {
  const base = new Date(now);
  if (audience === "f26_roster") {
    return weekdayAt(5, 18, 30, timeZone, now);
  }
  return dateInTimeZone(ymd(base, timeZone), 18, 30, timeZone).getTime() + 24 * 60 * 60_000;
}

export function parseNaturalStart(text: string, timeZone: string, now: number): number | null {
  const time = parseClock(text);
  if (!time) return null;
  const day = parseDay(text, timeZone, now);
  if (!day) return null;
  const startsAt = dateInTimeZone(day, time.hour, time.minute, timeZone);
  if (startsAt.getTime() <= now) {
    if (/\b(today|tonight)\b/i.test(text)) return null;
    if (parseMonthDay(text, timeZone, now)) return null;
    const plusWeek = new Date(startsAt.getTime() + 7 * 24 * 60 * 60_000);
    if (plusWeek.getTime() > now) return plusWeek.getTime();
    return null;
  }
  return startsAt.getTime();
}

function parseTimeRange(text: string): { hour: number; minute: number; durationMinutes: number } | null {
  const mer = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (mer?.[1] && mer[4] && mer[6]) {
    const endMeridiem = mer[6].toLowerCase();
    const startMeridiem = (mer[3] ?? mer[6]).toLowerCase();
    const start = toClock(Number(mer[1]), Number(mer[2] ?? "0"), startMeridiem);
    const end = toClock(Number(mer[4]), Number(mer[5] ?? "0"), endMeridiem);
    if (!start || !end) return null;
    let duration = (end.hour * 60 + end.minute) - (start.hour * 60 + start.minute);
    if (duration <= 0) duration += 12 * 60;
    return { ...start, durationMinutes: clampDuration(duration) };
  }
  const military = /\b(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\b/.exec(text);
  if (military?.[1] && military[3]) {
    const startHour = Number(military[1]);
    const startMinute = Number(military[2]);
    const endHour = Number(military[3]);
    const endMinute = Number(military[4]);
    if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return null;
    let duration = (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
    if (duration <= 0) return null;
    return { hour: startHour, minute: startMinute, durationMinutes: clampDuration(duration) };
  }
  return null;
}

function toClock(hour: number, minute: number, meridiem: string): { hour: number; minute: number } | null {
  let h = hour;
  if (h === 12) h = meridiem === "am" ? 0 : 12;
  else if (meridiem === "pm") h += 12;
  if (h > 23 || minute > 59) return null;
  return { hour: h, minute };
}

function parseClock(text: string): { hour: number; minute: number } | null {
  const range = parseTimeRange(text);
  if (range) return { hour: range.hour, minute: range.minute };
  const mer = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (mer?.[1]) {
    return toClock(Number(mer[1]), Number(mer[2] ?? "0"), mer[3]!.toLowerCase());
  }
  const hm = /\b(\d{1,2}):(\d{2})\b/.exec(text);
  if (hm?.[1] && hm[2]) {
    let hour = Number(hm[1]);
    const minute = Number(hm[2]);
    if (hour <= 7) hour += 12;
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }
  return null;
}

function parseMonthDay(text: string, timeZone: string, now: number): string | null {
  const match =
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i.exec(
      text,
    );
  if (!match?.[1] || !match[2]) return null;
  const month = MONTHS[match[1].toLowerCase()];
  const day = Number(match[2]);
  if (!month || day < 1 || day > 31) return null;
  const today = ymd(new Date(now), timeZone);
  const year = match[3] ? Number(match[3]) : Number(today.slice(0, 4));
  const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!match[3] && candidate < today) {
    return `${year + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return candidate;
}

function parseDay(text: string, timeZone: string, now: number): string | null {
  const monthDay = parseMonthDay(text, timeZone, now);
  if (monthDay) return monthDay;
  if (/\btomorrow\b/i.test(text)) {
    const d = new Date(now + 24 * 60 * 60_000);
    return ymd(d, timeZone);
  }
  if (/\b(today|tonight)\b/i.test(text)) return ymd(new Date(now), timeZone);
  for (let index = 0; index < WEEKDAYS.length; index += 1) {
    const name = WEEKDAYS[index]!;
    if (new RegExp(`\\b${name}\\b`, "i").test(text)) {
      return weekdayDate(index, timeZone, now);
    }
  }
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  return iso?.[1] ?? null;
}

function weekdayAt(weekday: number, hour: number, minute: number, timeZone: string, now: number): number {
  const day = weekdayDate(weekday, timeZone, now);
  const starts = dateInTimeZone(day, hour, minute, timeZone);
  if (starts.getTime() <= now) return starts.getTime() + 7 * 24 * 60 * 60_000;
  return starts.getTime();
}

function weekdayDate(weekday: number, timeZone: string, now: number): string {
  const today = ymd(new Date(now), timeZone);
  const [year, month, day] = today.split("-").map(Number);
  const utcGuess = Date.UTC(year!, month! - 1, day!);
  const current = new Date(utcGuess).getUTCDay();
  let delta = weekday - current;
  if (delta < 0) delta += 7;
  const target = new Date(utcGuess + delta * 24 * 60 * 60_000);
  return [
    target.getUTCFullYear(),
    String(target.getUTCMonth() + 1).padStart(2, "0"),
    String(target.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function ymd(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function inferLockedFields(input: {
  source: "slash" | "mention";
  parseIncomplete: boolean;
  audienceKind: MeetingAudienceKind;
}): MeetingLockedField[] {
  if (input.source === "slash") return [...SLASH_LOCKED_FIELDS];
  const locked: MeetingLockedField[] = ["calendar", "conference", "attendees"];
  if (!input.parseIncomplete) {
    locked.push("title", "start", "duration", "timezone", "recurrence", "location");
  }
  return locked;
}
