import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import {
  getSyncState,
  markDirty,
  markSyncFailure,
  markSyncSuccess,
} from "../src/storage/sync-state.ts";

const t = withTempDb();
beforeAll(() => {});
afterAll(() => t.cleanup());

describe("storage/sync-state", () => {
  test("getSyncState lazily creates a row", () => {
    const s = getSyncState("/tmp/x");
    expect(s.dirty).toBe(0);
    expect(s.consecutive_failures).toBe(0);
  });

  test("markDirty flips dirty=1", () => {
    markDirty("/tmp/x");
    expect(getSyncState("/tmp/x").dirty).toBe(1);
  });

  test("markSyncSuccess clears dirty and resets failures", () => {
    markSyncFailure("/tmp/x");
    markSyncFailure("/tmp/x");
    expect(getSyncState("/tmp/x").consecutive_failures).toBe(2);

    markSyncSuccess("/tmp/x", 1_111);
    const s = getSyncState("/tmp/x");
    expect(s.dirty).toBe(0);
    expect(s.consecutive_failures).toBe(0);
    expect(s.last_sync_at).toBe(1_111);
  });

  test("markSyncFailure returns running count", () => {
    expect(markSyncFailure("/tmp/y")).toBe(1);
    expect(markSyncFailure("/tmp/y")).toBe(2);
    expect(markSyncFailure("/tmp/y")).toBe(3);
  });
});
