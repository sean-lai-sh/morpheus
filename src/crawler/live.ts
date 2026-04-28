import type { Client } from "discord.js";
import cron, { type ScheduledTask } from "node-cron";
import { registerLiveHandlers } from "../bot/events.ts";
import { loadChannels } from "../config.ts";
import { logger } from "../logger.ts";
import { backupDb } from "../storage/backup.ts";
import { reconcileAll } from "./reconcile.ts";

let reconcileTask: ScheduledTask | undefined;
let backupTask: ScheduledTask | undefined;

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
  reconcileTask = undefined;
  backupTask = undefined;
}
