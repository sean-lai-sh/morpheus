import { logger } from "../logger.ts";
import { authorizeV1 } from "./auth.ts";
import { contextStore, toFtsQuery } from "../context/store.ts";
import { channelIdsForScope, constrainIndexPath, indexPathForRow, parseIndexPath } from "../context/paths.ts";
import { rowInScope } from "../context/namespace.ts";
import { getChannel, loadChannels, loadEnv } from "../config.ts";
import { isLinkKind, queryLinks } from "../storage/links.ts";
import type { MessageRow } from "../storage/messages.ts";
import type { Scope } from "../context/types.ts";

const SEARCH_LIMIT_MAX = 50;
const TREE_LIMIT = 100;
const POLL_LIMIT_MAX = 50;
const LINKS_LIMIT_MAX = 100;
const LINKS_LIMIT_DEFAULT = 50;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function clientNamespaceFrom(url: URL, body: Record<string, unknown> | null): string | undefined {
  const q = url.searchParams.get("namespace");
  if (q != null && q !== "") return q;
  const b = body?.namespace;
  if (typeof b === "string") return b;
  return undefined;
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function rejectIncludeDeleted(url: URL, body?: Record<string, unknown> | null): Response | null {
  if (body?.includeDeleted === true || url.searchParams.get("includeDeleted") === "true") {
    return json({ error: "includeDeleted is not allowed" }, 400);
  }
  return null;
}

function rejectPath(raw: string | null, namespace: Scope): Response | null {
  if (raw == null) return json({ error: "not found" }, 404);
  if (constrainIndexPath(raw, namespace) == null) {
    return json({ error: "not found" }, 404);
  }
  return null;
}

export async function handleV1(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const isSearch = req.method === "POST" && url.pathname === "/v1/fs/search";
  let body: Record<string, unknown> | null = null;
  if (isSearch || req.method === "POST") {
    body = await readJsonBody(req);
    if (body == null) return json({ error: "invalid json" }, 400);
  }

  const auth = authorizeV1(req, clientNamespaceFrom(url, body));
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  const { scope: namespace } = auth;

  const deletedFlag = rejectIncludeDeleted(url, body);
  if (deletedFlag) return deletedFlag;

  try {
    if (url.pathname === "/v1/fs/tree" && req.method === "GET") {
      return handleTree(url, namespace);
    }
    if (url.pathname === "/v1/fs/search" && req.method === "POST") {
      return handleSearch(namespace, body ?? {});
    }
    if (url.pathname === "/v1/fs/read" && req.method === "GET") {
      return handleRead(url, namespace);
    }
    const msgMatch = /^\/v1\/messages\/([^/]+)$/.exec(url.pathname);
    if (msgMatch && req.method === "GET") {
      return handleMessage(msgMatch[1] ?? "", namespace);
    }
    if (url.pathname === "/v1/poll" && req.method === "GET") {
      return handlePoll(url, namespace);
    }
    if (url.pathname === "/v1/links" && req.method === "GET") {
      return handleLinks(url, namespace);
    }
    return json({ error: "not found" }, 404);
  } catch (err) {
    logger.error({ err, path: url.pathname }, "v1 handler error");
    return json({ error: "internal" }, 500);
  }
}

function handleTree(url: URL, namespace: Scope): Response {
  const raw = url.searchParams.get("path") ?? "/";
  const bad = rejectPath(raw, namespace);
  if (bad) return bad;
  const safe = constrainIndexPath(raw, namespace);
  if (safe == null) return json({ error: "not found" }, 404);
  const parsed = parseIndexPath(safe);
  if (!parsed) return json({ error: "not found" }, 404);
  const nodes = contextStore.tree(safe, namespace).slice(0, TREE_LIMIT);
  return json({ path: safe, nodes });
}

/**
 * Body filter extraction: `undefined` = property absent, `null` = present but
 * invalid (400). Presence is `Object.hasOwn`, so an explicit JSON `null` (or
 * any nonconforming value) is rejected rather than silently dropping the filter.
 */
function stringFromBody(body: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.hasOwn(body, key)) return undefined;
  const v = body[key];
  if (typeof v !== "string" || v === "") return null;
  return v;
}

