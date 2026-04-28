/**
 * One-shot: create a Nia filesystem namespace for data/discord/ and persist
 * the returned UUID into Doppler.
 *
 * Run with:
 *    bun run register-nia
 *
 * Re-runs are safe: if NIA_DISCORD_SOURCE_ID is already set in the current
 * Doppler config, the script just verifies and exits. Pass --force to create
 * a new namespace anyway.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../src/logger.ts";
import { createFilesystem } from "../src/nia/client.ts";

const FOLDER = resolve(process.cwd(), "data/discord");
const SOURCE_NAME = "morpheus-discord";

function dopplerSetSecret(key: string, value: string): void {
  const result = spawnSync("doppler", ["secrets", "set", `${key}=${value}`], {
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `failed to set ${key} in Doppler (status ${result.status}). ` +
        `Make sure 'doppler setup' has been run for the desired project/config.`,
    );
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const existing = process.env.NIA_DISCORD_SOURCE_ID;
  if (existing && !force) {
    logger.info(
      { source_id: existing },
      "NIA_DISCORD_SOURCE_ID already set in this Doppler config; pass --force to recreate",
    );
    return;
  }

  if (!existsSync(FOLDER)) {
    mkdirSync(FOLDER, { recursive: true });
    logger.info({ folder: FOLDER }, "created data/discord/ (it was missing)");
  }

  logger.info({ name: SOURCE_NAME }, "creating Nia filesystem namespace");
  const created = await createFilesystem(
    SOURCE_NAME,
    "Discord channel markdown for Morpheus bot",
  );
  logger.info({ source_id: created.id, name: created.name }, "Nia filesystem created");

  dopplerSetSecret("NIA_DISCORD_SOURCE_ID", created.id);
  logger.info("NIA_DISCORD_SOURCE_ID written to Doppler. Mirror to prod when ready:");
  console.log(`\n  doppler secrets set NIA_DISCORD_SOURCE_ID=${created.id} --config prod\n`);
}

main().catch((err) => {
  logger.error({ err }, "register-nia failed");
  process.exit(1);
});
