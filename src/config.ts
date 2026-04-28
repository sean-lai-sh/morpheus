import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: z.string().regex(/^\d+$/, "must be a numeric snowflake"),
  NVIDIA_API_KEY: z.string().min(1).optional(),
  NIA_API_KEY: z.string().min(1).optional(),
  NIA_BASE_URL: z.string().url().default("https://api.trynia.ai"),
  NIA_DISCORD_SOURCE_ID: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  RETENTION_MONTHS: z
    .preprocess((v) => (v === "" || v == null ? undefined : v), z.coerce.number().int().min(1).optional()),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

const channelSchema = z.object({
  id: z.string().regex(/^\d+$/),
  name: z.string().min(1),
  classify: z.boolean().default(true),
  confidence_threshold: z.number().min(0).max(1).optional(),
});

const channelsConfigSchema = z.object({
  guild_id: z.string().regex(/^\d+$/),
  channels: z.array(channelSchema).min(1),
  defaults: z
    .object({
      confidence_threshold: z.number().min(0).max(1).default(0.5),
      reconcile_lookback: z.number().int().min(1).max(1000).default(200),
      reconcile_interval_hours: z.number().int().min(1).default(6),
    })
    .default({
      confidence_threshold: 0.5,
      reconcile_lookback: 200,
      reconcile_interval_hours: 6,
    }),
});

export type Channel = z.infer<typeof channelSchema>;
export type ChannelsConfig = z.infer<typeof channelsConfigSchema>;

let _env: Env | undefined;
let _channels: ChannelsConfig | undefined;
const channelsPath = resolve(process.cwd(), "config/channels.yml");

export function loadEnv(): Env {
  if (_env) return _env;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(
      `Invalid environment. Check Doppler config and .env.example. Issues:\n${issues}\n\n` +
        `Run with: doppler run -- bun src/index.ts <cmd>`,
    );
  }
  _env = parsed.data;
  return _env;
}

export function loadChannels(): ChannelsConfig {
  if (_channels) return _channels;
  const raw = readFileSync(channelsPath, "utf8");
  const parsed = channelsConfigSchema.safeParse(parseYaml(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid config/channels.yml:\n${issues}`);
  }
  _channels = parsed.data;
  return _channels;
}

export function reloadChannels(): ChannelsConfig {
  _channels = undefined;
  return loadChannels();
}

export function isChannelAllowed(channelId: string): boolean {
  return loadChannels().channels.some((c) => c.id === channelId);
}

export function getChannel(channelId: string): Channel | undefined {
  return loadChannels().channels.find((c) => c.id === channelId);
}
