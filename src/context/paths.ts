import type { Channel } from "../config.ts";
import { getChannel, loadChannels } from "../config.ts";
import { channelSlug } from "../storage/markdown.ts";
import { getDb } from "../storage/db.ts";
import { effectiveChannelId, type MessageRow } from "../storage/messages.ts";
import type { Namespace } from "./types.ts";

export type ParsedIndexPath =
  | { kind: "root" }
  | { kind: "namespace"; namespace: Namespace }
  | { kind: "category"; namespace: Namespace; category: string }
  | { kind: "channel"; namespace: Namespace; category: string | undefined; channel: Channel }
  | { kind: "threadsDir"; namespace: Namespace; category: string | undefined; channel: Channel }
  | {
      kind: "thread";
      namespace: Namespace;
      category: string | undefined;
      channel: Channel;
      threadId: string;
      threadName: string;
    }
  | {
      kind: "message";
      namespace: Namespace;
      category: string | undefined;
      channel: Channel;
      threadId: string | null;
      threadName: string | null;
      messageId: string;
    };

const OS_ROOTS = [
  "/users",
  "/home",
  "/etc",
  "/var",
  "/tmp",
  "/data",
  "/private",
  "/opt",
  "/root",
  "/mnt",
  "/volumes",
  "/system",
  "/library",
  "/proc",
  "/dev",
];

/**
 * Decode percent-encoding repeatedly so `%2e%2e` and `%252e%252e` become `..`.
 * Malformed encoding → null (reject).
 */
export function decodeEncodedPath(raw: string): string | null {
  let p = raw.trim();
  for (let i = 0; i < 5; i++) {
    if (/%[0-9a-fA-F]{2}/.test(p) === false) return p;
    try {
      const next = decodeURIComponent(p);
      if (next === p) return p;
      p = next;
    } catch {
      return null;
    }
  }
  return p;
}

