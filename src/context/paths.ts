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

/** True when the path looks like a Mini/OS path rather than an index path. */
export function isForbiddenOsPath(path: string): boolean {
  const p = path.trim();
  if (p.includes("\0")) return true;
  if (p.includes("..")) return true;
  if (p === "~" || p.startsWith("~/") || p.includes("/~/") || p.startsWith("/~")) return true;
  if (p === "/Users" || p.startsWith("/Users/") || p.toLowerCase().startsWith("/users/")) return true;
  if (p === "/home" || p.startsWith("/home/")) return true;
  if (p === "/etc" || p.startsWith("/etc/")) return true;
  if (p === "/var" || p.startsWith("/var/")) return true;
  if (p === "/tmp" || p.startsWith("/tmp/")) return true;
  if (p === "/data" || p.startsWith("/data/")) return true;
  if (p.includes("/data/discord")) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return false;
}

export function normalizeIndexPath(path: string): string | null {
  if (isForbiddenOsPath(path)) return null;
  let p = path.trim();
  if (p === "") p = "/";
  if (!p.startsWith("/")) return null;
  p = p.replace(/\/+/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
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
 * Parse a virtual index path. Returns null for OS paths, `..`, or anything that
 * is not under `/general` or `/leadership`.
 */
export function parseIndexPath(raw: string): ParsedIndexPath | null {
  const path = normalizeIndexPath(raw);
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
