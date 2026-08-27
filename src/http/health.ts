import { loadEnv } from "../config.ts";
import { logger } from "../logger.ts";
import { lastMessageAt } from "../storage/messages.ts";

let server: ReturnType<typeof Bun.serve> | undefined;

export function startHealthServer(): void {
  if (server) return;
  const env = loadEnv();
  const port = env.HEALTH_PORT;
  const hostname = env.HEALTH_HOST;
  server = Bun.serve({
    port,
    hostname,
    fetch(req): Response {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        const body = {
          ok: true,
          last_message_at: lastMessageAt(),
        };
        return Response.json(body);
      }
      return new Response("not found", { status: 404 });
    },
  });
  logger.info({ port, hostname }, "health server listening");
}

export function stopHealthServer(): void {
  server?.stop();
  server = undefined;
}
