import { claimJob, getJob, listQueued, type Namespace } from "../storage/jobs.ts";
import { completeJobWithReply, failJobAsWorker } from "../bot/reply.ts";
import { peekClient } from "../bot/client.ts";
import { loadEnv } from "../config.ts";
import { logger } from "../logger.ts";

export interface TokenScope {
  namespace: Namespace;
  workerId: string;
}

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return out === 0;
}

/** Namespace comes from which scoped token matched — never from a client query param. */
export function scopeFromRequest(req: Request, env: NodeJS.ProcessEnv = process.env): TokenScope | null {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!m?.[1]) return null;
  const token = m[1];
  const general = env.MORPHEUS_API_TOKEN_GENERAL?.trim() ?? "";
  const leadership = env.MORPHEUS_API_TOKEN_LEADERSHIP?.trim() ?? "";
  const workerGeneral = env.JOB_WORKER_GENERAL?.trim() || "grok-general";
  const workerLeadership = env.JOB_WORKER_LEADERSHIP?.trim() || "grok-leadership";

  // Prefer the longer match if tokens ever share a prefix; require distinct secrets in ops.
  const generalOk = general.length > 0 && safeEqual(token, general);
  const leadershipOk = leadership.length > 0 && safeEqual(token, leadership);
  if (generalOk && leadershipOk) {
    logger.error("MORPHEUS_API_TOKEN_GENERAL and _LEADERSHIP must be distinct");
    return null;
  }
  if (generalOk) return { namespace: "general", workerId: workerGeneral };
  if (leadershipOk) return { namespace: "leadership", workerId: workerLeadership };
  return null;
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

function claimedByFrom(body: Record<string, unknown> | null, req: Request, scope: TokenScope): string | null {
  const fromBody = typeof body?.claimed_by === "string" ? body.claimed_by.trim() : "";
  const fromHeader = (req.headers.get("x-morpheus-worker") ?? "").trim();
  const claimedBy = fromBody || fromHeader || scope.workerId;
  if (!claimedBy) return null;
  const required =
    scope.namespace === "general"
      ? process.env.JOB_WORKER_GENERAL?.trim()
      : process.env.JOB_WORKER_LEADERSHIP?.trim();
  if (required && claimedBy !== required) return null;
  return claimedBy;
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
 * Auth: scoped bearer. Namespace from token + job row, never ?namespace=.
 */
export async function handleJobsRequest(req: Request, url: URL): Promise<Response> {
  const env = process.env;
  const scope = scopeFromRequest(req, env);
  if (!scope) return json(401, { error: "unauthorized" });

  const { pathname } = url;
  const method = req.method.toUpperCase();

  if (method === "GET" && pathname === "/v1/jobs") {
    const status = url.searchParams.get("status") ?? "queued";
    if (status !== "queued") return json(400, { error: "status must be queued" });
    // Ignore client namespace query param — list the token's namespace only.
    const jobs = listQueued(scope.namespace, 20);
    return json(200, { jobs, namespace: scope.namespace });
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
  if (existing.namespace !== scope.namespace) {
    return json(409, { error: "namespace mismatch" });
  }

  if (action === "claim") {
    const claimed = claimJob(jobId, claimedBy);
    if (!claimed) return json(409, { error: "not queued" });
    return json(200, { job: claimed });
  }

  if (action === "fail") {
    const error = typeof body.error === "string" ? body.error : "";
    if (!error.trim()) return json(400, { error: "error is required" });
    const result = failJobAsWorker(jobId, claimedBy, error);
    return json(result.status, result.ok ? { job: result.job } : { error: result.error });
  }

  // complete
  const reply = typeof body.reply === "string" ? body.reply : "";
  const github =
    typeof body.github_issue_url === "string" ? body.github_issue_url : undefined;
  const completionKey =
    typeof body.completion_key === "string" ? body.completion_key : undefined;

  let postReplies: boolean | undefined;
  try {
    postReplies = loadEnv().DISCORD_POST_REPLIES;
  } catch {
    postReplies = env.DISCORD_POST_REPLIES !== "false";
  }

  const result = await completeJobWithReply(
    jobId,
    claimedBy,
    { reply, github_issue_url: github, completion_key: completionKey },
    {
      client: discordClientOrUndefined(),
      postReplies,
    },
  );
  if (!result.ok) return json(result.status, { error: result.error, job: result.job });
  return json(200, {
    job: result.job,
    result_discord_message_id: result.job?.result_discord_message_id ?? null,
    posted: result.posted ?? false,
  });
}
