import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import { upsertMessage } from "../src/storage/messages.ts";
import {
  bumpAttempts,
  dequeueBatch,
  enqueue,
  queueDepth,
  removeFromQueue,
} from "../src/storage/queue.ts";

const t = withTempDb();
beforeAll(() => {
  for (let i = 1; i <= 5; i++) {
    upsertMessage({
      id: `q${i}`,
      channelId: "c1",
      authorId: "u1",
      authorName: "alice",
      content: `m${i}`,
      createdAt: 1_000 + i,
    });
  }
});
afterAll(() => t.cleanup());

describe("storage/queue", () => {
  test("enqueue is idempotent on message_id", () => {
    enqueue("q1", 100);
    enqueue("q1", 200); // second call no-op
    expect(queueDepth()).toBe(1);
  });

  test("dequeueBatch returns oldest first", () => {
    enqueue("q2", 50); // older than q1's 100
    const batch = dequeueBatch(10);
    expect(batch.map((r) => r.message_id)).toEqual(["q2", "q1"]);
  });

  test("bumpAttempts increments counter", () => {
    bumpAttempts(["q1"]);
    const batch = dequeueBatch(10);
    const q1 = batch.find((r) => r.message_id === "q1");
    expect(q1?.attempts).toBe(1);
  });

  test("removeFromQueue deletes specified entries", () => {
    removeFromQueue(["q1", "q2"]);
    expect(queueDepth()).toBe(0);
  });
});
