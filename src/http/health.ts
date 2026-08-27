import { loadEnv, loadWorkspaceTokens, workspaceIds } from "../config.ts";
import { logger } from "../logger.ts";
import { ingestFreshness } from "../context/store.ts";
import { handleV1 } from "./fs.ts";
import { resolveListenHost } from "./listen-host.ts";
import { handleJobsRequest } from "./jobs.ts";

let server: ReturnType<typeof Bun.serve> | undefined;

function healthBody(): Record<string, unknown> {
  const fresh = ingestFreshness();
  return {
    ok: true,
    last_message_at: fresh.lastMessageAt,
    fts_count: fresh.ftsCount,
  };
}

export async function handleRequest(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json(healthBody(), { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/v1/jobs" || url.pathname.startsWith("/v1/jobs/")) {
      return handleJobsRequest(req, url);
    }
    if (url.pathname.startsWith("/v1/")) {
      return handleV1(req);
    }
    return new Response("not found", { status: 404 });
  } catch (err) {
    logger.error({ err }, "http handler error");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}

/** Alias for jobs HTTP tests. Same handler as `/health` + `/v1`. */
export const handleHttpRequest = handleRequest;

export function startHealthServer(): void {
  if (server) return;
  const port = loadEnv().HEALTH_PORT;
  const hostname = resolveListenHost();
  server = Bun.serve({
    port,
    hostname,
    fetch(req): Response | Promise<Response> {
      return handleRequest(req);
    },
  });
  logger.info({ port, hostname }, "health server listening");
  const tokens = loadWorkspaceTokens();
  const withAccess = new Set(tokens.map((t) => t.workspace));
  const withoutAccess = workspaceIds().filter((id) => !withAccess.has(id));
  if (tokens.length === 0) {
    logger.error("no workspace tokens loaded: every /v1/* request will be 401 (set the token_env vars from channels.yml)");
  } else if (withoutAccess.length > 0) {
    logger.warn({ workspaces: withoutAccess }, "workspaces without an HTTP token (no /v1 access)");
  }
}

export function stopHealthServer(): void {
  server?.stop();
  server = undefined;
}
