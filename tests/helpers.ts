import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resetDbForTest } from "../src/storage/db.ts";

/**
 * Per-suite isolated DB. Call in a beforeAll hook; returns a cleanup function
 * to call in afterAll. Sets MORPHEUS_DB_PATH so any module reading it picks
 * up the temp file.
 */
export function withTempDb(): { cleanup: () => void; path: string } {
  const dir = mkdtempSync(resolve(tmpdir(), "morpheus-test-"));
  const path = resolve(dir, "test.db");
  process.env.MORPHEUS_DB_PATH = path;
  resetDbForTest();
  return {
    path,
    cleanup: () => {
      resetDbForTest();
      delete process.env.MORPHEUS_DB_PATH;
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
