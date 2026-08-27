import { logger } from "../logger.ts";

export interface GrokJobPayload {
  job: {
    id: string;
    discord_message_id?: string;
    discord_channel_id?: string;
    author_id?: string;
    namespace?: string;
    content: string;
  };
  snippets: Array<{ id?: string; channelId?: string; content: string }>;
  feed_hint?: string;
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

export interface HttpsPoster {
  (url: string, body: unknown): Promise<{ ok: boolean; status: number }>;
}

const MAX_JOB_CONTENT = 4000;
const MAX_SNIPPETS = 12;
const MAX_SNIPPET_CHARS = 1200;

/** Cap untrusted Discord text before Mini POSTs it to Grok. Never include tokens. */
export function capGrokPayload(payload: GrokJobPayload): GrokJobPayload {
  return {
    ...payload,
    job: {
      ...payload.job,
      content: payload.job.content.slice(0, MAX_JOB_CONTENT),
    },
    snippets: payload.snippets.slice(0, MAX_SNIPPETS).map((s) => ({
      ...s,
      content: s.content.slice(0, MAX_SNIPPET_CHARS),
    })),
  };
}

/**
 * Mini → Grok Bot: outbound POST of a job plus context snippets.
 * Grok Bot is the consumer; this does not run Morpheus on Grok's machine.
 */
export async function dispatchGrokJob(
  payload: GrokJobPayload,
  opts: { env?: NodeJS.ProcessEnv; poster?: HttpsPoster } = {},
): Promise<{ dispatched: boolean; status?: number; skipped?: string }> {
  const url = grokBotWebhookUrl(opts.env ?? process.env);
  if (!url) {
    logger.warn("GROK_BOT_WEBHOOK_URL not set; skip Grok dispatch");
    return { dispatched: false, skipped: "missing-grok-webhook-url" };
  }
  const poster =
    opts.poster ??
    (async (u, body) => {
      const res = await fetch(u, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { ok: res.ok, status: res.status };
    });
  const result = await poster(url, capGrokPayload(payload));
  if (!result.ok) {
    logger.error({ status: result.status }, "Grok Bot webhook dispatch failed");
  }
  return { dispatched: result.ok, status: result.status };
}
