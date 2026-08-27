import { loadWorkspaceTokens } from "../config.ts";
import { logger } from "../logger.ts";
import { SdkDispatcher } from "./dispatcher.ts";
import { parseSdkDispatcherEnv } from "./env.ts";
import { createCursorSdkRuntime } from "./runtime.ts";
import { startSdkWebhookServer } from "./server.ts";

/**
 * Sibling Cursor **local** SDK dispatcher (experiment #47). Run next to
 * `bun run live`, never inside it:
 *
 *     bun run sdk-dispatch
 *
 * On the Mini, use a Doppler config that has CURSOR_API_KEY, CURSOR_SDK_*,
 * and the MORPHEUS_API_TOKEN_* workspace bearers — and NOT the Discord bot
 * token (boot refuses if it is present). Inference is Cursor-hosted; "local"
 * means the agent loop runs on the Mini, not local weights.
 */

async function main(): Promise<void> {
  const env = parseSdkDispatcherEnv();

  if (!env.enabled) {
    logger.warn("CURSOR_SDK_DISPATCH is not enabled (default off); exiting. Set CURSOR_SDK_DISPATCH=true to run the experiment.");
    process.exit(0);
  }
  if (!env.apiKey) {
    logger.warn("CURSOR_API_KEY not set; skip SDK dispatcher");
    process.exit(0);
  }
  if (!env.webhookSecret) {
    logger.warn("CURSOR_SDK_WEBHOOK_SECRET not set; skip SDK dispatcher");
    process.exit(0);
  }

  // Exact workspace → bearer from channels.yml token_env (PR 46 hierarchy).
  const tokens = loadWorkspaceTokens();
  if (tokens.length === 0) {
    logger.error("no workspace tokens loaded: every fs/jobs call would 401 (set the token_env vars from channels.yml)");
  }
  const byWorkspace = new Map(tokens.map((t) => [t.workspace, t.token]));

  const runtime = createCursorSdkRuntime({
    apiKey: env.apiKey,
    model: env.model,
    cwd: env.agentCwd,
  });
  const dispatcher = new SdkDispatcher({
    runtime,
    morpheusBaseUrl: env.morpheusBaseUrl,
    tokenFor: (namespace) => byWorkspace.get(namespace) ?? null,
    // Sibling-held secrets are scrubbed from job content/snippets before any
    // prompt is built, on top of the Mini-side redaction.
    redactValues: [env.apiKey, env.webhookSecret],
  });

  await dispatcher.start();
  const server = startSdkWebhookServer(env, dispatcher);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ sig }, "SDK dispatcher shutting down");
    try {
      server.stop();
      await dispatcher.stop();
    } catch (err) {
      logger.error({ err }, "SDK dispatcher shutdown error");
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("SDK dispatcher running; awaiting job packs. Ctrl-C to stop.");
}

main().catch((err) => {
  logger.error({ err }, "SDK dispatcher fatal");
  process.exit(1);
});
