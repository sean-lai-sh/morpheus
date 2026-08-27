import { timingSafeEqual } from "node:crypto";
import { WORKSPACE_ID } from "../config.ts";
import { logger } from "../logger.ts";
import type { EnqueueResult, SdkDispatcher, SdkJobPayload } from "./dispatcher.ts";
import type { SdkDispatcherEnv } from "./env.ts";

/**
 * Inbound webhook for the sibling SDK dispatcher. The Mini POSTs the same thin
 * job pack it sends to the Grok Bot webhook, with
 * `Authorization: Bearer <CURSOR_SDK_WEBHOOK_SECRET>`, to exactly one path:
 * POST /hooks/job (set CURSOR_SDK_WEBHOOK_URL accordingly). Loopback/Tailscale
 * bind only (enforced by env parsing). No bot token ever arrives here — the
 * pack is `capGrokPayload()` output, already redacted and capped on the Mini
 * side, and it is re-validated field by field before anything is enqueued.
 */

export const WEBHOOK_PATH = "/hooks/job";

/** Generous for a capped pack (~70KB worst case); refuse anything bigger unread. */
const MAX_BODY_BYTES = 256 * 1024;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    if (ba.length > 0) timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Whole-header match: `Bearer <token>` and nothing else (no trailing material). */
function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

const MAX_ID = 100;
const MAX_CONTENT = 4_000;
const MAX_SNIPPETS = 12;
const MAX_SNIPPET_CHARS = 1_200;
const MAX_PATH = 200;
const MAX_CHANNEL_IDS = 8;

function isSnowflake(v: unknown): v is string {
  return typeof v === "string" && /^\d+$/.test(v);
}

/** Index-path shape only: absolute, bounded, no traversal/OS separators. */
function validSnippetPath(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v.length === 0 || v.length > MAX_PATH) return false;
  if (!v.startsWith("/")) return false;
  return !v.includes("..") && !v.includes("\\") && !v.includes("\0");
}

function parseChannelIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (!isSnowflake(raw) || out.includes(raw)) continue;
    out.push(raw);
    if (out.length >= MAX_CHANNEL_IDS) break;
  }
  return out;
}

/**
 * Re-validate the pack shape and copy only known fields — nothing else from an
 * inbound request body reaches the dispatcher or the agent prompt. Scope is
 * preserved and fail-closed: anything not explicitly `workspace` is `channel`,
 * and a channel-scoped pack with no resolvable channel ids is refused.
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

  const channelId = isSnowflake(j.discord_channel_id) ? j.discord_channel_id : undefined;
  const scope: "workspace" | "channel" = j.scope === "workspace" ? "workspace" : "channel";
  let channelIds = parseChannelIds(j.channel_ids);
  if (scope === "channel" && channelIds.length === 0) {
    if (!channelId) return null;
    channelIds = [channelId];
  }
  if (scope === "workspace") channelIds = [];

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
              ...(validSnippetPath(snip.path) ? { path: snip.path } : {}),
              ...(isSnowflake(snip.channelId) ? { channelId: snip.channelId } : {}),
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
      scope,
      channel_ids: channelIds,
      ...(channelId ? { discord_channel_id: channelId } : {}),
    },
    snippets,
  };
}

export interface WebhookDeps {
  /** Inbound bearer. Compared timing-safe; never logged. */
  secret: string;
  enqueue: (payload: SdkJobPayload) => EnqueueResult;
}

export function createWebhookHandler(deps: WebhookDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true });
    }
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    if (url.pathname !== WEBHOOK_PATH) return json(404, { error: "not found" });

    const token = bearerToken(req);
    if (!token || !safeEqual(token, deps.secret)) {
      return json(401, { error: "unauthorized" });
    }

    // Refuse oversized bodies from the declared length, before buffering.
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return json(413, { error: "payload too large" });
    }
    const bodyText = await req.text();
    if (Buffer.byteLength(bodyText) > MAX_BODY_BYTES) {
      return json(413, { error: "payload too large" });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      return json(400, { error: "invalid json" });
    }
    const payload = parseJobPack(raw);
    if (!payload) return json(400, { error: "invalid job pack" });

    const result = deps.enqueue(payload);
    if (!result.accepted) {
      logger.warn({ job_id: payload.job.id, key: result.key }, "job pack refused: per-key queue full");
      return json(429, { error: "queue full", key: result.key });
    }
    logger.info({ job_id: payload.job.id, key: result.key, queued: result.queued }, "job pack accepted");
    return json(202, { accepted: true, key: result.key });
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
  logger.info(
    { host: env.listenHost, port: env.listenPort, path: WEBHOOK_PATH },
    "SDK dispatcher webhook listening",
  );
  return server;
}
