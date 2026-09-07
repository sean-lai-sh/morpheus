import { describe, expect, test } from "bun:test";
import { archivedBeforeCursor } from "../src/crawler/threads.ts";

describe("archivedBeforeCursor", () => {
  test("returns the oldest archiveTimestamp on the page", () => {
    const threads = [
      { id: "1", archiveTimestamp: 3_000 },
      { id: "2", archiveTimestamp: 1_000 },
      { id: "3", archiveTimestamp: 2_000 },
    ];
    expect(archivedBeforeCursor(threads as any)).toBe(1_000);
  });

  test("falls back to archivedAt when archiveTimestamp is missing", () => {
    const threads = [
      { id: "1", archivedAt: new Date(5_000) },
      { id: "2", archiveTimestamp: 4_000 },
    ];
    expect(archivedBeforeCursor(threads as any)).toBe(4_000);
  });

  test("returns undefined when no thread has an archive time", () => {
    expect(archivedBeforeCursor([{ id: "1" }, { id: "2" }] as any)).toBeUndefined();
  });
});
