/**
 * One-shot: create Nia filesystem namespaces for the general and leadership
 * Discord indexes, then persist the returned UUIDs into Doppler.
 *
 * Run with:
 *    bun run register-nia
 *
 * Re-runs are safe: existing source IDs are skipped unless --force is passed.
 * Pass --force to create fresh namespaces (abandons old ones in Nia).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { logger } from "../src/logger.ts";
import { GENERAL_DIR, LEADERSHIP_DIR } from "../src/storage/markdown.ts";
import { createFilesystem } from "../src/nia/client.ts";

interface SourceDef {
  envVar: string;
  name: string;
  description: string;
  dir: string;
}

const SOURCES: SourceDef[] = [
  {
    envVar: "NIA_DISCORD_SOURCE_ID",
    name: "morpheus-discord-general",
    description: "Discord channel markdown for Morpheus bot (all channels except leadership)",
    dir: GENERAL_DIR,
  },
  {
    envVar: "NIA_DISCORD_LEADERSHIP_SOURCE_ID",
    name: "morpheus-discord-leadership",
    description: "Discord leadership-team markdown for Morpheus bot (isolated index)",
    dir: LEADERSHIP_DIR,
  },
];

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

  for (const src of SOURCES) {
    const existing = process.env[src.envVar];
    if (existing && !force) {
      logger.info(
        { source_id: existing, env: src.envVar },
        "already set in Doppler; pass --force to recreate",
      );
      continue;
    }

    mkdirSync(src.dir, { recursive: true });

    logger.info({ name: src.name }, "creating Nia filesystem namespace");
    const created = await createFilesystem(src.name, src.description);
    logger.info({ source_id: created.id, name: created.name }, "Nia filesystem created");

    dopplerSetSecret(src.envVar, created.id);
    logger.info({ env: src.envVar }, `written to Doppler. Mirror to prod when ready:`);
    console.log(`\n  doppler secrets set ${src.envVar}=${created.id} --config prod\n`);
  }
}

main().catch((err) => {
  logger.error({ err }, "register-nia failed");
  process.exit(1);
});
