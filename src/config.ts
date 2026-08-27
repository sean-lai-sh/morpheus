import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { isAllowedListenHost } from "./http/listen-allowlist.ts";
import { isDiscordWebhookUrl } from "./notify/webhooks.ts";

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

/** Workspace ids are single lowercase slug segments — they become the first index-path segment. */
export const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

const parseIdList = (v: unknown) => {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
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
            if (isDiscordWebhookUrl(parsed.href)) return false;
            return true;
          } catch {
            return false;
          }
        }, "must be https, must not use port 1340, and must not be a Discord incoming webhook")
        .optional(),
    ),
    GROK_BOT_WEBHOOK_SECRET: z.preprocess(emptyToUndef, z.string().min(1).optional()),
    /**
     * Workspace ids whose jobs may be POSTed to GROK_BOT_WEBHOOK_URL.
     * Comma/whitespace-separated. Empty = dispatch nothing (default deny).
     */
    GROK_DISPATCH_WORKSPACES: z.preprocess(parseIdList, z.array(z.string().regex(WORKSPACE_ID)).default([])),
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
    /** Workspace ids whose jobs may carry a GitHub issue URL. Empty = none (default deny). */
    GITHUB_ISSUES_WORKSPACES: z.preprocess(parseIdList, z.array(z.string().regex(WORKSPACE_ID)).default([])),
    RETENTION_MONTHS: z
      .preprocess((v) => (v === "" || v == null ? undefined : v), z.coerce.number().int().min(1).optional()),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  })
  .refine((e) => Boolean(e.DISCORD_BOT_TOKEN || e.DISCORD_TOKEN), {
    message: "DISCORD_BOT_TOKEN (or legacy DISCORD_TOKEN) is required",
    path: ["DISCORD_BOT_TOKEN"],
  });

export type Env = z.infer<typeof envSchema>;

const workspaceSchema = z
  .object({
    /** Parent workspace id. A token for the parent sees this workspace too. */
    parent: z.string().regex(WORKSPACE_ID).optional(),
    /** Env var holding the scoped API bearer for this workspace. Unset = no HTTP access. */
    token_env: z.string().regex(ENV_NAME, "must be an UPPER_SNAKE env var name").optional(),
  })
  .strict();

const channelSchema = z
  .object({
    id: z.string().regex(/^\d+$/),
    name: z.string().min(1),
    classify: z.boolean().default(true),
    confidence_threshold: z.number().min(0).max(1).optional(),
    include_threads: z.boolean().default(false),
    category: z.string().optional(),
    /** Workspace this channel (and its threads) belongs to. Must exist under `workspaces:`. */
    workspace: z.string().regex(WORKSPACE_ID, "must be a single lowercase slug segment"),
  })
  .strict();

const channelsConfigSchema = z
  .object({
    guild_id: z.unknown().optional(),
    workspaces: z
      .record(z.string().regex(WORKSPACE_ID, "workspace id must be a single lowercase slug segment"), workspaceSchema)
      .refine((m) => Object.keys(m).length > 0, "at least one workspace is required"),
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
  })
  .superRefine((cfg, ctx) => {
    const ids = new Set(Object.keys(cfg.workspaces));
    cfg.channels.forEach((c, i) => {
      if (!ids.has(c.workspace)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["channels", i, "workspace"],
          message: `unknown workspace "${c.workspace}" (declare it under workspaces:)`,
        });
      }
    });
    const seenEnv = new Map<string, string>();
    for (const [id, w] of Object.entries(cfg.workspaces)) {
      if (w.parent != null) {
        if (w.parent === id) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaces", id, "parent"], message: "workspace cannot be its own parent (cycle)" });
        } else if (!ids.has(w.parent)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaces", id, "parent"], message: `unknown parent workspace "${w.parent}"` });
        }
      }
      if (w.token_env) {
        const prev = seenEnv.get(w.token_env);
        if (prev) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaces", id, "token_env"], message: `token_env must be unique (already used by "${prev}")` });
        }
        seenEnv.set(w.token_env, id);
      }
    }
    // Cycle detection: walk each parent chain.
    for (const start of ids) {
      const seen = new Set<string>();
      let cur: string | undefined = start;
      while (cur != null && ids.has(cur)) {
        if (seen.has(cur)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaces", start, "parent"], message: "workspace parent chain forms a cycle" });
          break;
        }
        seen.add(cur);
        cur = cfg.workspaces[cur]?.parent;
      }
    }
  });

export type Channel = z.infer<typeof channelSchema>;
export type WorkspaceDef = z.infer<typeof workspaceSchema>;
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

