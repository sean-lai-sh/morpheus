import type { SDKCustomTool } from "@cursor/sdk";
import { getChannel } from "../config.ts";
import { channelIndexPath, parseIndexPath, sanitizeIndexPath } from "../context/paths.ts";
import { logger } from "../logger.ts";

/**
 * Custom tools handed to the local SDK agent for one job. Everything the agent
 * can reach goes through the Mini's Tailscale /v1 API with the job's
 * workspace-scoped bearer (PR 46 hierarchy: the token sees its workspace and
 * descendants, never siblings or ancestors). The token lives only in this
 * closure — it is never in tool results, prompts, or logs, and the agent never
 * sees a Discord bot token because this process never holds one.
 *
 * On top of the server-side workspace boundary, these tools enforce the JOB's
 * scope client-side: a channel-scoped job may only tree/read paths inside its
 * allowlisted channels (and their threads), search/links queries are narrowed
 * to the allowed channels in the request itself (so a busy sibling channel
 * cannot starve the allowed one out of a limited page), and every listing is
 * post-filtered. Prompt instructions are not authorization — this is.
 */

export type JobAccessScope =
  | { kind: "workspace" }
  | { kind: "channel"; channelIds: string[] };

export interface FetchResult {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface Fetcher {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<FetchResult>;
}

export interface JobToolDeps {
  /** Morpheus /v1 base, no trailing slash. */
  baseUrl: string;
  /** Workspace-scoped bearer for this job's namespace. Never echoed anywhere. */
  token: string;
  jobId: string;
  /** Job scope from the CLAIMED ROW: `workspace` = token subtree; `channel` = only these ids. */
  scope: JobAccessScope;
  /** claimed_at from our claim, echoed on complete so a stale worker cannot win. */
  claimedAt?: number;
  /** Secrets this process holds; scrubbed from every tool result before the model sees it. */
  redactValues?: string[];
  fetcher?: Fetcher;
  timeoutMs?: number;
  /** Called after a 2xx job-complete so the dispatcher knows the reply landed. */
  onComplete?: (reply: string) => void;
}

const MAX_TOOL_RESULT_CHARS = 30_000;
const MAX_REPLY_CHARS = 4_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PATH_CHARS = 200;
const SEARCH_LIMIT_DEFAULT = 10;
const LINKS_LIMIT_DEFAULT = 50;

/**
 * Authorization by PARSED identity, not by segment shape: the path must parse
 * against channels.yml (`parseIndexPath`) and the resolved channel id — or the
 * thread id — must be allowlisted. A category or slug that merely *looks* like
 * `…-<allowed id>` (e.g. `/eboard/archive-1001/private-5005`) does not parse to
 * an allowlisted channel and is refused. Root/namespace/category paths carry
 * no channel identity → refused. The server still owns existence + the
 * workspace boundary; this narrowing can only remove access, never add it.
 */
export function pathInJobScope(rawPath: string, scope: JobAccessScope): boolean {
  if (rawPath.length > MAX_PATH_CHARS) return false;
  const sanitized = sanitizeIndexPath(rawPath);
  if (sanitized == null) return false;
  if (scope.kind === "workspace") return true;
  const allowed = scope.channelIds;
  if (allowed.length === 0) return false;
  let parsed: ReturnType<typeof parseIndexPath>;
  try {
    parsed = parseIndexPath(sanitized);
  } catch {
    return false;
  }
  if (!parsed) return false;
  switch (parsed.kind) {
    case "root":
    case "namespace":
    case "category":
      return false;
    case "channel":
    case "threadsDir":
      return allowed.includes(parsed.channel.id);
    case "thread":
      return allowed.includes(parsed.channel.id) || allowed.includes(parsed.threadId);
    case "message":
      return (
        allowed.includes(parsed.channel.id) ||
        (parsed.threadId != null && allowed.includes(parsed.threadId))
      );
  }
}

/**
 * Drop `hits`/`nodes`/`links` entries whose path is outside the job scope.
 * Filtering is by entry, never by field — surviving search hits keep their
 * full #50/#51 shape (`match: strict|loose`, `links[]`, permalink, …).
 *
 * `documents` (and the single `document`) are the /v1/fs/read contract: the
 * items carry NO per-item path, only the listing's top-level `path`. They are
 * gated on that parent path instead — in scope keeps them, anything else
 * empties them. An item that does carry its own out-of-scope path is still
 * dropped (defense in depth). Runs on the FULL response body, before any
 * truncation.
 */
export function filterListingForScope(bodyText: string, scope: JobAccessScope): string {
  if (scope.kind === "workspace") return bodyText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // Not JSON → nothing safe to hand a channel-scoped agent.
    return JSON.stringify({ error: "unparseable response withheld (channel scope)" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bodyText;
  const obj = { ...(parsed as Record<string, unknown>) };
  for (const key of ["hits", "nodes", "links"]) {
    const list = obj[key];
    if (!Array.isArray(list)) continue;
    obj[key] = list.filter((item) => {
      if (!item || typeof item !== "object") return false;
      const path = (item as Record<string, unknown>).path;
      // Fail closed: entries without a checkable path never reach the agent.
      return typeof path === "string" && pathInJobScope(path, scope);
    });
  }

  const parentPath = typeof obj.path === "string" ? obj.path : null;
  const parentInScope = parentPath != null && pathInJobScope(parentPath, scope);
  if (Array.isArray(obj.documents)) {
    obj.documents = !parentInScope
      ? []
      : obj.documents.filter((item) => {
          if (!item || typeof item !== "object") return false;
          const path = (item as Record<string, unknown>).path;
          // Pathless documents inherit the (in-scope) parent path.
          return path === undefined || (typeof path === "string" && pathInJobScope(path, scope));
        });
  }
  if (obj.document !== undefined && !parentInScope) {
    delete obj.document;
    obj.error = "document withheld (outside channel scope)";
  }
  return JSON.stringify(obj);
}

/** Allowed ids that resolve to configured channels — the queryable narrowing set. */
function allowedChannels(scope: JobAccessScope): Array<{ id: string; path: string }> {
  if (scope.kind === "workspace") return [];
  const out: Array<{ id: string; path: string }> = [];
  for (const id of scope.channelIds) {
    const channel = getChannel(id);
    if (channel) out.push({ id, path: channelIndexPath(channel.workspace, channel) });
  }
  return out;
}

function scrubText(text: string, redactValues: string[]): string {
  let out = text;
  for (const v of redactValues) {
    const s = v?.trim();
    if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  }
  return out;
}

function defaultFetcher(timeoutMs: number): Fetcher {
  return async (url, init) => {
    // No redirect following: a redirecting Morpheus URL must fail, not re-route bearers.
    const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status, text: () => res.text() };
  };
}

const OUT_OF_SCOPE = "path is outside this job's channel scope";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function capLimit(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.trunc(v), 1), 50);
}

