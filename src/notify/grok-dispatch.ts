import { loadEnv, type Env } from "../config.ts";
import { logger } from "../logger.ts";
import { MAX_JOB_CHANNEL_IDS, type JobScope, type Namespace } from "../storage/jobs.ts";
import { isDiscordWebhookUrl } from "./webhooks.ts";

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
    /** `leadership` = whole isolated namespace. `channel` = honor `channel_ids`. */
    scope?: JobScope;
    /** Allowlisted Discord channel ids. Empty + scope leadership = unrestricted leadership. */
    channel_ids?: string[];
    content: string;
  };
  /** First-pass only. Grok live-searches the index over Tailscale if this is not enough. */
  snippets: Array<{ id?: string; channelId?: string; path?: string; content: string }>;
  feed_hint?: string;
  /** Always true on Mini dispatch. Do not grow this into a full-index dump. */
  first_pass: true;
}

export function grokBotWebhookUrl(env: Env = loadEnv()): string | null {
  const url = env.GROK_BOT_WEBHOOK_URL?.trim() || null;
  if (!url) return null;
  if (isDiscordWebhookUrl(url)) return null;
  return url;
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

function capChannelIds(ids: string[] | undefined): string[] {
  if (!ids) return [];
  const out: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) continue;
    if (out.includes(raw)) continue;
    out.push(raw);
    if (out.length >= MAX_JOB_CHANNEL_IDS) break;
  }
  return out;
}

function jobScopeOf(job: GrokJobPayload["job"]): JobScope {
  if (job.scope === "leadership" || job.scope === "channel") return job.scope;
  return job.namespace === "leadership" ? "leadership" : "channel";
}

function allowedChannelIds(job: GrokJobPayload["job"], scope: JobScope): string[] {
  const capped = capChannelIds(job.channel_ids);
  if (scope === "leadership") return [];
  if (capped.length > 0) return capped;
  if (job.discord_channel_id && /^\d+$/.test(job.discord_channel_id)) return [job.discord_channel_id];
  return [];
}

/** `/namespace/channelId/...` must stay inside the job's allowed set. */
function pathInJobScope(
  path: string | undefined,
  namespace: Namespace,
  scope: JobScope,
  allowed: string[],
): string | undefined {
  const indexed = indexOnlyPath(path);
  if (!indexed) return undefined;
  const parts = indexed.split("/").filter(Boolean);
  const ns = parts[0];
  const channelId = parts[1];
  if (scope === "leadership") {
    return ns === "leadership" ? indexed : undefined;
  }
  if (ns !== namespace) return undefined;
  if (allowed.length === 0) return undefined;
  if (!channelId || !allowed.includes(channelId)) return undefined;
  return indexed;
}

function snippetInJobScope(
  snippet: { channelId?: string; path?: string },
  namespace: Namespace,
  scope: JobScope,
  allowed: string[],
): boolean {
  if (snippet.path) {
    const indexed = indexOnlyPath(snippet.path);
    if (!indexed) return false;
    return Boolean(pathInJobScope(snippet.path, namespace, scope, allowed));
  }
  if (scope === "leadership") return true;
  if (snippet.channelId) return allowed.includes(snippet.channelId);
  return false;
}

function capFeedHint(
  hint: string | undefined,
  namespace: Namespace,
  scope: JobScope,
  allowed: string[],
): string | undefined {
  if (!hint) return undefined;
  const t = hint.trim().slice(0, MAX_FEED_HINT);
  if (!t) return undefined;
  if (t.startsWith("/")) {
    return pathInJobScope(t, namespace, scope, allowed);
  }
  return t;
}

/** Cap untrusted Discord text, index paths, channel_ids, and feed_hint. First-pass pack, not the retrieval API. */
export function capGrokPayload(payload: GrokJobPayload, env: Env = loadEnv()): GrokJobPayload {
  const job = payload.job;
  const scope = jobScopeOf(job);
  const channelIds = allowedChannelIds(job, scope);
  const feedHint = capFeedHint(payload.feed_hint, job.namespace, scope, channelIds);
  return {
    first_pass: true,
    ...(feedHint ? { feed_hint: feedHint } : {}),
    job: {
      id: job.id,
      namespace: job.namespace,
      scope,
      channel_ids: channelIds,
      content: redactSecrets(job.content, env).slice(0, MAX_JOB_CONTENT),
      ...(job.discord_message_id ? { discord_message_id: job.discord_message_id } : {}),
      ...(job.discord_channel_id ? { discord_channel_id: job.discord_channel_id } : {}),
      ...(job.author_id ? { author_id: job.author_id } : {}),
    },
    snippets: payload.snippets
      .slice(0, MAX_SNIPPETS)
      .filter((s) => snippetInJobScope(s, job.namespace, scope, channelIds))
      .map((s) => {
        const path = pathInJobScope(s.path, job.namespace, scope, channelIds);
        return {
          ...(s.id ? { id: s.id } : {}),
          ...(s.channelId ? { channelId: s.channelId } : {}),
          ...(path ? { path } : {}),
          content: redactSecrets(s.content, env).slice(0, MAX_SNIPPET_CHARS),
        };
      }),
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
  const rawUrl = env.GROK_BOT_WEBHOOK_URL?.trim() || "";
  if (rawUrl && isDiscordWebhookUrl(rawUrl)) {
    logger.error("GROK_BOT_WEBHOOK_URL is a Discord incoming webhook; refusing dispatch");
    return { dispatched: false, skipped: "refused-discord-incoming-webhook" };
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
