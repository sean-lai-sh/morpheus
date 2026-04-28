import { logger } from "../logger.ts";
import {
  getSyncState,
  markSyncFailure,
  markSyncSuccess,
} from "../storage/sync-state.ts";
import { DISCORD_DIR } from "../storage/markdown.ts";
import { NiaApiError, syncSource } from "./client.ts";

const POLL_INTERVAL_MS = 60_000;
const ALERT_AFTER_FAILURES = 10;

let pollerHandle: ReturnType<typeof setInterval> | undefined;
let inFlight = false;

async function flushIfDirty(): Promise<void> {
  if (inFlight) return;
  const state = getSyncState(DISCORD_DIR);
  if (!state.dirty) return;
  inFlight = true;
  try {
    const sourceId = process.env.NIA_DISCORD_SOURCE_ID;
    if (!sourceId) {
      logger.warn(
        "NIA_DISCORD_SOURCE_ID not set; skipping sync. Run `bun run register-nia` first.",
      );
      return;
    }
    await syncSource(sourceId);
    markSyncSuccess(DISCORD_DIR);
    logger.info({ source_id: sourceId }, "nia sync succeeded");
  } catch (err) {
    const failures = markSyncFailure(DISCORD_DIR);
    if (err instanceof NiaApiError && err.status >= 400 && err.status < 500) {
      logger.error(
        { status: err.status, body: err.body.slice(0, 300) },
        "nia sync 4xx (auth/config issue, not transient)",
      );
    } else {
      logger.warn({ err, failures }, "nia sync failed; will retry next poll");
    }
    if (failures >= ALERT_AFTER_FAILURES) {
      logger.error({ failures }, "nia sync repeatedly failing — investigate");
    }
  } finally {
    inFlight = false;
  }
}

/**
 * Start a 60s poller that flushes the dirty flag to Nia.
 * Acts as both debounce (writes accumulate within the window) and retry
 * (failed flushes leave dirty=1 and get re-attempted next tick).
 */
export function startSyncer(): void {
  if (pollerHandle) return;
  pollerHandle = setInterval(() => void flushIfDirty(), POLL_INTERVAL_MS);
  pollerHandle.unref();
  logger.info({ interval_ms: POLL_INTERVAL_MS }, "nia syncer started");
}

export function stopSyncer(): void {
  if (pollerHandle) clearInterval(pollerHandle);
  pollerHandle = undefined;
}

/** Force a flush right now. Used at end of backfill or on graceful shutdown. */
export async function flushNow(): Promise<void> {
  await flushIfDirty();
}
