import { Client, GatewayIntentBits, Partials } from "discord.js";
import { loadEnv } from "../config.ts";
import { logger } from "../logger.ts";

let _client: Client | undefined;

export function getClient(): Client {
  if (_client) return _client;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    // Enable partials so MessageDelete events fire for uncached messages
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  });

  client.on("error", (err) => logger.error({ err }, "discord client error"));
  client.on("warn", (msg) => logger.warn({ msg }, "discord client warn"));
  client.once("ready", (c) =>
    logger.info({ user: c.user.tag, id: c.user.id }, "discord client ready"),
  );

  _client = client;
  return client;
}

export async function loginClient(): Promise<Client> {
  const env = loadEnv();
  const client = getClient();
  if (!client.isReady()) await client.login(env.DISCORD_TOKEN);
  return client;
}

export async function shutdownClient(): Promise<void> {
  if (_client) {
    await _client.destroy();
    _client = undefined;
  }
}
