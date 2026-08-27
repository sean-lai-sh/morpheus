import { getWorkspace, loadEnv, loadWorkspaceTokens, workspaceIds, type Env } from "../config.ts";
import { scopeFor } from "../context/namespace.ts";
import { parseIndexPath } from "../context/paths.ts";
import type { Namespace, Scope } from "../context/types.ts";
import { logger } from "../logger.ts";
import { MAX_JOB_CHANNEL_IDS, type JobScope } from "../storage/jobs.ts";
import { isDiscordWebhookUrl } from "./webhooks.ts";

/**
 * Every configured workspace bearer. FAIL CLOSED: a config/env error here must
 * abort the caller (refuse dispatch / refuse posting), never silently shrink the
 * redaction list — the text may contain the very tokens we failed to load.
 */
function workspaceTokenValues(): string[] {
  return loadWorkspaceTokens().map((t) => t.token);
}

/**
 * Strip Mini secrets from untrusted Discord text before it leaves the process.
 * Throws when the workspace token list cannot be loaded; callers must treat
 * that as "do not send" (fail closed), not "nothing to redact".
 */
export function redactSecrets(text: string, env: Env = loadEnv()): string {
  const secrets = [
    env.DISCORD_BOT_TOKEN,
    env.DISCORD_TOKEN,
    ...workspaceTokenValues(),
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
    /** Workspace id from channels.yml. Required — there is no default workspace. */
    namespace: Namespace;
    /** `workspace` = the job's workspace and its descendants. `channel` = honor `channel_ids`. */
    scope?: JobScope;
    /** Allowlisted Discord channel ids. Empty + scope `workspace` = the whole subtree. */
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
  (url: string, body: unknown, headers?: Record<string, string>): Promise<{
    ok: boolean;
    status: number;
    skipped?: string;
  }>;
}

const MAX_JOB_CONTENT = 4000;
const MAX_SNIPPETS = 12;
const MAX_SNIPPET_CHARS = 1200;
const MAX_PATH = 200;
const MAX_FEED_HINT = 40;

/** First segment must be a configured workspace id. Config unreadable → reject. */
function indexOnlyPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (path.includes("..") || path.includes("\\") || path.includes("\0")) return undefined;
  if (!path.startsWith("/")) return undefined;
  const first = path.split("/").filter(Boolean)[0];
  if (!first) return undefined;
  let ids: string[];
  try {
    ids = workspaceIds();
  } catch {
    return undefined;
  }
  if (!ids.includes(first)) return undefined;
  return path;
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
  if (job.scope === "workspace" || job.scope === "channel") return job.scope;
  // Legacy payloads from before workspaces.
  if ((job.scope as unknown) === "leadership") return "workspace";
  try {
    const ws = getWorkspace(job.namespace);
    return ws && ws.parent == null ? "workspace" : "channel";
  } catch {
    return "channel";
  }
}

function allowedChannelIds(job: GrokJobPayload["job"], scope: JobScope): string[] {
  const capped = capChannelIds(job.channel_ids);
  if (scope === "workspace") return [];
  if (capped.length > 0) return capped;
  if (job.discord_channel_id && /^\d+$/.test(job.discord_channel_id)) return [job.discord_channel_id];
  return [];
}

/** `scopeFor` reads channels.yml; a missing/invalid config means no scope, not a throw. */
function safeScopeFor(namespace: Namespace): Scope | null {
  try {
    return scopeFor(namespace);
  } catch {
    return null;
  }
}

/** An index path must parse, land inside the token's subtree, and (channel scope) name an allowed channel. */
function pathInJobScope(
  path: string | undefined,
  scope: Scope,
  jobScope: JobScope,
  allowed: string[],
): string | undefined {
  const indexed = indexOnlyPath(path);
  if (!indexed) return undefined;
  const parsed = parseIndexPath(indexed);
  if (!parsed || parsed.kind === "root") return undefined;
  if (!scope.visible.has(parsed.namespace)) return undefined;
  if (jobScope === "workspace") return indexed.slice(0, MAX_PATH);
  if (allowed.length === 0) return undefined;
  const ids: string[] = [];
  if (parsed.kind !== "namespace" && parsed.kind !== "category") ids.push(parsed.channel.id);
  if (parsed.kind === "thread") ids.push(parsed.threadId);
  if (parsed.kind === "message" && parsed.threadId) ids.push(parsed.threadId);
  if (!ids.some((id) => allowed.includes(id))) return undefined;
  return indexed.slice(0, MAX_PATH);
}

function snippetInJobScope(
  snippet: { channelId?: string; path?: string },
  scope: Scope,
  jobScope: JobScope,
  allowed: string[],
): boolean {
  if (snippet.path) return Boolean(pathInJobScope(snippet.path, scope, jobScope, allowed));
  if (jobScope === "workspace") return true;
  if (snippet.channelId) return allowed.includes(snippet.channelId);
  return false;
}

function capFeedHint(
  hint: string | undefined,
  scope: Scope,
  jobScope: JobScope,
  allowed: string[],
): string | undefined {
  if (!hint) return undefined;
  const t = hint.trim().slice(0, MAX_FEED_HINT);
  if (!t) return undefined;
  if (t.startsWith("/")) {
    return pathInJobScope(t, scope, jobScope, allowed);
  }
  return t;
}