function msFromBody(body: Record<string, unknown>, key: string): number | null | undefined {
  if (!Object.hasOwn(body, key)) return undefined;
  const v = body[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}

function handleSearch(namespace: Scope, body: Record<string, unknown>): Response {
  const query = typeof body.query === "string" ? body.query : "";
  if (!query.trim() || !toFtsQuery(query)) {
    return json({ error: "query required" }, 400);
  }
  const pathPrefix = stringFromBody(body, "pathPrefix");
  if (pathPrefix === null) return json({ error: "invalid pathPrefix" }, 400);
  if (pathPrefix != null) {
    const bad = rejectPath(pathPrefix, namespace);
    if (bad) return bad;
  }
  const safePrefix = pathPrefix != null ? constrainIndexPath(pathPrefix, namespace) ?? undefined : undefined;
  const limitRaw = body.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), SEARCH_LIMIT_MAX)
      : undefined;

  // Documented body filters (issue #50 wrapper contract). A present-but-invalid
  // filter — including an explicit `null` or empty string — is a 400, never
  // silently ignored: dropped filters mean confidently wrong (unfiltered)
  // answers presented as filtered.
  let channelHint = stringFromBody(body, "channelHint");
  if (channelHint === null) return json({ error: "invalid channelHint" }, 400);
  if (channelHint != null) {
    const resolved = resolveChannelInScope(namespace, channelHint);
    if (resolved === "ambiguous") {
      return json({ error: "ambiguous channel name; pass the channel id" }, 400);
    }
    if (!resolved) return json({ hits: [] });
    channelHint = resolved.id;
  }
  const threadId = stringFromBody(body, "threadId");
  if (threadId === null) return json({ error: "invalid threadId" }, 400);
  const sinceMs = msFromBody(body, "sinceMs");
  if (sinceMs === null) return json({ error: "invalid sinceMs" }, 400);
  const untilMs = msFromBody(body, "untilMs");
  if (untilMs === null) return json({ error: "invalid untilMs" }, 400);

  const hits = contextStore.search({
    query,
    scope: namespace,
    pathPrefix: safePrefix,
    channelHint,
    threadId,
    sinceMs,
    untilMs,
    limit,
    includeDeleted: false,
  });
  return json({ hits });
}

function handleRead(url: URL, namespace: Scope): Response {
  const raw = url.searchParams.get("path");
  if (raw == null) return json({ error: "not found" }, 404);
  const bad = rejectPath(raw, namespace);
  if (bad) return bad;
  const safe = constrainIndexPath(raw, namespace);
  if (safe == null) return json({ error: "not found" }, 404);
  const parsed = parseIndexPath(safe);
  if (!parsed) return json({ error: "not found" }, 404);
  const result = contextStore.readPath(safe, namespace);
  if (result == null) return json({ error: "not found" }, 404);
  if (Array.isArray(result)) {
    if (result.length === 0 && (parsed.kind === "message" || parsed.kind === "channel" || parsed.kind === "thread")) {
      // empty window is a valid cat; missing message is null (already handled)
    }
    const first = result[0];
    if (first && typeof first === "object" && "kind" in first) {
      return json({ path: safe, nodes: result });
    }
    return json({ path: safe, documents: result });
  }
  return json({ path: safe, document: result });
}

function handleMessage(id: string, namespace: Scope): Response {
  if (!id) return json({ error: "not found" }, 404);
  const document = contextStore.readMessage(id, namespace);
  if (!document) return json({ error: "not found" }, 404);
  return json({ document });
}

