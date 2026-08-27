import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resetDbForTest } from "../src/storage/db.ts";
import { resetEnvForTest } from "../src/config.ts";

/**
 * Per-suite isolated DB. Call in a beforeAll hook; returns a cleanup function
 * to call in afterAll. Sets MORPHEUS_DB_PATH so any module reading it picks
 * up the temp file.
 */
export function withTempDb(): { cleanup: () => void; path: string } {
  const dir = mkdtempSync(resolve(tmpdir(), "morpheus-test-"));
  const path = resolve(dir, "test.db");
  process.env.MORPHEUS_DB_PATH = path;
  process.env.DISCORD_TOKEN = "test-token";
  process.env.DISCORD_GUILD_ID = "987654321098765432";
  resetDbForTest();
  resetEnvForTest();
  return {
    path,
    cleanup: () => {
      resetDbForTest();
      resetEnvForTest();
      delete process.env.MORPHEUS_DB_PATH;
      delete process.env.DISCORD_TOKEN;
      delete process.env.DISCORD_BOT_TOKEN;
      delete process.env.DISCORD_GUILD_ID;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Per-suite isolated working directory. Sets process.cwd() to a temp dir so
 * that markdown writes to data/discord/ stay sandboxed. Returns the original
 * cwd so the caller can restore it.
 */
export function withTempCwd(): { cleanup: () => void; dir: string } {
  const original = process.cwd();
  const dir = mkdtempSync(resolve(tmpdir(), "morpheus-cwd-"));
  process.chdir(dir);
  return {
    dir,
    cleanup: () => {
      process.chdir(original);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Canonical workspace fixture
// ---------------------------------------------------------------------------

/**
 * Scoped API bearers for the canonical fixture. Must be >= 16 chars, distinct
 * from each other, and distinct from the Discord bot token (`test-token`).
 */
export const WORKSPACE_TOKENS = {
  leadership: "tok-leadership-0123456789",
  eboard: "tok-eboard-0123456789",
  "programs-mentorship": "tok-pm-0123456789abc",
  "programs-dev": "tok-pd-0123456789abc",
} as const;

/** channels.yml `token_env` name per workspace, matching CANONICAL_CHANNELS_YML. */
export const WORKSPACE_TOKEN_ENV = {
  leadership: "MORPHEUS_API_TOKEN_LEADERSHIP",
  eboard: "MORPHEUS_API_TOKEN_EBOARD",
  "programs-mentorship": "MORPHEUS_API_TOKEN_PM",
  "programs-dev": "MORPHEUS_API_TOKEN_PD",
} as const;

/**
 * The workspace tree shared by every suite:
 *
 *   leadership
 *   └── eboard
 *       ├── programs-mentorship
 *       └── programs-dev
 */
export const CANONICAL_CHANNELS_YML = `
guild_id: "987654321098765432"
workspaces:
  leadership: { token_env: MORPHEUS_API_TOKEN_LEADERSHIP }
  eboard: { parent: leadership, token_env: MORPHEUS_API_TOKEN_EBOARD }
  programs-mentorship: { parent: eboard, token_env: MORPHEUS_API_TOKEN_PM }
  programs-dev: { parent: eboard, token_env: MORPHEUS_API_TOKEN_PD }
channels:
  - { id: "1001", name: sponsors, category: eboard-teams, workspace: eboard, include_threads: true }
  - { id: "2002", name: leadership-team, category: eboard-teams, workspace: leadership, include_threads: true }
  - { id: "3003", name: mentorship-chat, category: programs, workspace: programs-mentorship, include_threads: true }
  - { id: "4004", name: dev-chat, category: programs, workspace: programs-dev, include_threads: true }
  - { id: "5005", name: general-chat, workspace: eboard }
defaults:
  confidence_threshold: 0.5
  reconcile_lookback: 200
  reconcile_interval_hours: 6
`;

/**
 * Write the canonical channels.yml into `<dir>/config/channels.yml`.
 * Call `resetChannelsForTest()` afterwards so the next load re-reads it.
 */
export function writeCanonicalChannels(dir: string = process.cwd(), body = CANONICAL_CHANNELS_YML): string {
  const path = resolve(dir, "config/channels.yml");
  mkdirSync(resolve(dir, "config"), { recursive: true });
  writeFileSync(path, body, "utf8");
  return path;
}

/** Put every canonical workspace bearer into process.env. */
export function setWorkspaceTokenEnv(): void {
  for (const [ws, envName] of Object.entries(WORKSPACE_TOKEN_ENV)) {
    process.env[envName] = WORKSPACE_TOKENS[ws as keyof typeof WORKSPACE_TOKENS];
  }
}

/** Remove every canonical workspace bearer from process.env. */
export function clearWorkspaceTokenEnv(): void {
  for (const envName of Object.values(WORKSPACE_TOKEN_ENV)) {
    delete process.env[envName];
  }
}
