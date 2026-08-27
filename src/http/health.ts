import { loadEnv } from "../config.ts";
import { logger } from "../logger.ts";
import { ingestFreshness } from "../context/store.ts";
import { handleV1 } from "./fs.ts";
import { resolveListenHost } from "./listen-host.ts";

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
    if (url.pathname.startsWith("/v1/")) {
      return handleV1(req);
    }
    return new Response("not found", { status: 404 });
  } catch (err) {
    logger.error({ err }, "http handler error");
    return Response.json({ error: "internal" }, { status: 500 });
  }
}

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
}

export function stopHealthServer(): void {
  server?.stop();
  server = undefined;
}