function handlePoll(url: URL, namespace: Scope): Response {
  const cursor = url.searchParams.get("cursor");
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const cap =
    limit != null && Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), POLL_LIMIT_MAX) : undefined;
  if (cursor != null && cursor !== "" && !/^\d+:.+$/.test(cursor)) {
    return json({ error: "invalid cursor" }, 400);
  }
  const page = contextStore.poll(namespace, cursor && cursor !== "" ? cursor : null, cap);
  return json(page);
}

function parseMsParam(url: URL, name: string): number | null | undefined {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

type ChannelResolution = { id: string } | "ambiguous" | null;

/**
 * Channel id or name → allowlisted channel id within `scope`, else null.
 * When two visible channels share the name, the hint is "ambiguous" — callers
 * must reject it rather than silently picking whichever comes first in
 * channels.yml (the caller may be reading the wrong channel without knowing).
 * A snowflake id is never ambiguous.
 */
function resolveChannelInScope(scope: Scope, hint: string): ChannelResolution {
  const ids = new Set(channelIdsForScope(scope));
  const byId = getChannel(hint);
  if (byId && ids.has(byId.id)) return { id: byId.id };
  const byName = loadChannels().channels.filter(
    (c) => ids.has(c.id) && c.name.toLowerCase() === hint.toLowerCase(),
  );
  if (byName.length > 1) return "ambiguous";
  return byName[0] ? { id: byName[0].id } : null;
}

function permalinkForRow(row: MessageRow): string {
  return `https://discord.com/channels/${loadEnv().DISCORD_GUILD_ID}/${row.channel_id}/${row.id}`;
}

function handleLinks(url: URL, namespace: Scope): Response {
  const kindRaw = url.searchParams.get("kind");
  if (kindRaw != null && kindRaw !== "" && !isLinkKind(kindRaw)) {
    return json({ error: "invalid kind" }, 400);
  }
  const kind = kindRaw && isLinkKind(kindRaw) ? kindRaw : undefined;
  const sinceMs = parseMsParam(url, "since");
  if (sinceMs === null) return json({ error: "invalid since" }, 400);
  const untilMs = parseMsParam(url, "until");
  if (untilMs === null) return json({ error: "invalid until" }, 400);
  const limitRaw = url.searchParams.get("limit");
  const limitNum = limitRaw ? Number(limitRaw) : Number.NaN;
  const limit = Number.isFinite(limitNum)
    ? Math.min(Math.max(Math.trunc(limitNum), 1), LINKS_LIMIT_MAX)
    : LINKS_LIMIT_DEFAULT;

  const channelHint = url.searchParams.get("channel");
  let channelId: string | undefined;
  if (channelHint != null && channelHint !== "") {
    const resolved = resolveChannelInScope(namespace, channelHint);
    if (resolved === "ambiguous") {
      return json({ error: "ambiguous channel name; pass the channel id" }, 400);
    }
    if (!resolved) return json({ links: [] });
    channelId = resolved.id;
  }

  const channelIds = channelIdsForScope(namespace);
  if (channelIds.length === 0) return json({ links: [] });

  // Dedupe by file_id happens in SQL before the limit; the small over-fetch only
  // covers rows dropped by the post-query rowInScope / path checks.
  const rows = queryLinks({ channelIds, kind, sinceMs, untilMs, channelId, limit: limit * 2 });
  const links: Array<Record<string, unknown>> = [];
  for (const l of rows) {
    if (links.length >= limit) break;
    const m = l.message;
    if (!rowInScope(m, namespace)) continue;
    const path = indexPathForRow(m);
    if (!path) continue;
    links.push({
      url: l.url,
      kind: l.kind,
      fileId: l.file_id,
      messageId: m.id,
      channelId: m.channel_id,
      parentChannelId: m.parent_channel_id,
      threadId: m.thread_id,
      threadName: m.thread_name,
      path,
      authorName: m.author_name,
      createdAt: m.created_at,
      firstSeenAt: l.first_seen_at,
      permalink: permalinkForRow(m),
    });
  }
  return json({ links });
}
