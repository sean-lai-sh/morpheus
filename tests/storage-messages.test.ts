import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import {
  countMessages,
  getMessage,
  lastMessageAt,
  markDeleted,
  recentMessages,
  setClassification,
  upsertMessage,
} from "../src/storage/messages.ts";

const t = withTempDb();
beforeAll(() => {});
afterAll(() => t.cleanup());

describe("storage/messages", () => {
  test("upsertMessage inserts a new row", () => {
    const r = upsertMessage({
      id: "m1",
      channelId: "c1",
      authorId: "u1",
      authorName: "alice",
      content: "hello",
      createdAt: 1_000,
    });
    expect(r).toEqual({ inserted: true, edited: false });
    expect(countMessages()).toBe(1);
  });

  test("upsertMessage with same content is no-op", () => {
    const r = upsertMessage({
      id: "m1",
      channelId: "c1",
      authorId: "u1",
      authorName: "alice",
      content: "hello",
      createdAt: 1_000,
    });
    expect(r).toEqual({ inserted: false, edited: false });
  });

  test("upsertMessage with new content marks edited", () => {
    const r = upsertMessage({
      id: "m1",
      channelId: "c1",
      authorId: "u1",
      authorName: "alice",
      content: "hello world",
      createdAt: 1_000,
      editedAt: 2_000,
    });
    expect(r).toEqual({ inserted: false, edited: true });
    expect(getMessage("m1")?.content).toBe("hello world");
    expect(getMessage("m1")?.edited_at).toBe(2_000);
  });

  test("setClassification persists label and confidence", () => {
    setClassification("m1", "operational", 0.93);
    const got = getMessage("m1");
    expect(got?.classification).toBe("operational");
    expect(got?.classification_confidence).toBe(0.93);
    expect(got?.classified_at).not.toBeNull();
  });

  test("markDeleted sets deleted_at exactly once", () => {
    upsertMessage({
      id: "m2",
      channelId: "c1",
      authorId: "u2",
      authorName: "bob",
      content: "doomed",
      createdAt: 3_000,
    });
    expect(markDeleted("m2", 4_000)).toBe(true);
    expect(getMessage("m2")?.deleted_at).toBe(4_000);
    // Second call returns false (idempotent)
    expect(markDeleted("m2", 5_000)).toBe(false);
    expect(getMessage("m2")?.deleted_at).toBe(4_000);
  });

  test("recentMessages returns DESC by created_at", () => {
    upsertMessage({
      id: "m3",
      channelId: "c1",
      authorId: "u1",
      authorName: "alice",
      content: "later",
      createdAt: 10_000,
    });
    const recent = recentMessages("c1", 10);
    expect(recent[0]?.id).toBe("m3");
  });

  test("lastMessageAt returns max created_at", () => {
    expect(lastMessageAt()).toBe(10_000);
  });
});
