import { claimJob, getJob, listQueued } from "../storage/jobs.ts";
import { completeJobWithReply, failJobAsWorker } from "../bot/reply.ts";
import { peekClient } from "../bot/client.ts";
import { loadEnv } from "../config.ts";
import type { Scope } from "../context/types.ts";
import { authorizeV1 } from "./auth.ts";

export interface TokenScope {
  /** Workspace subtree the bearer may act on. Produced only by authorizeV1. */
  scope: Scope;
  workerId: string;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
    return {};
  } catch {
    return null;
  }
}

/** Token scope is the worker identity. A supplied claimed_by must match it. */
function claimedByFrom(body: Record<string, unknown> | null, req: Request, scope: TokenScope): string | null {
  const fromBody = typeof body?.claimed_by === "string" ? body.claimed_by.trim() : "";
  const fromHeader = (req.headers.get("x-morpheus-worker") ?? "").trim();
  const supplied = fromBody || fromHeader;
  if (supplied && supplied !== scope.workerId) return null;
  return scope.workerId;
}

function jobIdFromPath(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  // v1 jobs :id [claim|complete|fail]
  if (parts[0] !== "v1" || parts[1] !== "jobs") return null;
  return parts[2] ?? null;
}

function actionFromPath(pathname: string): "claim" | "complete" | "fail" | null {
  const parts = pathname.split("/").filter(Boolean);
  const action = parts[3];
  if (action === "claim" || action === "complete" || action === "fail") return action;
  return null;
}

function discordClientOrUndefined(): ReturnType<typeof peekClient> {
  const client = peekClient();
  if (client?.isReady()) return client;
  return undefined;
}

/**
 * /v1/jobs on the same Bun.serve as /health.
 * Auth: scoped workspace bearer. The workspace subtree comes from which token
 * matched plus the job row — never from ?namespace=.
 */
export async function handleJobsRequest(req: Request, url: URL): Promise<Response> {
  const env = loadEnv();
  const auth = authorizeV1(req);
  if (!auth.ok) return json(auth.status, { error: auth.error });
  const scope: TokenScope = { scope: auth.scope, workerId: `grok-${auth.scope.root}` };

  const { pathname } = url;
  const method = req.method.toUpperCase();

  if (method === "GET" && pathname === "/v1/jobs") {
    const status = url.searchParams.get("status") ?? "queued";
    if (status !== "queued") return json(400, { error: "status must be queued" });
    // Ignore any client namespace query param — the token's subtree is the list.
    const jobs = listQueued(scope.scope, 20);
    return json(200, { jobs, workspace: scope.scope.root, visible: [...scope.scope.visible] });
  }

  const jobId = jobIdFromPath(pathname);
  const action = actionFromPath(pathname);
  if (!jobId || !action) return json(404, { error: "not found" });
  if (method !== "POST") return json(405, { error: "method not allowed" });

  const body = await readJson(req);
  if (body === null) return json(400, { error: "invalid json" });

  const claimedBy = claimedByFrom(body, req, scope);
  if (!claimedBy) return json(409, { error: "claimed_by mismatch" });

  const existing = getJob(jobId);
  if (!existing) return json(404, { error: "not found" });
  if (!scope.scope.visible.has(existing.namespace)) {
    return json(409, { error: "workspace mismatch" });
  }

  // Claim generation: `claimed_by` alone cannot distinguish two workers using
  // the same workspace token (both are `grok-<root>`). A worker echoes the
  // claimed_at it was handed on claim; the value is validated INSIDE the
  // complete/fail CAS (prepareComplete / failJob), so a lease expiry + reclaim
  // between this handler and the state transition cannot let a stale worker win
  // (TOCTOU-safe). A non-numeric echo is rejected up front. Optional, so the
  // deployed Grok worker's complete/fail contract is unchanged.
  let expectedClaimedAt: number | undefined;
  if (action !== "claim" && body.claimed_at !== undefined) {
    if (typeof body.claimed_at !== "number") {
      return json(409, { error: "stale claim", job: existing });
    }
    expectedClaimedAt = body.claimed_at;
  }

  if (action === "claim") {
    const claimed = claimJob(jobId, claimedBy);
    if (!claimed) return json(409, { error: "not queued" });
    return json(200, { job: claimed });
  }

  if (action === "fail") {
    const error = typeof body.error === "string" ? body.error : "";
    if (!error.trim()) return json(400, { error: "error is required" });
    const result = failJobAsWorker(jobId, claimedBy, error, undefined, expectedClaimedAt);
    return json(result.status, result.ok ? { job: result.job } : { error: result.error });
  }

  // complete
  const reply = typeof body.reply === "string" ? body.reply : "";
  const github =
    typeof body.github_issue_url === "string" ? body.github_issue_url : undefined;
  const completionKey =
    typeof body.completion_key === "string" ? body.completion_key : undefined;

  const postReplies = env.DISCORD_POST_REPLIES;

  const result = await completeJobWithReply(
    jobId,
    claimedBy,
    { reply, github_issue_url: github, completion_key: completionKey },
    {
      client: discordClientOrUndefined(),
      postReplies,
      expectedClaimedAt,
    },
  );
  if (!result.ok) return json(result.status, { error: result.error, job: result.job });
  return json(200, {
    job: result.job,
    result_discord_message_id: result.job?.result_discord_message_id ?? null,
    posted: result.posted ?? false,
  });
}
