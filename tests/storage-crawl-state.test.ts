import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import {
  ensureState,
  getState,
  markBackfillComplete,
  markReconciled,
  setNewestSeen,
  setOldestSeen,
} from "../src/storage/crawl-state.ts";

const t = withTempDb();
beforeAll(() => {});
afterAll(() => t.cleanup());

describe("storage/crawl-state", () => {
  test("ensureState creates a row if missing", () => {
    ensureState("c1");
    expect(getState("c1")?.channel_id).toBe("c1");
  });

  test("setOldestSeen only moves cursor backward (smaller snowflake)", () => {
    setOldestSeen("c1", "1000");
    setOldestSeen("c1", "1500"); // larger; should be ignored
    expect(getState("c1")?.oldest_seen_id).toBe("1000");
    setOldestSeen("c1", "500"); // smaller; should be applied
    expect(getState("c1")?.oldest_seen_id).toBe("500");
  });

  test("setNewestSeen only moves cursor forward (larger snowflake)", () => {
    setNewestSeen("c1", "2000");
    setNewestSeen("c1", "1500"); // smaller; should be ignored
    expect(getState("c1")?.newest_seen_id).toBe("2000");
    setNewestSeen("c1", "3000");
    expect(getState("c1")?.newest_seen_id).toBe("3000");
  });

  test("markBackfillComplete sets the flag", () => {
    markBackfillComplete("c1");
    expect(getState("c1")?.last_backfill_complete).toBe(1);
  });

  test("markReconciled sets timestamp", () => {
    markReconciled("c1", 9_999);
    expect(getState("c1")?.last_reconciled_at).toBe(9_999);
  });
});
