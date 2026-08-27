import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetChannelsForTest } from "../src/config.ts";
import { withTempCwd, withTempDb, writeCanonicalChannels } from "./helpers.ts";

const cwd = withTempCwd();
writeCanonicalChannels();
const db = withTempDb();

beforeAll(() => { resetChannelsForTest(); });
afterAll(() => {
  resetChannelsForTest();
  db.cleanup();
  cwd.cleanup();
});

function buildMessage(opts: {
  id: string;
  channelId: string;
  content: string;
  createdTimestamp?: number;
}): any {
  return {
    id: opts.id,
    channelId: opts.channelId,
    content: opts.content,
    createdTimestamp: opts.createdTimestamp ?? 1_000,
    editedTimestamp: null,
    author: { id: "u1", username: "alice", globalName: "alice", bot: false },
    member: { displayName: "alice" },
  };
}

describe("thread support: allowlist check", () => {
  test("thread of channel with include_threads:true is allowed", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(
      buildMessage({ id: "t1", channelId: "thread-1001", content: "thread reply here" }),
      "1001", // parent is channel 1001 (eboard), which has include_threads:true
    );
    expect(r.action).toBe("inserted");
  });

  test("thread of channel with include_threads:false is dropped", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(
      buildMessage({ id: "t2", channelId: "thread-5005", content: "should be skipped" }),
      "5005", // parent is channel 5005, which leaves include_threads at its false default
    );
    expect(r.action).toBe("skipped");
    expect(r.reason).toBe("channel-not-allowlisted");
  });

  test("thread of non-allowlisted parent is dropped", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(
      buildMessage({ id: "t3", channelId: "thread-999", content: "unknown parent thread" }),
      "999", // not in channels.yml at all
    );
    expect(r.action).toBe("skipped");
    expect(r.reason).toBe("channel-not-allowlisted");
  });
});

describe("thread support: storage", () => {
  test("thread message is stored with parent_channel_id set", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const { getMessage, effectiveChannelId } = await import("../src/storage/messages.ts");
    await ingestMessage(
      buildMessage({ id: "t4", channelId: "thread-1001a", content: "stored with parent" }),
      "1001",
    );
    const row = getMessage("t4");
    expect(row).not.toBeNull();
    expect(row!.channel_id).toBe("thread-1001a");
    expect(row!.parent_channel_id).toBe("1001");
    expect(effectiveChannelId(row!)).toBe("1001");
  });

  test("regular channel message has null parent_channel_id", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const { getMessage, effectiveChannelId } = await import("../src/storage/messages.ts");
    await ingestMessage(
      buildMessage({ id: "t5", channelId: "1001", content: "regular channel message" }),
    );
    const row = getMessage("t5");
    expect(row!.parent_channel_id).toBeNull();
    expect(effectiveChannelId(row!)).toBe("1001");
  });

  test("messagesForChannelAsc includes thread messages when querying parent", async () => {
    const { messagesForChannelAsc } = await import("../src/storage/messages.ts");
    const rows = messagesForChannelAsc("1001");
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("t4"); // thread message stored under thread-1001a but parent=1001
    expect(ids).toContain("t5"); // regular channel message
  });
});

describe("thread support: spawn node (thread_id)", () => {
  test("thread message stores thread_id equal to message channelId", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const { getMessage } = await import("../src/storage/messages.ts");
    await ingestMessage(
      buildMessage({ id: "t6", channelId: "thread-1001b", content: "thread reply" }),
      "1001",
      "Planning Session",
    );
    const row = getMessage("t6");
    // thread_id = message.channelId when in a thread (Discord guarantee: thread.id === starter msg id)
    expect(row!.thread_id).toBe("thread-1001b");
    expect(row!.thread_name).toBe("Planning Session");
  });

  test("main channel message has null thread_id and thread_name", async () => {
    const { getMessage } = await import("../src/storage/messages.ts");
    const row = getMessage("t5");
    expect(row!.thread_id).toBeNull();
    expect(row!.thread_name).toBeNull();
  });

  test("spawn node is identified by msg.id === msg.thread_id", async () => {
    const { upsertMessage, getMessage } = await import("../src/storage/messages.ts");
    // Simulate the starter message: its id equals the thread channel id
    upsertMessage({
      id: "thread-1001b",          // starter message id == thread channel id
      channelId: "1001",          // originally posted in main channel
      authorId: "u1",
      authorName: "alice",
      content: "started a thread here",
      createdAt: 500,
      threadId: "thread-1001b",    // set to self to mark as spawn node
      threadName: "Planning Session",
    });
    const starter = getMessage("thread-1001b")!;
    expect(starter.thread_id).toBe(starter.id);
  });

  test("thread_name is stored and retrievable", async () => {
    const { getMessage } = await import("../src/storage/messages.ts");
    const row = getMessage("t6")!;
    expect(row.thread_name).toBe("Planning Session");
  });
});
