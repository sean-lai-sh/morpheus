import { dateInTimeZone } from "./audience.ts";
import type { CalendarTarget, MeetingAudienceKind, MeetingRecurrence } from "./identity.ts";
import { stripEmails } from "./identity.ts";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

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

const BOOK_VERB = /\b(book|schedule|set\s*up|create)\b/i;
const MEET_NOUN = /\b(meet(?:ing)?s?|call|sync|eboard)\b/i;
const MEET_WITH = /\bmeet(?:ing)?\s+with\b/i;
const TIMEISH =
  /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekly)\b/i;

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
  audienceKind: MeetingAudienceKind;
  requestedNames: string[];
  parseIncomplete: boolean;
  sourceText: string;
}

export function stripBotMentions(text: string, botUserId?: string): string {
  let out = text.replace(/<@!?\d+>/g, " ");
  if (botUserId) out = out.replaceAll(botUserId, " ");
  return out.replace(/\s+/g, " ").trim();
}

export function isMeetingIntent(text: string, botUserId?: string): boolean {
  const t = stripBotMentions(text, botUserId);
  if (!t) return false;
  if (MEET_WITH.test(t)) return true;
  if (BOOK_VERB.test(t) && MEET_NOUN.test(t)) return true;
  if (/\beboard\b/i.test(t) && TIMEISH.test(t) && (BOOK_VERB.test(t) || /\b(meet|meeting)\b/i.test(t))) {
    return true;
  }
  return false;
}

export function parseMeetingRequest(
  raw: string,
  opts: { now?: number; botUserId?: string } = {},
): ParsedMeetingRequest | null {
  if (!isMeetingIntent(raw, opts.botUserId)) return null;
  const now = opts.now ?? Date.now();
  const sourceText = stripEmails(stripBotMentions(raw, opts.botUserId)).slice(0, 2000);
  const timeZone = detectTimeZone(sourceText);
  const audienceKind = detectAudienceKind(sourceText);
  const calendar = detectCalendar(sourceText);
  const conference = !/\b(no meet|without meet|no(?:\s+google)?\s*(?:meet|link)|skip meet)\b/i.test(sourceText);
  const recurrence = detectRecurrence(sourceText, audienceKind);
  const durationMinutes = detectDuration(sourceText);
  const requestedNames = extractRequestedNames(sourceText);
  const parsedStart = parseNaturalStart(sourceText, timeZone, now);
  const parseIncomplete = parsedStart == null;
  const startsAt = parsedStart ?? defaultStart(audienceKind, timeZone, now);
  const title = inferTitle(sourceText, audienceKind, requestedNames);

  return {
    title,
    startsAt,
    durationMinutes,
    timeZone,
    notes: sourceText || null,
    calendar,
    conference,
    recurrence,
    audienceKind,
    requestedNames,
    parseIncomplete,
    sourceText,
  };
}

function detectTimeZone(text: string): string {
  const match = /\b(et|est|edt|pt|pst|pdt|ct|cst|cdt|utc|gmt|ny|nyc|eastern)\b/i.exec(text);
  if (!match?.[1]) return "America/New_York";
  return TZ_ALIASES[match[1].toLowerCase()] ?? "America/New_York";
}

function detectAudienceKind(text: string): MeetingAudienceKind {
  if (/\b(f26|eboard|board roster|the roster|whole board|full board)\b/i.test(text)) return "f26_roster";
  return "picked";
}

function detectCalendar(text: string): CalendarTarget {
  if (/\b(leadership|hello@)\b/i.test(text)) return "leadership";
  return "eboard";
}

function detectRecurrence(text: string, audience: MeetingAudienceKind): MeetingRecurrence {
  if (/\b(once|one[- ]time|this (week|friday|monday|tuesday|wednesday|thursday)|tomorrow|today)\b/i.test(text)) {
    return "none";
  }
  if (/\b(weekly|every week|every friday|recurring)\b/i.test(text)) return "weekly";
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
  const cleaned = clause
    .replace(/\b(tomorrow|today|tonight|next|this|on|at|for|weekly|every|eboard|f26)\b/gi, " ")
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, " ")
    .replace(/\b(et|est|edt|pt|pst|am|pm)\b/gi, " ")
    .replace(/[<>@!]/g, " ");
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
    const plusWeek = new Date(startsAt.getTime() + 7 * 24 * 60 * 60_000);
    if (plusWeek.getTime() > now) return plusWeek.getTime();
    return null;
  }
  return startsAt.getTime();
}

function parseClock(text: string): { hour: number; minute: number } | null {
  const mer = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (mer?.[1]) {
    let hour = Number(mer[1]);
    const minute = Number(mer[2] ?? "0");
    const suffix = mer[3]!.toLowerCase();
    if (hour === 12) hour = suffix === "am" ? 0 : 12;
    else if (suffix === "pm") hour += 12;
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
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

function parseDay(text: string, timeZone: string, now: number): string | null {
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
