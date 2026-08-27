import { z } from "zod";
import { emptyToUndef, parseBoolish } from "../config.ts";
import { isAllowedListenHost } from "../http/listen-allowlist.ts";

/**
 * Environment for the sibling Cursor **local** SDK dispatcher (experiment #47).
 *
 * This is a separate process from `bun run live` and it parses its own env on
 * purpose: the main `envSchema` requires DISCORD_BOT_TOKEN, and this process
 * must never hold it. On the Mini, run it from a Doppler config that has the
 * SDK/worker secrets only (CURSOR_API_KEY, CURSOR_SDK_*, MORPHEUS_API_TOKEN_*)
 * and NOT the Discord bot token.
 */

const schema = z.object({
  /** Experiment gate. Default OFF — the process exits immediately unless true. */
  CURSOR_SDK_DISPATCH: z.preprocess(parseBoolish, z.boolean().default(false)),
  /** Cursor API key. Inference is Cursor-hosted; never log or forward this. */
  CURSOR_API_KEY: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  /** Inbound bearer the Mini presents on webhook POSTs. >=16 chars. */
  CURSOR_SDK_WEBHOOK_SECRET: z.preprocess(emptyToUndef, z.string().min(16).optional()),
  /** Bind address. Loopback or Tailscale only — same allowlist as HEALTH_HOST. */
  CURSOR_SDK_LISTEN_HOST: z.preprocess(
    emptyToUndef,
    z
      .string()
      .min(1)
      .default("127.0.0.1")
      .refine(isAllowedListenHost, "must be loopback (127.0.0.1 / ::1) or Tailscale (100.64/10 or fd7a:)"),
  ),
  CURSOR_SDK_LISTEN_PORT: z.preprocess(
    emptyToUndef,
    z.coerce.number().int().min(1).max(65535).default(8790),
  ),
  /** Model for local SDK agents. Local = agent loop on the Mini, not local weights. */
  CURSOR_SDK_MODEL: z.preprocess(emptyToUndef, z.string().min(1).default("composer-2.5")),
  /** Workspace dir the local agent runs in. Defaults to this checkout. */
  CURSOR_SDK_CWD: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  /**
   * Morpheus /v1 base (same box: http://127.0.0.1:<HEALTH_PORT>, or the Mini's
   * Tailscale URL). Workspace bearers are sent here on every claim/fs call, so
   * the host must be loopback, Tailscale, or *.ts.net for http AND https —
   * never an arbitrary internet host — and the URL may carry no credentials,
   * query, or fragment. Redirects are never followed by the sibling's fetchers.
   */
  MORPHEUS_BASE_URL: z.preprocess(
    emptyToUndef,
    z
      .string()
      .url()
      .default("http://127.0.0.1:8080")
      .refine((u) => {
        try {
          const parsed = new URL(u);
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
          if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
          const host = parsed.hostname.toLowerCase();
          return isAllowedListenHost(host) || host.endsWith(".ts.net");
        } catch {
          return false;
        }
      }, "host must be loopback, Tailscale (100.64/10, fd7a:115c:a1e0::/48), or *.ts.net, with no credentials/query/fragment"),
  ),
});

export interface SdkDispatcherEnv {
  enabled: boolean;
  /** Never log, never put in job payloads or tool results. */
  apiKey: string | null;
  webhookSecret: string | null;
  listenHost: string;
  listenPort: number;
  model: string;
  agentCwd: string;
  morpheusBaseUrl: string;
}

/**
 * Parse the sibling's env. Throws if the Discord bot token is present:
 * the SDK worker is never the Discord face (product lock, #41/#47).
 */
export function parseSdkDispatcherEnv(raw: NodeJS.ProcessEnv = process.env): SdkDispatcherEnv {
  if (raw.DISCORD_BOT_TOKEN?.trim() || raw.DISCORD_TOKEN?.trim()) {
    throw new Error(
      "refusing to start: DISCORD_BOT_TOKEN/DISCORD_TOKEN is set in this environment. " +
        "The Cursor SDK dispatcher must never hold the Discord bot token — run it from a " +
        "Doppler config without it (official bot replies stay on `bun run live`).",
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid SDK dispatcher environment:\n${issues}`);
  }
  const e = parsed.data;
  return {
    enabled: e.CURSOR_SDK_DISPATCH,
    apiKey: e.CURSOR_API_KEY ?? null,
    webhookSecret: e.CURSOR_SDK_WEBHOOK_SECRET ?? null,
    listenHost: e.CURSOR_SDK_LISTEN_HOST,
    listenPort: e.CURSOR_SDK_LISTEN_PORT,
    model: e.CURSOR_SDK_MODEL,
    agentCwd: e.CURSOR_SDK_CWD ?? process.cwd(),
    morpheusBaseUrl: e.MORPHEUS_BASE_URL.replace(/\/+$/, ""),
  };
}
