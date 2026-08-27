import { loadEnv, type Env } from "../config.ts";
import { scopeFor } from "../context/namespace.ts";
import { logger } from "../logger.ts";
import {
  capGrokPayload,
  findLeakedSecretEnv,
  grokDispatchAuthHeaders,
  type GrokJobPayload,
  type HttpsPoster,
} from "./grok-dispatch.ts";
import { isDiscordWebhookUrl } from "./webhooks.ts";

/**
 * Experiment (#47): POST the same thin job pack the Grok Bot webhook gets to a
 * sibling Cursor **local** SDK dispatcher running next to `bun run live`.
 *
 * Everything here is additive and OFF by default (`CURSOR_SDK_DISPATCH=false`):
 * with the flag off this module never touches the network and the existing
 * Grok path is byte-for-byte unchanged. The pack is the exact
 * `capGrokPayload()` output — redacted, capped, workspace-scoped — with
 * `Authorization: Bearer <CURSOR_SDK_WEBHOOK_SECRET>` as auth. No bot token in
 * the body, headers, or URL, ever.
 */

export function cursorSdkWebhookUrl(env: Env = loadEnv()): string | null {
  const url = env.CURSOR_SDK_WEBHOOK_URL?.trim() || null;
  if (!url) return null;
  if (isDiscordWebhookUrl(url)) return null;
  return url;
}

/** Sender bearer for the sibling. Empty → skip dispatch (not activated). Never log this value. */
export function cursorSdkWebhookSecret(env: Env = loadEnv()): string | null {
  return env.CURSOR_SDK_WEBHOOK_SECRET?.trim() || null;
}

export type SdkDispatchResult = {
  dispatched: boolean;
  status?: number;
  skipped?: string;
};

/**
 * Mini → sibling SDK dispatcher. Same guards as `dispatchGrokJob`, in the same
 * order: flag gate, workspace checks, URL/secret presence (warn + skip), then
 * a bot-token-on-request tripwire before anything leaves the process.
 * Workspace membership reuses GROK_DISPATCH_WORKSPACES — one exact-membership
 * allowlist for "jobs that may leave the Mini", default deny.
 */
export async function dispatchSdkJob(
  payload: GrokJobPayload,
  opts: { env?: Env; poster?: HttpsPoster } = {},
): Promise<SdkDispatchResult> {
  const env = opts.env ?? loadEnv();

  if (!env.CURSOR_SDK_DISPATCH) {
    // Default-off experiment gate. Silent skip — this fires on every job.
    return { dispatched: false, skipped: "sdk-dispatch-disabled" };
  }

  let inScope = false;
  try {
    inScope = scopeFor(payload.job.namespace) != null;
  } catch {
    inScope = false;
  }
  if (!inScope) {
    logger.error(
      { namespace: payload.job.namespace },
      "SDK dispatch refused: job.namespace is not a configured workspace",
    );
    return { dispatched: false, skipped: "namespace-required" };
  }
  if (!env.GROK_DISPATCH_WORKSPACES.includes(payload.job.namespace)) {
    logger.warn(
      { namespace: payload.job.namespace },
      "job not dispatched to CURSOR_SDK_WEBHOOK_URL (workspace not in GROK_DISPATCH_WORKSPACES)",
    );
    return { dispatched: false, skipped: "workspace-not-dispatchable" };
  }

  const url = cursorSdkWebhookUrl(env);
  if (!url) {
    logger.warn("CURSOR_SDK_WEBHOOK_URL not set; skip SDK dispatch");
    return { dispatched: false, skipped: "missing-sdk-webhook-url" };
  }
  const secret = cursorSdkWebhookSecret(env);
  if (!secret) {
    logger.warn("CURSOR_SDK_WEBHOOK_SECRET not set; skip SDK dispatch");
    return { dispatched: false, skipped: "missing-sdk-webhook-secret" };
  }

  const headers = grokDispatchAuthHeaders(secret);
  const discordToken = (env.DISCORD_BOT_TOKEN ?? env.DISCORD_TOKEN)?.trim();
  if (discordToken && (url.includes(discordToken) || Object.values(headers).some((v) => v.includes(discordToken)))) {
    logger.error("refusing SDK dispatch: Discord bot token leaked onto the request");
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
        logger.error({ err }, "SDK dispatcher webhook POST timed out or failed");
        return { ok: false, status: 0 };
      }
    });
  const capped = capGrokPayload(payload, env);
  const leaked = findLeakedSecretEnv(JSON.stringify(capped), env);
  if (leaked) {
    logger.error({ leaked_env: leaked, job_id: payload.job.id }, "refusing SDK dispatch: a Mini secret survived redaction (fail closed)");
    return { dispatched: false, skipped: "refused-secret-in-payload" };
  }
  const result = await poster(url, capped, headers);
  if (!result.ok) {
    logger.error({ status: result.status }, "SDK dispatcher webhook POST failed");
  }
  return { dispatched: result.ok, status: result.status };
}