/** True after decode: Mini/OS/homedir/host paths, not index paths. */
export function isForbiddenOsPath(path: string): boolean {
  const p = path.trim();
  if (p.includes("\0")) return true;
  if (p.includes("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p === "~" || p.startsWith("~/") || p.startsWith("/~") || p.includes("/~/")) return true;
  if (p.startsWith("//") || p.startsWith("\\\\")) return true;
  const lower = p.toLowerCase();
  for (const root of OS_ROOTS) {
    if (lower === root || lower.startsWith(`${root}/`)) return true;
  }
  return false;
}

/**
 * POSIX-normalize an absolute index path: collapse slashes, resolve `.` and `..`.
 * Returns null if the path is relative, would escape `/`, or is an OS/host path.
 */
export function posixNormalize(path: string): string | null {
  if (path.includes("\0") || path.includes("\\")) return null;
  if (!path.startsWith("/")) return null;
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length === 0 ? "/" : `/${out.join("/")}`;
}

/**
 * Decode → POSIX normalize (slash-collapse, resolve `..`) → OS denylist → return.
 * Client paths must then pass `constrainIndexPath` (token prefix).
 */
export function sanitizeIndexPath(raw: string): string | null {
  const decoded = decodeEncodedPath(raw);
  if (decoded == null) return null;
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  if (decoded === "~" || decoded.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(decoded)) return null;
  const normalized = posixNormalize(decoded === "" ? "/" : decoded);
  if (normalized == null) return null;
  if (isForbiddenOsPath(normalized)) return null;
  return normalized;
}

/** @deprecated use sanitizeIndexPath */
export function normalizeIndexPath(path: string): string | null {
  return sanitizeIndexPath(path);
}

/**
 * Token namespace is the access boundary. After sanitize, the path must be
 * `/`, `/${namespace}`, or `/${namespace}/...`.
 */
export function constrainIndexPath(raw: string, namespace: Namespace): string | null {
  const normalized = sanitizeIndexPath(raw);
  if (normalized == null) return null;
  if (normalized === "/") return "/";
  const prefix = `/${namespace}`;
  if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return normalized;
  return null;
}

export function channelIdsForNamespace(namespace: Namespace): string[] {
  return loadChannels()
    .channels.filter((c) => (c.isolated ? "leadership" : "general") === namespace)
    .map((c) => c.id);
}

export function pathPrefixMatches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function indexPathForRow(row: MessageRow): string | null {
  const channel = getChannel(effectiveChannelId(row));
  if (!channel) return null;
  const ns: Namespace = channel.isolated ? "leadership" : "general";
  return messagePath(ns, channel, row);
}

export function channelIndexPath(namespace: Namespace, channel: Channel): string {
  const slug = channelSlug(channel.name, channel.id);
  return channel.category ? `/${namespace}/${channel.category}/${slug}` : `/${namespace}/${slug}`;
}

export function threadIndexPath(namespace: Namespace, channel: Channel, threadName: string, threadId: string): string {
  return `${channelIndexPath(namespace, channel)}/threads/${channelSlug(threadName, threadId)}`;
}

export function messagePath(namespace: Namespace, channel: Channel, row: MessageRow): string {
  if (row.thread_id && row.thread_name) {
    return `${threadIndexPath(namespace, channel, row.thread_name, row.thread_id)}/${row.id}`;
  }
  return `${channelIndexPath(namespace, channel)}/${row.id}`;
}

function namespaceOfChannel(channel: Channel): Namespace {
  return channel.isolated ? "leadership" : "general";
}

function uncategorizedChannel(namespace: Namespace, slug: string): Channel | undefined {
  return loadChannels().channels.find(
    (c) => namespaceOfChannel(c) === namespace && !c.category && channelSlug(c.name, c.id) === slug,
  );
}

function categorizedChannel(namespace: Namespace, category: string, slug: string): Channel | undefined {
  return loadChannels().channels.find(
    (c) =>
      namespaceOfChannel(c) === namespace && c.category === category && channelSlug(c.name, c.id) === slug,
  );
}

function isCategoryName(namespace: Namespace, name: string): boolean {
  return loadChannels().channels.some((c) => namespaceOfChannel(c) === namespace && c.category === name);
}

interface ThreadSlugRow {
  thread_id: string;
  thread_name: string;
}

export function findThreadBySlug(
  parentChannelId: string,
  slug: string,
): { threadId: string; threadName: string } | null {
  const rows = getDb()
    .query<ThreadSlugRow, [string, string]>(
      `SELECT DISTINCT thread_id, thread_name
       FROM messages
       WHERE (channel_id = ? OR parent_channel_id = ?)
         AND thread_id IS NOT NULL AND thread_name IS NOT NULL`,
    )
    .all(parentChannelId, parentChannelId);
  for (const r of rows) {
    if (channelSlug(r.thread_name, r.thread_id) === slug) {
      return { threadId: r.thread_id, threadName: r.thread_name };
    }
  }
  return null;
}

function parseChannelTail(
  namespace: Namespace,
  category: string | undefined,
  channel: Channel,
  rest: string[],
): ParsedIndexPath | null {
  if (rest.length === 0) {
    return { kind: "channel", namespace, category, channel };
  }
  if (rest[0] === "threads") {
    if (rest.length === 1) {
      return { kind: "threadsDir", namespace, category, channel };
    }
    const threadSlug = rest[1];
    if (!threadSlug) return null;
    const thread = findThreadBySlug(channel.id, threadSlug);
    if (!thread) return null;
    if (rest.length === 2) {
      return {
        kind: "thread",
        namespace,
        category,
        channel,
        threadId: thread.threadId,
        threadName: thread.threadName,
      };
    }
    if (rest.length === 3 && rest[2]) {
      return {
        kind: "message",
        namespace,
        category,
        channel,
        threadId: thread.threadId,
        threadName: thread.threadName,
        messageId: rest[2],
      };
    }
    return null;
  }
  if (rest.length === 1 && rest[0]) {
    return {
      kind: "message",
      namespace,
      category,
      channel,
      threadId: null,
      threadName: null,
      messageId: rest[0],
    };
  }
  return null;
}

/**
 * Parse a virtual index path after sanitize. HTTP must call `constrainIndexPath`
 * first so a general token cannot follow `/general/../leadership` into leadership.
 */
export function parseIndexPath(raw: string): ParsedIndexPath | null {
  const path = sanitizeIndexPath(raw);
  if (path == null) return null;
  if (path === "/") return { kind: "root" };

  const segments = path.split("/").filter(Boolean);
  const nsSeg = segments[0];
  if (nsSeg !== "general" && nsSeg !== "leadership") return null;
  const namespace: Namespace = nsSeg;
  const rest = segments.slice(1);
  if (rest.length === 0) return { kind: "namespace", namespace };

  const first = rest[0];
  if (!first) return null;

  const uncat = uncategorizedChannel(namespace, first);
  if (uncat) return parseChannelTail(namespace, undefined, uncat, rest.slice(1));

  if (isCategoryName(namespace, first)) {
    if (rest.length === 1) return { kind: "category", namespace, category: first };
    const slug = rest[1];
    if (!slug) return null;
    const ch = categorizedChannel(namespace, first, slug);
    if (!ch) return null;
    return parseChannelTail(namespace, first, ch, rest.slice(2));
  }

  return null;
}

export function parsedPathString(parsed: ParsedIndexPath): string {
  switch (parsed.kind) {
    case "root":
      return "/";
    case "namespace":
      return `/${parsed.namespace}`;
    case "category":
      return `/${parsed.namespace}/${parsed.category}`;
    case "channel":
      return channelIndexPath(parsed.namespace, parsed.channel);
    case "threadsDir":
      return `${channelIndexPath(parsed.namespace, parsed.channel)}/threads`;
    case "thread":
      return threadIndexPath(parsed.namespace, parsed.channel, parsed.threadName, parsed.threadId);
    case "message": {
      if (parsed.threadId && parsed.threadName) {
        return `${threadIndexPath(parsed.namespace, parsed.channel, parsed.threadName, parsed.threadId)}/${parsed.messageId}`;
      }
      return `${channelIndexPath(parsed.namespace, parsed.channel)}/${parsed.messageId}`;
    }
  }
}
