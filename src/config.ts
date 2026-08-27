import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const emptyToUndef = (v: unknown) => {
  if (v == null) return undefined;
  if (typeof v === "string" && v.trim() === "") return undefined;
  return v;
};

const envSchema = z
  .object({
    /** Preferred name on the Mac Mini (Doppler). */
    DISCORD_BOT_TOKEN: z.preprocess(emptyToUndef, z.string().min(1).optional()),
    /** Legacy alias; still accepted. */
    DISCORD_TOKEN: z.preprocess(emptyToUndef, z.string().min(1).optional()),
    DISCORD_GUILD_ID: z.string().regex(/^\d+$/, "must be a numeric snowflake"),
    GROK_BOT_WEBHOOK_URL: z.preprocess(
      emptyToUndef,
      z
        .string()
        .url()
        .refine((u) => {
          try {
            return new URL(u).protocol === "https:";
          } catch {
            return false;
          }
        }, "must be https")
        .optional(),
    ),
    NVIDIA_API_KEY: z.string().min(1).optional(),
    NIA_API_KEY: z.string().min(1).optional(),
    NIA_BASE_URL: z.string().url().default("https://api.trynia.ai"),
    NIA_DISCORD_SOURCE_ID: z.string().optional(),
    NIA_DISCORD_LEADERSHIP_SOURCE_ID: z.string().optional(),
    LOG_LEVEL: z.string().default("info"),
    HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    RETENTION_MONTHS: z
      .preprocess((v) => (v === "" || v == null ? undefined : v), z.coerce.number().int().min(1).optional()),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  })
  .refine((e) => Boolean(e.DISCORD_BOT_TOKEN || e.DISCORD_TOKEN), {
    message: "DISCORD_BOT_TOKEN (or legacy DISCORD_TOKEN) is required",
    path: ["DISCORD_BOT_TOKEN"],
  });

export type Env = z.infer<typeof envSchema>;

const channelSchema = z.object({
  id: z.string().regex(/^\d+$/),
  name: z.string().min(1),
  classify: z.boolean().default(true),
  confidence_threshold: z.number().min(0).max(1).optional(),
  include_threads: z.boolean().default(false),
  category: z.string().optional(),
  isolated: z.boolean().default(false),
});

const channelsConfigSchema = z.object({
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
// Resolved lazily so tests that chdir before calling loadChannels() get the right file.
function channelsPath(): string {
  return resolve(process.cwd(), "config/channels.yml");
}

export function loadEnv(): Env {
  if (_env) return _env;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(
      `Invalid environment. Check Doppler config and .env.example. Issues:\n${issues}\n\n` +
        `Run with: bun src/index.ts <cmd>  (Mini: doppler run -- bun src/index.ts <cmd>)`,
    );
  }
  _env = parsed.data;
  return _env;
}

/** Official bot token. Prefers DISCORD_BOT_TOKEN; accepts legacy DISCORD_TOKEN. Mini only. */
export function discordBotToken(env: Env = loadEnv()): string {
  const token = env.DISCORD_BOT_TOKEN ?? env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN (or legacy DISCORD_TOKEN) is not set");
  }
  return token;
}

export function loadChannels(): ChannelsConfig {
  if (_channels) return _channels;
  const raw = readFileSync(channelsPath(), "utf8");
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

/** Test-only: clear the channels cache so the next loadChannels() re-reads from disk. */
export function resetChannelsForTest(): void {
  _channels = undefined;
}

/** Test-only: clear the env cache so the next loadEnv() re-reads from process.env. */
export function resetEnvForTest(): void {
  _env = undefined;
}

export function isChannelAllowed(channelId: string): boolean {
  return loadChannels().channels.some((c) => c.id === channelId);
}

export function getChannel(channelId: string): Channel | undefined {
  return loadChannels().channels.find((c) => c.id === channelId);
}
