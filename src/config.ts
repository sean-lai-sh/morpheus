import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { isAllowedListenHost } from "./http/listen-allowlist.ts";

const emptyToUndef = (v: unknown) => {
  if (v == null) return undefined;
  if (typeof v === "string" && v.trim() === "") return undefined;
  return v;
};

const parseBoolish = (v: unknown) => {
  if (v == null || v === "") return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "1" || s === "true" || s === "yes") return true;
    if (s === "0" || s === "false" || s === "no") return false;
  }
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
            const parsed = new URL(u);
            if (parsed.protocol !== "https:") return false;
            if (parsed.port === "1340") return false;
            return true;
          } catch {
            return false;
          }
        }, "must be https and must not use port 1340")
        .optional(),
    ),
    GROK_BOT_WEBHOOK_SECRET: z.preprocess(emptyToUndef, z.string().min(1).optional()),
    /**
     * Leadership jobs POST to GROK_BOT_WEBHOOK_URL (full isolated namespace).
     * Default true: general is channel-scoped, so leadership can dispatch.
     * Set false to skip Mini→Grok for isolated jobs.
     */
    GROK_DISPATCH_LEADERSHIP: z.preprocess(parseBoolish, z.boolean().default(true)),
    GROK_DISPATCH_TIMEOUT_MS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(1_000).max(120_000).default(10_000),
    ),
    NVIDIA_API_KEY: z.string().min(1).optional(),
    LOG_LEVEL: z.string().default("info"),
    HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    /** Bind address for Morpheus HTTP. Loopback or Tailscale only. Default 127.0.0.1. */
    HEALTH_HOST: z.preprocess(
      emptyToUndef,
      z
        .string()
        .min(1)
        .default("127.0.0.1")
        .refine(
          isAllowedListenHost,
          "must be loopback (127.0.0.1 / ::1) or Tailscale (100.64/10 or fd7a:)",
        ),
    ),
    MORPHEUS_API_TOKEN_GENERAL: z.preprocess(emptyToUndef, z.string().min(1).optional()),
    MORPHEUS_API_TOKEN_LEADERSHIP: z.preprocess(emptyToUndef, z.string().min(1).optional()),
    JOB_QUEUE_ENABLED: z.preprocess(parseBoolish, z.boolean().default(true)),
    JOB_TRIGGER_ROLE_IDS: z.preprocess(emptyToUndef, z.string().optional()),
    JOB_MAX_OUTSTANDING_PER_AUTHOR: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(1).max(100).default(2),
    ),
    JOB_MAX_PER_AUTHOR_PER_HOUR: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(1).max(1000).default(5),
    ),
    JOB_CLAIM_LEASE_MS: z.preprocess(
      emptyToUndef,
      z.coerce.number().int().min(1_000).max(86_400_000).default(600_000),
    ),
    DISCORD_POST_REPLIES: z.preprocess(parseBoolish, z.boolean().default(true)),
    GITHUB_ISSUE_REPO: z.preprocess(emptyToUndef, z.string().min(1).optional()),
    OPEN_GITHUB_ISSUES_FROM_LEADERSHIP: z.preprocess(parseBoolish, z.boolean().default(false)),
    JOB_WORKER_GENERAL: z.preprocess(emptyToUndef, z.string().min(1).optional()),
    JOB_WORKER_LEADERSHIP: z.preprocess(emptyToUndef, z.string().min(1).optional()),
    RETENTION_MONTHS: z
      .preprocess((v) => (v === "" || v == null ? undefined : v), z.coerce.number().int().min(1).optional()),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  })
  .refine((e) => Boolean(e.DISCORD_BOT_TOKEN || e.DISCORD_TOKEN), {
    message: "DISCORD_BOT_TOKEN (or legacy DISCORD_TOKEN) is required",
    path: ["DISCORD_BOT_TOKEN"],
  })
  .refine(
    (e) =>
      !e.MORPHEUS_API_TOKEN_GENERAL ||
      !e.MORPHEUS_API_TOKEN_LEADERSHIP ||
      e.MORPHEUS_API_TOKEN_GENERAL !== e.MORPHEUS_API_TOKEN_LEADERSHIP,
    {
      message: "MORPHEUS_API_TOKEN_GENERAL and MORPHEUS_API_TOKEN_LEADERSHIP must differ",
      path: ["MORPHEUS_API_TOKEN_LEADERSHIP"],
    },
  );

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

function formatEnvError(error: z.ZodError): string {
  const issues = error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
  return (
    `Invalid environment. Check Doppler config and .env.example. Issues:\n${issues}\n\n` +
    `Run with: bun src/index.ts <cmd>  (Mini: doppler run -- bun src/index.ts <cmd>)`
  );
}

/** Parse env through the zod schema. Tests pass overlays here — do not read process.env ad hoc. */
export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) throw new Error(formatEnvError(parsed.error));
  return parsed.data;
}

let _env: Env | undefined;
let _channels: ChannelsConfig | undefined;
// Resolved lazily so tests that chdir before calling loadChannels() get the right file.
function channelsPath(): string {
  return resolve(process.cwd(), "config/channels.yml");
}

export function loadEnv(): Env {
  if (_env) return _env;
  _env = parseEnv();
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

/** Bind Morpheus HTTP to Tailscale or loopback — never a public NIC by default. */
export function httpBindHostname(env: Env = loadEnv()): string {
  return env.HEALTH_HOST;
}

/** Comma/whitespace-separated snowflakes. Empty set → fail closed on enqueue. */
export function jobTriggerRoleIds(env: Env = loadEnv()): Set<string> {
  const raw = env.JOB_TRIGGER_ROLE_IDS ?? "";
  return new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
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
