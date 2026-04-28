import type { Client } from "discord.js";
import cron, { type ScheduledTask } from "node-cron";
import { registerLiveHandlers } from "../bot/events.ts";
import { loadChannels } from "../config.ts";
import { logger } from "../logger.ts";
import { backupDb } from "../storage/backup.ts";
import { getState } from "../storage/crawl-state.ts";
import { backfillAll } from "./backfill.ts";
import { reconcileAll } from "./reconcile.ts";

let reconcileTask: ScheduledTask | undefined;
let backupTask: ScheduledTask | undefined;
let autoBackfillTask: ScheduledTask | undefined;

/**
 * Wire live event handlers onto an already-logged-in client and schedule
 * periodic reconciliation. Long-running.
 */
export function startLive(client: Client): void {
  registerLiveHandlers(client);
  logger.info("live event subscriber attached");

  const intervalHours = loadChannels().defaults.reconcile_interval_hours;
  // node-cron syntax: at minute 0 every N hours.
  const expr = `0 */${intervalHours} * * *`;
  reconcileTask = cron.schedule(expr, async () => {
    logger.info({ expr }, "scheduled reconcile starting");
    try {
      await reconcileAll(client);
    } catch (err) {
      logger.error({ err }, "scheduled reconcile failed");
    }
  });
  logger.info({ cron: expr, interval_hours: intervalHours }, "reconcile scheduled");

  // Hourly check: trigger backfill for any channels not yet fully backfilled.
  autoBackfillTask = cron.schedule("0 * * * *", async () => {
    const pending = loadChannels().channels.filter(
      (c) => !getState(c.id)?.last_backfill_complete,
    );
    if (pending.length === 0) return;
    logger.info({ channels: pending.map((c) => c.id) }, "auto-backfill: channels not yet complete");
    try {
      await backfillAll(client, (c) => !getState(c.id)?.last_backfill_complete);
    } catch (err) {
      logger.error({ err }, "auto-backfill failed");
    }
  });
  logger.info("auto-backfill scheduled (hourly, skips complete channels)");

  // Nightly DB backup at 03:17 (off-hour to avoid clashing with reconcile)
  backupTask = cron.schedule("17 3 * * *", () => {
    try {
      backupDb();
    } catch (err) {
      logger.error({ err }, "nightly backup failed");
    }
  });
  logger.info({ cron: "17 3 * * *" }, "nightly db backup scheduled");
}

export function stopLive(): void {
  reconcileTask?.stop();
  backupTask?.stop();
  autoBackfillTask?.stop();
  reconcileTask = undefined;
  backupTask = undefined;
  autoBackfillTask = undefined;
}
