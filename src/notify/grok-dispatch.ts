import { loadEnv, type Env } from "../config.ts";
import { logger } from "../logger.ts";
import type { Namespace } from "../storage/jobs.ts";

/** Strip Mini secrets from untrusted Discord text before it leaves the process. */
export function redactSecrets(text: string, env: Env = loadEnv()): string {
  const secrets = [
    env.DISCORD_BOT_TOKEN,
    env.DISCORD_TOKEN,
    env.MORPHEUS_API_TOKEN_GENERAL,
    env.MORPHEUS_API_TOKEN_LEADERSHIP,
    env.GROK_BOT_WEBHOOK_URL,
    env.GROK_BOT_WEBHOOK_SECRET,
    env.NVIDIA_API_KEY,
  ];
  let out = text;
  for (const v of secrets) {
    const s = v?.trim();
    if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  }
  return out;
}

export interface GrokJobPayload {
  job: {
    id: string;
    discord_message_id?: string;
    discord_channel_id?: string;
    author_id?: string;
    namespace: Namespace;
    content: string;
  };
  /** First-pass only. Grok live-searches the index over Tailscale if this is not enough. */
  snippets: Array<{ id?: string; channelId?: string; path?: string; content: string }>;
  feed_hint?: string;
  /** Always true on Mini dispatch. Do not grow this into a full-index dump. */
  first_pass: true;
}

export function grokBotWebhookUrl(env: Env = loadEnv()): string | null {
  return env.GROK_BOT_WEBHOOK_URL?.trim() || null;
}

/** Mini Doppler sender key. Empty → skip dispatch (not activated). Never log this value. */
export function grokBotWebhookSecret(env: Env = loadEnv()): string | null {
  return env.GROK_BOT_WEBHOOK_SECRET?.trim() || null;
}

/** Header the Grok Bot webhook routine expects. Sender key is auth, not job content. */
export function grokDispatchAuthHeaders(secret: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${secret}`,
  };
}

export interface HttpsPoster {
  (url: string, body: unknown, headers?: Record<string, string>): Promise<{ ok: boolean; status: number }>;
}

const MAX_JOB_CONTENT = 4000;
const MAX_SNIPPETS = 12;
const MAX_SNIPPET_CHARS = 1200;
const MAX_PATH = 200;
const MAX_FEED_HINT = 40;

function indexOnlyPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (path.includes("..") || path.includes("\\") || path.includes("\0")) return undefined;
  if (!(path.startsWith("/general") || path.startsWith("/leadership"))) return undefined;
  return path.slice(0, MAX_PATH);
}

function capFeedHint(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const t = hint.trim().slice(0, MAX_FEED_HINT);
  return t || undefined;
}

/** Cap untrusted Discord text, index paths, and feed_hint. First-pass pack, not the retrieval API. */
export function capGrokPayload(payload: GrokJobPayload, env: Env = loadEnv()): GrokJobPayload {
  const job = payload.job;
  const feedHint = capFeedHint(payload.feed_hint);
  return {
    first_pass: true,
    ...(feedHint ? { feed_hint: feedHint } : {}),
    job: {
      id: job.id,
      namespace: job.namespace,
      content: redactSecrets(job.content, env).slice(0, MAX_JOB_CONTENT),
      ...(job.discord_message_id ? { discord_message_id: job.discord_message_id } : {}),
      ...(job.discord_channel_id ? { discord_channel_id: job.discord_channel_id } : {}),
      ...(job.author_id ? { author_id: job.author_id } : {}),
    },
    snippets: payload.snippets.slice(0, MAX_SNIPPETS).map((s) => ({
      ...(s.id ? { id: s.id } : {}),
      ...(s.channelId ? { channelId: s.channelId } : {}),
      ...(indexOnlyPath(s.path) ? { path: indexOnlyPath(s.path) } : {}),
      content: redactSecrets(s.content, env).slice(0, MAX_SNIPPET_CHARS),
    })),
  };
}

/**
 * Mini → Grok Bot: thin Discord job + first-pass snippets.
 * Official-bot `message.reply` is the @-path; Discord incoming webhooks are ops feed only.
 * Never include DISCORD_BOT_TOKEN, webhook URLs, Mini filesystem paths, or a :1340 gateway.
 */
export async function dispatchGrokJob(
  payload: GrokJobPayload,
  opts: { env?: Env; poster?: HttpsPoster } = {},
): Promise<{ dispatched: boolean; status?: number; skipped?: string }> {
  const env = opts.env ?? loadEnv();
  if (payload.job.namespace !== "general" && payload.job.namespace !== "leadership") {
    logger.error("Grok dispatch refused: job.namespace is required");
    return { dispatched: false, skipped: "namespace-required" };
  }
  if (payload.job.namespace === "leadership" && !env.GROK_DISPATCH_LEADERSHIP) {
    logger.warn("leadership job not dispatched to GROK_BOT_WEBHOOK_URL (GROK_DISPATCH_LEADERSHIP=false)");
    return { dispatched: false, skipped: "leadership-not-dispatchable" };
  }

  const url = grokBotWebhookUrl(env);
  if (!url) {
    logger.warn("GROK_BOT_WEBHOOK_URL not set; skip Grok dispatch");
    return { dispatched: false, skipped: "missing-grok-webhook-url" };
  }
  const secret = grokBotWebhookSecret(env);
  if (!secret) {
    logger.warn("GROK_BOT_WEBHOOK_SECRET not set; skip Grok dispatch");
    return { dispatched: false, skipped: "missing-grok-webhook-secret" };
  }

  const headers = grokDispatchAuthHeaders(secret);
  const discordToken = (env.DISCORD_BOT_TOKEN ?? env.DISCORD_TOKEN)?.trim();
  if (discordToken && (url.includes(discordToken) || Object.values(headers).some((v) => v.includes(discordToken)))) {
    logger.error("refusing Grok dispatch: Discord bot token leaked onto the request");
    return { dispatched: false, skipped: "refused-discord-token-on-request" };
  }

  const timeoutMs = env.GROK_DISPATCH_TIMEOUT_MS;
  const poster =
    opts.poster ??
    (async (u, body, hdrs) => {
      try {
        const res = await fetch(u, {
          method: "POST",
          headers: hdrs ?? headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { ok: res.ok, status: res.status };
      } catch (err) {
        logger.error({ err }, "Grok Bot webhook dispatch timed out or failed");
        return { ok: false, status: 0 };
      }
    });
  const capped = capGrokPayload(payload, env);
  const result = await poster(url, capped, headers);
  if (!result.ok) {
    logger.error({ status: result.status }, "Grok Bot webhook dispatch failed");
  }
  return { dispatched: result.ok, status: result.status };
}
