/**
 * One-shot: fetch all guild members and populate the users table with their
 * server nicknames and global names. Run after backfill to ensure display names
 * are resolved correctly for historical messages ingested without a cached member.
 *
 * Run with:
 *    bun run refresh-members
 */
import { Client, GatewayIntentBits } from "discord.js";
import { loadEnv } from "../src/config.ts";
import { logger } from "../src/logger.ts";
import { upsertUser } from "../src/storage/users.ts";

async function main(): Promise<void> {
  const env = loadEnv();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  await client.login(env.DISCORD_TOKEN);
  logger.info("logged in; fetching guild members");

  const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
  const members = await guild.members.fetch();

  let count = 0;
  for (const [, member] of members) {
    upsertUser(
      member.id,
      member.user.username ?? null,
      member.nickname ?? null,
      member.user.globalName ?? null,
    );
    count++;
  }

  logger.info({ count }, "member refresh complete");
  await client.destroy();
}

main().catch((err) => {
  logger.error({ err }, "refresh-members failed");
  process.exit(1);
});