export function buildJobTools(deps: JobToolDeps): Record<string, SDKCustomTool> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = deps.fetcher ?? defaultFetcher(timeoutMs);
  const headers = { Authorization: `Bearer ${deps.token}` };
  const jsonHeaders = { ...headers, "Content-Type": "application/json" };
  const scrubList = [...(deps.redactValues ?? []), deps.token];

  /** Filter (full body) → scrub secrets → cap. Order matters: never truncate before auth filtering. */
  function finish(bodyText: string): { content: Array<{ type: "text"; text: string }> } {
    const filtered = filterListingForScope(bodyText, deps.scope);
    return { content: [{ type: "text", text: scrubText(filtered, scrubList).slice(0, MAX_TOOL_RESULT_CHARS) }] };
  }

  function errorResult(text: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
    return { content: [{ type: "text", text: scrubText(text, scrubList).slice(0, MAX_TOOL_RESULT_CHARS) }], isError: true };
  }

  async function getRaw(path: string): Promise<{ ok: boolean; status: number; text: string }> {
    const res = await fetcher(`${deps.baseUrl}${path}`, { method: "GET", headers });
    return { ok: res.ok, status: res.status, text: await res.text() };
  }

  async function post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; text: string }> {
    const res = await fetcher(`${deps.baseUrl}${path}`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  }

  /** Merge arrays under `key` from several response bodies, deduped by `idOf`, capped. */
  function mergeListings(
    bodies: string[],
    key: "hits" | "links",
    idOf: (item: Record<string, unknown>) => string,
    limit: number,
  ): string {
    const seen = new Set<string>();
    const merged: unknown[] = [];
    for (const body of bodies) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        continue;
      }
      const list = (parsed as Record<string, unknown>)?.[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (merged.length >= limit) break;
        if (!item || typeof item !== "object") continue;
        const id = idOf(item as Record<string, unknown>);
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(item);
      }
    }
    return JSON.stringify({ [key]: merged });
  }

  return {
    morpheus_fs_tree: {
      description:
        "List the Morpheus Discord index tree at a path. Channel-scoped jobs may only list " +
        "inside their own channel paths; out-of-scope paths are refused.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Index path, default '/'" } },
      },
      async execute(args) {
        const path = str(args.path) ?? "/";
        if (!pathInJobScope(path, deps.scope)) return errorResult(OUT_OF_SCOPE);
        try {
          const res = await getRaw(`/v1/fs/tree?path=${encodeURIComponent(path)}`);
          if (!res.ok) return errorResult(`morpheus api ${res.status}`);
          return finish(res.text);
        } catch {
          logger.error({ job_id: deps.jobId, tool: "morpheus_fs_tree" }, "morpheus fs GET failed");
          return errorResult("morpheus api unreachable");
        }
      },
    },
    morpheus_fs_search: {
      description:
        "Full-text search the Morpheus Discord index within this job's scope. " +
        "Use this before answering from memory.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          pathPrefix: { type: "string", description: "Optional index path prefix" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
      async execute(args) {
        const query = str(args.query);
        if (!query) return errorResult("query is required");
        const limit = capLimit(args.limit, SEARCH_LIMIT_DEFAULT);
        const base: Record<string, unknown> = { query, limit };
        const prefix = str(args.pathPrefix);
        if (prefix != null && deps.scope.kind === "channel" && !pathInJobScope(prefix, deps.scope)) {
          return errorResult(OUT_OF_SCOPE);
        }

        // Channel scope without an explicit prefix: one query PER allowed
        // channel, each narrowed in SQL via pathPrefix, so a busy sibling
        // channel can never starve the allowed one out of the limited page.
        let bodies: Array<Record<string, unknown>>;
        if (deps.scope.kind === "channel" && prefix == null) {
          const channels = allowedChannels(deps.scope);
          bodies =
            channels.length > 0
              ? channels.map((c) => ({ ...base, pathPrefix: c.path }))
              : [base]; // thread-only allowlists: post-filter below is the boundary
        } else {
          bodies = [prefix != null ? { ...base, pathPrefix: prefix } : base];
        }

        try {
          const texts: string[] = [];
          for (const body of bodies) {
            const res = await post("/v1/fs/search", body);
            if (!res.ok && bodies.length === 1) return errorResult(`morpheus api ${res.status}`);
            if (res.ok) texts.push(res.text);
          }
          const merged =
            texts.length === 1
              ? texts[0]!
              : mergeListings(texts, "hits", (h) => String(h.id ?? JSON.stringify(h)), limit);
          return finish(merged);
        } catch {
          logger.error({ job_id: deps.jobId, tool: "morpheus_fs_search" }, "morpheus fs search failed");
          return errorResult("morpheus api unreachable");
        }
      },
    },
    morpheus_fs_read: {
      description:
        "Read a Morpheus index path (channel window, thread, or message) within this job's scope.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      async execute(args) {
        const path = str(args.path);
        if (!path) return errorResult("path is required");
        if (!pathInJobScope(path, deps.scope)) return errorResult(OUT_OF_SCOPE);
        try {
          const res = await getRaw(`/v1/fs/read?path=${encodeURIComponent(path)}`);
          if (!res.ok) return errorResult(`morpheus api ${res.status}`);
          return finish(res.text);
        } catch {
          logger.error({ job_id: deps.jobId, tool: "morpheus_fs_read" }, "morpheus fs GET failed");
          return errorResult("morpheus api unreachable");
        }
      },
    },
    morpheus_fs_links: {
      description:
        "Enumerate Google Docs/Drive/Sheets/Slides/Forms links shared in this job's scope " +
        "(newest first, deduped by file). Use when the question mentions 'the doc', 'the sheet', " +
        "'the tracker', or shared files. Kinds: drive|docs|sheets|slides|forms.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", description: "drive|docs|sheets|slides|forms" },
          since: { type: "number", description: "Only links posted at/after this epoch ms" },
          until: { type: "number", description: "Only links posted at/before this epoch ms" },
          limit: { type: "number" },
          channel: { type: "string", description: "Discord channel id to restrict to" },
        },
      },
      async execute(args) {
        const params = new URLSearchParams();
        const kind = str(args.kind);
        if (kind) params.set("kind", kind);
        for (const name of ["since", "until"] as const) {
          const v = args[name];
          if (typeof v === "number" && Number.isFinite(v)) params.set(name, String(Math.trunc(v)));
        }
        const limit = capLimit(args.limit, LINKS_LIMIT_DEFAULT);
        params.set("limit", String(limit));

        const requested = str(args.channel);
        // Which channels to query: fan out over every allowed channel so a busy
        // sibling can never starve the allowed ones out of the limited page.
        let channelParams: Array<string | null>;
        if (deps.scope.kind === "channel") {
          if (requested != null) {
            // Server-side `channel` also resolves names across the whole token
            // subtree — under channel scope only allowlisted numeric ids pass.
            if (!/^\d+$/.test(requested) || !deps.scope.channelIds.includes(requested)) {
              return errorResult(OUT_OF_SCOPE);
            }
            channelParams = [requested];
          } else {
            const channels = allowedChannels(deps.scope);
            // Thread-only allowlists: one unrestricted query; post-filter is the boundary.
            channelParams = channels.length > 0 ? channels.map((c) => c.id) : [null];
          }
        } else {
          channelParams = [requested ?? null];
        }

        try {
          const texts: string[] = [];
          for (const channel of channelParams) {
            const qs = new URLSearchParams(params);
            if (channel) qs.set("channel", channel);
            const res = await getRaw(`/v1/links?${qs.toString()}`);
            if (!res.ok && channelParams.length === 1) return errorResult(`morpheus api ${res.status}`);
            if (res.ok) texts.push(res.text);
          }
          const merged =
            texts.length === 1
              ? texts[0]!
              : mergeListings(texts, "links", (l) => String(l.fileId ?? l.url ?? JSON.stringify(l)), limit);
          return finish(merged);
        } catch {
          logger.error({ job_id: deps.jobId, tool: "morpheus_fs_links" }, "morpheus links GET failed");
          return errorResult("morpheus api unreachable");
        }
      },
    },
    morpheus_job_complete: {
      description:
        "Deliver the final answer for this Discord job. The official bot on the Mini posts it " +
        "as a reply — you never talk to Discord directly. Call exactly once, when done.",
      inputSchema: {
        type: "object",
        properties: {
          reply: { type: "string", description: "Final reply text for the Discord user" },
        },
        required: ["reply"],
      },
      async execute(args) {
        const reply = str(args.reply)?.slice(0, MAX_REPLY_CHARS);
        if (!reply) return errorResult("reply is required");
        try {
          const res = await post(`/v1/jobs/${encodeURIComponent(deps.jobId)}/complete`, {
            reply: scrubText(reply, scrubList),
            ...(deps.claimedAt != null ? { claimed_at: deps.claimedAt } : {}),
          });
          if (!res.ok) return errorResult(`job complete failed (${res.status})`);
          deps.onComplete?.(reply);
          return { content: [{ type: "text", text: "reply delivered to the official bot" }] };
        } catch {
          logger.error({ job_id: deps.jobId, tool: "morpheus_job_complete" }, "job complete POST failed");
          return errorResult("job complete unreachable");
        }
      },
    },
  };
}