/** Cap untrusted Discord text, index paths, channel_ids, and feed_hint. First-pass pack, not the retrieval API. */
export function capGrokPayload(payload: GrokJobPayload, env: Env = loadEnv()): GrokJobPayload {
  const job = payload.job;
  const jobScope = jobScopeOf(job);
  const channelIds = allowedChannelIds(job, jobScope);
  const scope = safeScopeFor(job.namespace);
  const feedHint = scope ? capFeedHint(payload.feed_hint, scope, jobScope, channelIds) : undefined;
  return {
    first_pass: true,
    ...(feedHint ? { feed_hint: feedHint } : {}),
    job: {
      id: job.id,
      namespace: job.namespace,
      scope: jobScope,
      channel_ids: channelIds,
      content: redactSecrets(job.content, env).slice(0, MAX_JOB_CONTENT),
      ...(job.discord_message_id ? { discord_message_id: job.discord_message_id } : {}),
      ...(job.discord_channel_id ? { discord_channel_id: job.discord_channel_id } : {}),
      ...(job.author_id ? { author_id: job.author_id } : {}),
    },
    // No resolvable workspace → no snippets leave the process.
    snippets: scope == null
      ? []
      : payload.snippets
          .slice(0, MAX_SNIPPETS)
          .filter((s) => snippetInJobScope(s, scope, jobScope, channelIds))
          .map((s) => {
            const path = pathInJobScope(s.path, scope, jobScope, channelIds);
            return {
              ...(s.id ? { id: s.id } : {}),
              ...(s.channelId ? { channelId: s.channelId } : {}),
              ...(path ? { path } : {}),
              content: redactSecrets(s.content, env).slice(0, MAX_SNIPPET_CHARS),
            };
          }),
  };
}

const TAILSCALE_CGNAT_V4 =
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(\.(25[0-5]|2[0-4]\d|[01]?\d?\d)){2}$/;

function resolveRedirectLocation(fromUrl: string, location: string | null): string | null {
  if (!location?.trim()) return null;
  try {
    return new URL(location, fromUrl).href;
  } catch {
    return null;
  }
}

/** Loopback, Tailscale CGNAT 100.64/10, and fd7a: — do not follow (#73). */
function isUnsafeRedirectUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
    if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    if (host === "127.0.0.1" || /^127(\.\d{1,3}){3}$/.test(host)) return true;
    if (TAILSCALE_CGNAT_V4.test(host)) return true;
    if (host.startsWith("fd7a:")) return true;
    return false;
  } catch {
    return true;
  }
}

function skippedForRedirect(fromUrl: string, locationHeader: string | null): string {
  const resolved = resolveRedirectLocation(fromUrl, locationHeader);
  if (resolved && isDiscordWebhookUrl(resolved)) return "refused-discord-incoming-webhook";
  return "refused-redirect";
}

async function defaultGrokPoster(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; skipped?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const resolved = resolveRedirectLocation(url, res.headers.get("location"));
      const skipped = skippedForRedirect(url, res.headers.get("location"));
      if (skipped === "refused-discord-incoming-webhook") {
        logger.error("GROK_BOT_WEBHOOK_URL redirected to a Discord incoming webhook; refusing dispatch");
      } else if (resolved && isUnsafeRedirectUrl(resolved)) {
        logger.error("GROK_BOT_WEBHOOK_URL redirected to a loopback or private address; refusing dispatch");
      } else {
        logger.error({ status: res.status }, "Grok Bot webhook dispatch refused to follow redirect");
      }
      return { ok: false, status: res.status, skipped };
    }
    return { ok: res.ok, status: res.status };
  } catch (err) {
    logger.error({ err }, "Grok Bot webhook dispatch timed out or failed");
    return { ok: false, status: 0 };
  }
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
  const scope = safeScopeFor(payload.job.namespace);
  if (!scope) {
    logger.error({ namespace: payload.job.namespace }, "Grok dispatch refused: job.namespace is not a configured workspace");
    return { dispatched: false, skipped: "namespace-required" };
  }
  // Exact membership, NOT hierarchy: listing `leadership` does not enable `eboard`
  // or any other descendant. Every workspace you want POSTed must be listed.
  if (!env.GROK_DISPATCH_WORKSPACES.includes(payload.job.namespace)) {
    logger.warn(
      { namespace: payload.job.namespace },
      "job not dispatched to GROK_BOT_WEBHOOK_URL (workspace not in GROK_DISPATCH_WORKSPACES)",
    );
    return { dispatched: false, skipped: "workspace-not-dispatchable" };
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
  const poster = opts.poster ?? ((u, body, hdrs) => defaultGrokPoster(u, body, hdrs ?? headers, timeoutMs));
  let capped: GrokJobPayload;
  try {
    capped = capGrokPayload(payload, env);
  } catch (err) {
    logger.error({ err }, "refusing Grok dispatch: secret redaction unavailable (workspace tokens failed to load)");
    return { dispatched: false, skipped: "secret-redaction-unavailable" };
  }
  const result = await poster(url, capped, headers);
  if (result.skipped) {
    return { dispatched: false, status: result.status, skipped: result.skipped };
  }
  if (!result.ok) {
    logger.error({ status: result.status }, "Grok Bot webhook dispatch failed");
  }
  return { dispatched: result.ok, status: result.status };
}
