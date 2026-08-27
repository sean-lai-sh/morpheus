import type { SDKCustomTool } from "@cursor/sdk";
import { logger } from "../logger.ts";

/**
 * Custom tools handed to the local SDK agent for one job. Everything the agent
 * can reach goes through the Mini's Tailscale /v1 API with the job's
 * workspace-scoped bearer (PR 46 hierarchy: the token sees its workspace and
 * descendants, never siblings or ancestors). The token lives only in this
 * closure — it is never in tool results, prompts, or logs, and the agent never
 * sees a Discord bot token because this process never holds one.
 */

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
  fetcher?: Fetcher;
  timeoutMs?: number;
  /** Called after a 2xx job-complete so the dispatcher knows the reply landed. */
  onComplete?: (reply: string) => void;
}

const MAX_TOOL_RESULT_CHARS = 30_000;
const MAX_REPLY_CHARS = 4_000;
const DEFAULT_TIMEOUT_MS = 15_000;

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
        "List the Morpheus Discord index tree at a path (e.g. '/' or '/eboard'). " +
        "Paths outside the job's workspace return not found.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Index path, default '/'" } },
      },
      async execute(args) {
        const path = str(args.path) ?? "/";
        return get(`/v1/fs/tree?path=${encodeURIComponent(path)}`);
      },
    },
    morpheus_fs_search: {
      description:
        "Full-text search the Morpheus Discord index within the job's workspace. " +
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
        if (prefix) body.pathPrefix = prefix;
        if (typeof args.limit === "number") body.limit = args.limit;
        try {
          const res = await post("/v1/fs/search", body);
          if (!res.ok) return errorResult(`morpheus api ${res.status}`);
          return textResult(res.text);
        } catch (err) {
          logger.error({ err, job_id: deps.jobId }, "morpheus fs search failed");
          return errorResult("morpheus api unreachable");
        }
      },
    },
    morpheus_fs_read: {
      description: "Read a Morpheus index path (channel window, thread, or message).",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      async execute(args) {
        const path = str(args.path);
        if (!path) return errorResult("path is required");
        return get(`/v1/fs/read?path=${encodeURIComponent(path)}`);
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
          const res = await post(`/v1/jobs/${encodeURIComponent(deps.jobId)}/complete`, { reply });
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
