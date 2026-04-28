import { mkdtempSync, rmSync } from "node:fs";
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
