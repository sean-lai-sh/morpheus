import { logger } from "../logger.ts";
import { authorizeV1 } from "./auth.ts";
import { contextStore, toFtsQuery } from "../context/store.ts";
import { constrainIndexPath, parseIndexPath } from "../context/paths.ts";
import type { Scope } from "../context/types.ts";

const SEARCH_LIMIT_MAX = 50;
const TREE_LIMIT = 100;
const POLL_LIMIT_MAX = 50;

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

function handleSearch(namespace: Scope, body: Record<string, unknown>): Response {
  const query = typeof body.query === "string" ? body.query : "";
  if (!query.trim() || !toFtsQuery(query)) {
    return json({ error: "query required" }, 400);
  }
  const pathPrefix = typeof body.pathPrefix === "string" ? body.pathPrefix : undefined;
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
  const hits = contextStore.search({
    query,
    scope: namespace,
    pathPrefix: safePrefix,
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
