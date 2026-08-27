import { timingSafeEqual } from "node:crypto";
import { WORKSPACE_ID } from "../config.ts";
import { logger } from "../logger.ts";
import type { SdkDispatcher, SdkJobPayload } from "./dispatcher.ts";
import type { SdkDispatcherEnv } from "./env.ts";

/**
 * Inbound webhook for the sibling SDK dispatcher. The Mini POSTs the same thin
 * job pack it sends to the Grok Bot webhook, with
 * `Authorization: Bearer <CURSOR_SDK_WEBHOOK_SECRET>`. Loopback/Tailscale bind
 * only (enforced by env parsing). No bot token ever arrives here — the pack is
 * `capGrokPayload()` output, already redacted and capped on the Mini side.
 */

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    if (ba.length > 0) timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(\S+)/i.exec(header.trim());
  return m?.[1] ?? null;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

const MAX_ID = 100;
const MAX_CONTENT = 4_000;
const MAX_SNIPPETS = 12;
const MAX_SNIPPET_CHARS = 1_200;

/**
 * Re-validate the pack shape and copy only known fields — nothing else from an
 * inbound request body reaches the dispatcher or the agent prompt.
 */
export function parseJobPack(raw: unknown): SdkJobPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const pack = raw as Record<string, unknown>;
  const job = pack.job;
  if (!job || typeof job !== "object" || Array.isArray(job)) return null;
  const j = job as Record<string, unknown>;
  const id = typeof j.id === "string" ? j.id.trim() : "";
  const namespace = typeof j.namespace === "string" ? j.namespace : "";
  const content = typeof j.content === "string" ? j.content : "";
  if (!id || id.length > MAX_ID || !WORKSPACE_ID.test(namespace) || !content.trim()) return null;

  const channelId =
    typeof j.discord_channel_id === "string" && /^\d+$/.test(j.discord_channel_id)
      ? j.discord_channel_id
      : undefined;
  const snippets = Array.isArray(pack.snippets)
    ? pack.snippets
        .slice(0, MAX_SNIPPETS)
        .flatMap((s) => {
          if (!s || typeof s !== "object" || Array.isArray(s)) return [];
          const snip = s as Record<string, unknown>;
          if (typeof snip.content !== "string" || !snip.content.trim()) return [];
          return [
            {
              content: snip.content.slice(0, MAX_SNIPPET_CHARS),
              ...(typeof snip.path === "string" ? { path: snip.path } : {}),
              ...(typeof snip.channelId === "string" ? { channelId: snip.channelId } : {}),
            },
          ];
        })
    : [];

  return {
    first_pass: true,
    job: {
      id,
      namespace,
      content: content.slice(0, MAX_CONTENT),
      ...(channelId ? { discord_channel_id: channelId } : {}),
    },
    snippets,
  };
}

export interface WebhookDeps {
  /** Inbound bearer. Compared timing-safe; never logged. */
  secret: string;
  enqueue: (payload: SdkJobPayload) => { key: string; queued: number };
}

export function createWebhookHandler(deps: WebhookDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true });
    }
    if (req.method !== "POST") return json(405, { error: "method not allowed" });

    const token = bearerToken(req);
    if (!token || !safeEqual(token, deps.secret)) {
      return json(401, { error: "unauthorized" });
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json(400, { error: "invalid json" });
    }
    const payload = parseJobPack(raw);
    if (!payload) return json(400, { error: "invalid job pack" });

    const { key, queued } = deps.enqueue(payload);
    logger.info({ job_id: payload.job.id, key, queued }, "job pack accepted");
    return json(202, { accepted: true, key });
  };
}

export function startSdkWebhookServer(
  env: SdkDispatcherEnv,
  dispatcher: SdkDispatcher,
): ReturnType<typeof Bun.serve> {
  if (!env.webhookSecret) throw new Error("CURSOR_SDK_WEBHOOK_SECRET is required to serve");
  const handler = createWebhookHandler({
    secret: env.webhookSecret,
    enqueue: (payload) => dispatcher.enqueue(payload),
  });
  const server = Bun.serve({
    hostname: env.listenHost,
    port: env.listenPort,
    fetch: handler,
  });
  logger.info({ host: env.listenHost, port: env.listenPort }, "SDK dispatcher webhook listening");
  return server;
}