function rejectLegacyIsolated(doc: unknown): void {
  if (!doc || typeof doc !== "object") return;
  const channels = (doc as { channels?: unknown }).channels;
  if (!Array.isArray(channels)) return;
  channels.forEach((c, i) => {
    if (c && typeof c === "object" && "isolated" in c) {
      throw new Error(
        `Invalid config/channels.yml: channels[${i}].isolated was removed. ` +
          `Replace it with 'workspace: <id>' and declare the id under top-level 'workspaces:' ` +
          `(see config/channels.example.yml).`,
      );
    }
  });
}

/** Parse a channels.yml document (tests pass objects; production reads the file). */
export function parseChannelsConfig(doc: unknown): ChannelsConfig {
  rejectLegacyIsolated(doc);
  const parsed = channelsConfigSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid config/channels.yml:\n${issues}`);
  }
  return parsed.data;
}

export function loadChannels(): ChannelsConfig {
  if (_channels) return _channels;
  const raw = readFileSync(channelsPath(), "utf8");
  _channels = parseChannelsConfig(parseYaml(raw));
  return _channels;
}

function clearChannelCaches(): void {
  _channels = undefined;
  _visible.clear();
  _tokens = undefined;
}

export function reloadChannels(): ChannelsConfig {
  clearChannelCaches();
  return loadChannels();
}

/** Test-only: clear the channels cache so the next loadChannels() re-reads from disk. */
export function resetChannelsForTest(): void {
  clearChannelCaches();
}

/** Test-only: clear the env cache so the next loadEnv() re-reads from process.env. */
export function resetEnvForTest(): void {
  _env = undefined;
  _tokens = undefined;
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export function getWorkspace(id: string): WorkspaceDef | undefined {
  return loadChannels().workspaces[id];
}

export function workspaceIds(): string[] {
  return Object.keys(loadChannels().workspaces);
}

const _visible = new Map<string, ReadonlySet<string>>();

/**
 * Workspaces visible from `root`: root plus every transitive descendant.
 * Unknown root → empty set (no access). Memoized; cleared on reload.
 */
export function visibleWorkspaces(root: string): ReadonlySet<string> {
  const cached = _visible.get(root);
  if (cached) return cached;
  const all = loadChannels().workspaces;
  const out = new Set<string>();
  if (root in all) {
    const queue = [root];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (out.has(cur)) continue;
      out.add(cur);
      for (const [id, w] of Object.entries(all)) {
        if (w.parent === cur && !out.has(id)) queue.push(id);
      }
    }
  }
  _visible.set(root, out);
  return out;
}

export interface WorkspaceToken {
  workspace: string;
  envName: string;
  token: string;
}

let _tokens: WorkspaceToken[] | undefined;

/**
 * Scoped API bearers, one per workspace that declares `token_env`.
 * Validated in a second pass because the env names come from channels.yml.
 * Declared-but-unset is allowed (that workspace has no HTTP access).
 * Throws when two tokens collide or a token equals the Discord bot token.
 */
export function loadWorkspaceTokens(env: NodeJS.ProcessEnv = process.env): WorkspaceToken[] {
  if (_tokens) return _tokens;
  const entries = Object.entries(loadChannels().workspaces).filter(
    (e): e is [string, WorkspaceDef & { token_env: string }] => Boolean(e[1].token_env),
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [, w] of entries) {
    shape[w.token_env] = z.preprocess(emptyToUndef, z.string().min(16, "must be at least 16 chars").optional());
  }
  const parsed = z.object(shape).safeParse(env);
  if (!parsed.success) throw new Error(formatEnvError(parsed.error));
  const data = parsed.data as Record<string, string | undefined>;

  let bot: string | undefined;
  try {
    bot = discordBotToken(parseEnv(env));
  } catch {
    bot = undefined;
  }

  const out: WorkspaceToken[] = [];
  for (const [workspace, w] of entries) {
    const token = data[w.token_env];
    if (!token) continue;
    if (bot && token === bot) {
      throw new Error(`Invalid environment: ${w.token_env} must not equal the Discord bot token`);
    }
    const dup = out.find((t) => t.token === token);
    if (dup) {
      throw new Error(`Invalid environment: ${w.token_env} and ${dup.envName} must be distinct`);
    }
    out.push({ workspace, envName: w.token_env, token });
  }
  _tokens = out;
  return out;
}

export function isChannelAllowed(channelId: string): boolean {
  return loadChannels().channels.some((c) => c.id === channelId);
}

export function getChannel(channelId: string): Channel | undefined {
  return loadChannels().channels.find((c) => c.id === channelId);
}
