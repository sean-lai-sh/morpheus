import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backupDb, backupDir } from "../src/storage/backup.ts";
import { dbPath, getDb, resetDbForTest } from "../src/storage/db.ts";
import { withTempDb } from "./helpers.ts";

describe("backupDb honors MORPHEUS_DB_PATH", () => {
  const { path, cleanup } = withTempDb();

  beforeAll(() => {
    getDb();
  });

  afterAll(() => {
    cleanup();
  });

  test("dbPath() is the temp file, not data/morpheus.db", () => {
    expect(dbPath()).toBe(path);
    expect(existsSync(path)).toBe(true);
  });

  test("backupDir() is a sibling of the live DB", () => {
    expect(backupDir()).toBe(resolve(dirname(path), "backups"));
  });

  test("backupDb copies the MORPHEUS_DB_PATH file", () => {
    const dest = backupDb();
    expect(dest).toBeTruthy();
    expect(dest.startsWith(backupDir())).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(dest.includes("data/morpheus.db")).toBe(false);
  });
});

describe("backupDb skip when DB file is missing", () => {
  test("returns empty string and does not throw", () => {
    const previous = process.env.MORPHEUS_DB_PATH;
    process.env.MORPHEUS_DB_PATH = resolve("/tmp", "morpheus-missing-db-does-not-exist.db");
    resetDbForTest();
    try {
      expect(backupDb()).toBe("");
    } finally {
      if (previous === undefined) delete process.env.MORPHEUS_DB_PATH;
      else process.env.MORPHEUS_DB_PATH = previous;
      resetDbForTest();
    }
  });
});
