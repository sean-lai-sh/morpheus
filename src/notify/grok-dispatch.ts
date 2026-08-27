import { logger } from "../logger.ts";

const SECRET_ENV_KEYS = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_TOKEN",
  "MORPHEUS_API_TOKEN_GENERAL",
  "MORPHEUS_API_TOKEN_LEADERSHIP",
  "DISCORD_WEBHOOK_SPONSORS",
  "DISCORD_WEBHOOK_OPPORTUNITIES",
  "DISCORD_WEBHOOK_SPEAKERS",
  "DISCORD_WEBHOOK_INBOX",
  "NIA_API_KEY",
  "NVIDIA_API_KEY",
  "GROK_BOT_WEBHOOK_URL",
  "GROK_BOT_WEBHOOK_SECRET",
] as const;

/** Strip Mini secrets from untrusted Discord text before it leaves the process. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const key of SECRET_ENV_KEYS) {
    const v = env[key]?.trim();
    if (v && v.length >= 8) out = out.split(v).join("[redacted]");
  }
  return out;
}

export interface GrokJobPayload {
  job: {
    id: string;
    discord_message_id?: string;
    discord_channel_id?: string;
    author_id?: string;
    namespace?: string;
    content: string;
  };
  /** First-pass only. Grok live-searches the index over Tailscale if this is not enough. */
  snippets: Array<{ id?: string; channelId?: string; path?: string; content: string }>;
  feed_hint?: string;
  /** Always true on Mini dispatch. Do not grow this into a full-index dump. */
  first_pass: true;
}

export function grokBotWebhookUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.GROK_BOT_WEBHOOK_URL?.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("GROK_BOT_WEBHOOK_URL is not a valid URL");
  }
  if (u.protocol !== "https:") {
    throw new Error("GROK_BOT_WEBHOOK_URL must be https");
  }
  return raw;
}

/** Mini Doppler sender key. Empty → skip dispatch (not activated). Never log this value. */
export function grokBotWebhookSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.GROK_BOT_WEBHOOK_SECRET?.trim();
  if (!raw) return null;
  return raw;
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

function indexOnlyPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (path.includes("..") || path.includes("\\") || path.includes("\0")) return undefined;
  if (path.startsWith("/general") || path.startsWith("/leadership")) return path;
  return undefined;
}

/** Cap untrusted Discord text. This is a first-pass pack, not the retrieval API. */
export function capGrokPayload(
  payload: GrokJobPayload,
  env: NodeJS.ProcessEnv = process.env,
): GrokJobPayload {
  const job = payload.job;
  return {
    first_pass: true,
    ...(payload.feed_hint ? { feed_hint: payload.feed_hint } : {}),
    job: {
      id: job.id,
      content: redactSecrets(job.content, env).slice(0, MAX_JOB_CONTENT),
      ...(job.discord_message_id ? { discord_message_id: job.discord_message_id } : {}),
      ...(job.discord_channel_id ? { discord_channel_id: job.discord_channel_id } : {}),
      ...(job.author_id ? { author_id: job.author_id } : {}),
      ...(job.namespace ? { namespace: job.namespace } : {}),
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
 * Grok live-searches the Morpheus index over Tailscale if it needs more.
 * Never include DISCORD_BOT_TOKEN, webhook URLs, or Mini filesystem paths.
 */
export async function dispatchGrokJob(
  payload: GrokJobPayload,
  opts: { env?: NodeJS.ProcessEnv; poster?: HttpsPoster } = {},
): Promise<{ dispatched: boolean; status?: number; skipped?: string }> {
  const env = opts.env ?? process.env;
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
  if (discordToken && Object.values(headers).some((v) => v.includes(discordToken))) {
    logger.error("refusing Grok dispatch: Discord bot token leaked into headers");
    return { dispatched: false, skipped: "refused-discord-token-in-headers" };
  }
  const poster =
    opts.poster ??
    (async (u, body, hdrs) => {
      const res = await fetch(u, {
        method: "POST",
        headers: hdrs ?? headers,
        body: JSON.stringify(body),
      });
      return { ok: res.ok, status: res.status };
    });
  const capped = capGrokPayload(payload, env);
  const result = await poster(url, capped, headers);
  if (!result.ok) {
    logger.error({ status: result.status }, "Grok Bot webhook dispatch failed");
  }
  return { dispatched: result.ok, status: result.status };
}
