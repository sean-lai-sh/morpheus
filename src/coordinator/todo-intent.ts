import { extractRoleSnowflakes } from "./audience.ts";
import { parseWhenInput, WhenParseError } from "./when-input.ts";

export const MISSING_DUE_REPLY =
  "I need a due date like `friday 2pm`, `tomorrow 3:30pm`, or `2026-09-04 14:00`. I will not guess a time.";

const USER_MENTION_RE = /<@!?(\d+)>/g;
const ROLE_MENTION_RE = /<@&(\d+)>/g;

const ADD_RE =
  /(?:^|\b)(?:please\s+)?(?:add|create)\s+(?:a\s+|an\s+)?(?:todo|task)\b|^todo\s*:|^remind me to\b/i;
const LIST_RE =
  /^(?:what(?:'s|s| is)\s+on\s+my\s+(?:todo\s+)?list\??|my\s+todos?|list\s+(?:my\s+)?(?:todos?|tasks?)|(?:show|get)\s+(?:my\s+)?(?:todos?|tasks?))\b/i;
const DONE_MARK_RE = /^mark\s+(.+?)\s+done\b/i;
const DONE_RE = /^(?:(?:please\s+)?(?:mark(?:\s+(?:that|this|it))?\s+)?)?(?:done|complete)(?:\s+(.+))?$/i;
const BY_DUE_RE = /\b(?:by|due(?:\s+(?:on|at))?)\s+(.+)$/i;

export type TodoIntent =
  | { kind: "add"; title: string; dueAt: number; dueText: string }
  | { kind: "missing_due"; title: string; dueError?: string }
  | { kind: "list" }
  | { kind: "done"; titleFragment?: string }
  | { kind: "unclear" };

export interface ParsedMentions {
  userIds: string[];
  roleIds: string[];
}

export function stripBotMentions(content: string, botUserId: string): string {
  if (!botUserId) return content;
  const re = new RegExp(`<@!?${botUserId}>`, "g");
  return content.replace(re, " ").replace(/\s+/g, " ").trim();
}

export function extractTodoMentions(content: string, botUserId: string): ParsedMentions {
  const userIds: string[] = [];
  USER_MENTION_RE.lastIndex = 0;
  for (const match of content.matchAll(USER_MENTION_RE)) {
    if (match[1] && match[1] !== botUserId) userIds.push(match[1]);
  }
  return {
    userIds: [...new Set(userIds)],
    roleIds: extractRoleSnowflakes(content),
  };
}

function stripMentions(content: string): string {
  return content.replace(USER_MENTION_RE, " ").replace(ROLE_MENTION_RE, " ").replace(/\s+/g, " ").trim();
}

function tryParseWhen(raw: string, timeZone: string, now: number): { ok: true; at: Date } | { ok: false; error: string } {
  try {
    return { ok: true, at: parseWhenInput(raw, timeZone, now) };
  } catch (err) {
    const message = err instanceof WhenParseError ? err.message : "I couldn't read that due date.";
    return { ok: false, error: message };
  }
}

function splitDue(
  text: string,
  timeZone: string,
  now: number,
): { rest: string; dueAt?: Date; dueText?: string; dueError?: string } {
  const labeled = BY_DUE_RE.exec(text);
  if (labeled) {
    const dueText = labeled[1]!.trim();
    const rest = text.slice(0, labeled.index).trim();
    const parsed = tryParseWhen(dueText, timeZone, now);
    if (parsed.ok) return { rest, dueAt: parsed.at, dueText };
    return { rest, dueText, dueError: parsed.error };
  }

  const tokens = text.split(/\s+/).filter(Boolean);
  for (let index = Math.max(0, tokens.length - 6); index < tokens.length; index++) {
    const dueText = tokens.slice(index).join(" ");
    const parsed = tryParseWhen(dueText, timeZone, now);
    if (parsed.ok) {
      return { rest: tokens.slice(0, index).join(" "), dueAt: parsed.at, dueText };
    }
  }
  return { rest: text };
}

function titleFromAdd(text: string): string {
  return text
    .replace(/^(?:please\s+)?(?:add|create)\s+(?:a\s+|an\s+)?(?:todo|task)\s*/i, "")
    .replace(/^todo\s*:\s*/i, "")
    .replace(/^remind me to\s*/i, "")
    .replace(/^to\s+/i, "")
    .trim();
}

export function parseTodoIntent(
  content: string,
  opts: { botUserId: string; timeZone?: string; now?: number },
): TodoIntent {
  const timeZone = opts.timeZone ?? "America/New_York";
  const now = opts.now ?? Date.now();
  const stripped = stripMentions(stripBotMentions(content, opts.botUserId));
  if (!stripped) return { kind: "unclear" };

  if (LIST_RE.test(stripped)) return { kind: "list" };

  const markDone = DONE_MARK_RE.exec(stripped);
  if (markDone) {
    const fragment = markDone[1]?.trim();
    return { kind: "done", titleFragment: fragment || undefined };
  }
  if (DONE_RE.test(stripped) && !ADD_RE.test(stripped)) {
    const match = DONE_RE.exec(stripped);
    const fragment = match?.[1]?.trim();
    return { kind: "done", titleFragment: fragment || undefined };
  }

  if (ADD_RE.test(stripped)) {
    const { rest, dueAt, dueText, dueError } = splitDue(stripped, timeZone, now);
    const title = titleFromAdd(rest);
    if (!title) return { kind: "missing_due", title: "", dueError: dueError ?? MISSING_DUE_REPLY };
    if (!dueAt) return { kind: "missing_due", title, dueError: dueError ?? MISSING_DUE_REPLY };
    return { kind: "add", title: title.slice(0, 100), dueAt: dueAt.getTime(), dueText: dueText ?? "" };
  }

  return { kind: "unclear" };
}
