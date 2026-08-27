import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import { getSyncState, markDirty } from "../src/storage/sync-state.ts";

const t = withTempDb();
beforeAll(() => {});
afterAll(() => t.cleanup());

describe("storage/export-dirty-state", () => {
  test("getSyncState lazily creates a row", () => {
    const s = getSyncState("/tmp/x");
    expect(s.dirty).toBe(0);
  });

  test("markDirty flips dirty=1", () => {
    markDirty("/tmp/x");
    expect(getSyncState("/tmp/x").dirty).toBe(1);
  });
});
