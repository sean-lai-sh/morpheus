/**
 * One-shot Mini weekday digest: classify recent index hits and POST DIGEST
 * payloads through the existing src/notify postFeed webhooks.
 *
 *   bun run digest
 *   bun run digest -- --force    # run on Sat/Sun too; still default-OFF without MINI_DIGEST_ENABLED
 *
 * Same Doppler project/config as the rest of Mini. Never pass a webhook URL on the CLI.
 */
import { runWeekdayDigest } from "../src/digest/weekday.ts";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const result = await runWeekdayDigest({ force: hasFlag("force") });
  if (!result.ran) {
    console.error(`digest skipped: ${result.skipped ?? "unknown"}`);
    process.exit(0);
  }

  let failed = false;
  for (const [channel, row] of Object.entries(result.channels)) {
    if (row.posted) {
      console.error(`#${channel}: posted ${row.hits} hit(s)`);
      continue;
    }
    console.error(`#${channel}: skipped (${row.skipped ?? "unknown"}, hits=${row.hits})`);
    if (row.skipped && !["empty", "missing-webhook-url", "already-posted", "disabled", "weekend"].includes(row.skipped)) {
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
