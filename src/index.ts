import { reloadChannels } from "./config.ts";
import { logger } from "./logger.ts";
import { closeDb, getDb } from "./storage/db.ts";
import { loginClient, shutdownClient } from "./bot/client.ts";
import { backfillAll } from "./crawler/backfill.ts";
import { reconcileAll } from "./crawler/reconcile.ts";
import { startLive, stopLive } from "./crawler/live.ts";
import { flushNow as flushNiaNow, startSyncer, stopSyncer } from "./nia/syncer.ts";
import { startHealthServer, stopHealthServer } from "./http/health.ts";

type Subcommand = "live" | "backfill" | "reconcile" | "reindex" | "rotate";

function parseArgs(argv: string[]): { cmd: Subcommand; rest: string[] } {
  const cmd = argv[2] as Subcommand | undefined;
  if (!cmd) {
    console.error("usage: bun src/index.ts <live|backfill|reconcile|reindex|rotate> [...]");
    process.exit(1);
  }
  return { cmd, rest: argv.slice(3) };
}

function installShutdown(onShutdown: () => Promise<void>): void {
  let stopping = false;
  const handler = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ sig }, "shutting down");
    try {
      await onShutdown();
    } catch (err) {
      logger.error({ err }, "shutdown error");
    } finally {
      closeDb();
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void handler("SIGINT"));
  process.on("SIGTERM", () => void handler("SIGTERM"));
  process.on("SIGHUP", () => {
    try {
      reloadChannels();
      logger.info("channels.yml reloaded on SIGHUP");
    } catch (err) {
      logger.error({ err }, "SIGHUP reload failed");
    }
  });
}

async function main(): Promise<void> {
  const { cmd } = parseArgs(process.argv);
  // Ensure DB is initialized (runs migrations) before any handler touches it.
  getDb();

  switch (cmd) {
    case "live": {
      const client = await loginClient();
      startLive(client);
      startSyncer();
      startHealthServer();
      installShutdown(async () => {
        stopLive();
        stopSyncer();
        stopHealthServer();
        await flushNiaNow();
        await shutdownClient();
      });
      logger.info("running live; awaiting events. Ctrl-C to stop.");
      return;
    }
    case "backfill": {
      const client = await loginClient();
      try {
        await backfillAll(client);
        await flushNiaNow();
      } finally {
        await shutdownClient();
        closeDb();
      }
      return;
    }
    case "reconcile": {
      const client = await loginClient();
      try {
        await reconcileAll(client);
        await flushNiaNow();
      } finally {
        await shutdownClient();
        closeDb();
      }
      return;
    }
    case "reindex": {
      const { reindexAll } = await import("./tasks/reindex.ts");
      reindexAll();
      closeDb();
      return;
    }
    case "rotate": {
      const { rotate } = await import("./tasks/rotate.ts");
      rotate();
      closeDb();
      return;
    }
    default: {
      const _exhaustive: never = cmd;
      void _exhaustive;
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
