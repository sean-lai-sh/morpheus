import type { SDKCustomTool } from "@cursor/sdk";
import { sanitizeIndexPath } from "../context/paths.ts";
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
 * allowlisted channels (and their threads), and search hits outside them are
 * filtered out. Prompt instructions are not authorization — this is.
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
  /** Job scope: `workspace` = token subtree; `channel` = only these channel ids. */
  scope: JobAccessScope;
  /** claimed_at from our claim, echoed on complete so a stale worker cannot win. */
  claimedAt?: number;
  fetcher?: Fetcher;
  timeoutMs?: number;
  /** Called after a 2xx job-complete so the dispatcher knows the reply landed. */
  onComplete?: (reply: string) => void;
}

const MAX_TOOL_RESULT_CHARS = 30_000;
const MAX_REPLY_CHARS = 4_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PATH_CHARS = 200;

/**
 * Index-path segments carry their Discord id as a trailing `-<id>` (channel
 * and thread slugs both come from `channelSlug(name, id)`). A path is inside a
 * channel-scoped job iff at least one segment's REAL trailing id is
 * allowlisted. Root/namespace/category paths carry no ids → rejected (fail
 * closed). The server still owns existence + the workspace boundary; this
 * narrowing can only remove access, never add it.
 */
export function pathInJobScope(rawPath: string, scope: JobAccessScope): boolean {
  if (rawPath.length > MAX_PATH_CHARS) return false;
  const sanitized = sanitizeIndexPath(rawPath);
  if (sanitized == null) return false;
  if (scope.kind === "workspace") return true;
  if (scope.channelIds.length === 0) return false;
  const trailingIds = sanitized
    .split("/")
    .filter(Boolean)
    .map((segment) => /-(\d+)$/.exec(segment)?.[1])
    .filter((id): id is string => Boolean(id));
  return trailingIds.some((id) => scope.channelIds.includes(id));
}

/** Drop `hits`/`nodes`/`documents` entries whose path is outside the job scope. */
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
  for (const key of ["hits", "nodes", "documents"]) {
    const list = obj[key];
    if (!Array.isArray(list)) continue;
    obj[key] = list.filter((item) => {
      if (!item || typeof item !== "object") return false;
      const path = (item as Record<string, unknown>).path;
      // Fail closed: entries without a checkable path never reach the agent.
      return typeof path === "string" && pathInJobScope(path, scope);
    });
  }
  return JSON.stringify(obj);
}

function defaultFetcher(timeoutMs: number): Fetcher {
  return async (url, init) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status, text: () => res.text() };
  };
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: text.slice(0, MAX_TOOL_RESULT_CHARS) }] };
}

function errorResult(text: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

const OUT_OF_SCOPE = "path is outside this job's channel scope";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

export function buildJobTools(deps: JobToolDeps): Record<string, SDKCustomTool> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = deps.fetcher ?? defaultFetcher(timeoutMs);
  const headers = { Authorization: `Bearer ${deps.token}` };
  const jsonHeaders = { ...headers, "Content-Type": "application/json" };

  async function get(path: string): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
    try {
      const res = await fetcher(`${deps.baseUrl}${path}`, { method: "GET", headers });
      const body = await res.text();
      if (!res.ok) return errorResult(`morpheus api ${res.status}`);
      return textResult(body);
    } catch (err) {
      logger.error({ err, job_id: deps.jobId }, "morpheus fs GET failed");
      return errorResult("morpheus api unreachable");
    }
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
        const result = await get(`/v1/fs/tree?path=${encodeURIComponent(path)}`);
        if ("isError" in result) return result;
        return textResult(filterListingForScope(result.content[0]?.text ?? "", deps.scope));
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
        const body: Record<string, unknown> = { query };
        const prefix = str(args.pathPrefix);
        if (prefix != null) {
          if (deps.scope.kind === "channel" && !pathInJobScope(prefix, deps.scope)) {
            return errorResult(OUT_OF_SCOPE);
          }
          body.pathPrefix = prefix;
        }
        if (typeof args.limit === "number") body.limit = args.limit;
        try {
          const res = await post("/v1/fs/search", body);
          if (!res.ok) return errorResult(`morpheus api ${res.status}`);
          return textResult(filterListingForScope(res.text, deps.scope));
        } catch (err) {
          logger.error({ err, job_id: deps.jobId }, "morpheus fs search failed");
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
        const result = await get(`/v1/fs/read?path=${encodeURIComponent(path)}`);
        if ("isError" in result) return result;
        return textResult(filterListingForScope(result.content[0]?.text ?? "", deps.scope));
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
            reply,
            ...(deps.claimedAt != null ? { claimed_at: deps.claimedAt } : {}),
          });
          if (!res.ok) return errorResult(`job complete failed (${res.status})`);
          deps.onComplete?.(reply);
          return textResult("reply delivered to the official bot");
        } catch (err) {
          logger.error({ err, job_id: deps.jobId }, "job complete POST failed");
          return errorResult("job complete unreachable");
        }
      },
    },
  };
}
