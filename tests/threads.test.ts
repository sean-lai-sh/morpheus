import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resetChannelsForTest } from "../src/config.ts";
import { withTempCwd, withTempDb } from "./helpers.ts";

function writeChannelsFixture(): void {
  mkdirSync(resolve(process.cwd(), "config"), { recursive: true });
  writeFileSync(
    resolve(process.cwd(), "config/channels.yml"),
    `
guild_id: "987654321098765432"
channels:
  - id: "100"
    name: "eboard"
    classify: false
    include_threads: true
  - id: "200"
    name: "no-threads"
    classify: false
    include_threads: false
defaults:
  confidence_threshold: 0.5
  reconcile_lookback: 200
  reconcile_interval_hours: 6
`,
    "utf8",
  );
}

const cwd = withTempCwd();
writeChannelsFixture();
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
      buildMessage({ id: "t1", channelId: "thread-111", content: "thread reply here" }),
      "100", // parent is channel 100, which has include_threads:true
    );
    expect(r.action).toBe("inserted");
  });

  test("thread of channel with include_threads:false is dropped", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(
      buildMessage({ id: "t2", channelId: "thread-222", content: "should be skipped" }),
      "200", // parent is channel 200, which has include_threads:false
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
      buildMessage({ id: "t4", channelId: "thread-100a", content: "stored with parent" }),
      "100",
    );
    const row = getMessage("t4");
    expect(row).not.toBeNull();
    expect(row!.channel_id).toBe("thread-100a");
    expect(row!.parent_channel_id).toBe("100");
    expect(effectiveChannelId(row!)).toBe("100");
  });

  test("regular channel message has null parent_channel_id", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const { getMessage, effectiveChannelId } = await import("../src/storage/messages.ts");
    await ingestMessage(
      buildMessage({ id: "t5", channelId: "100", content: "regular channel message" }),
    );
    const row = getMessage("t5");
    expect(row!.parent_channel_id).toBeNull();
    expect(effectiveChannelId(row!)).toBe("100");
  });

  test("messagesForChannelAsc includes thread messages when querying parent", async () => {
    const { messagesForChannelAsc } = await import("../src/storage/messages.ts");
    const rows = messagesForChannelAsc("100");
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("t4"); // thread message stored under thread-100a but parent=100
    expect(ids).toContain("t5"); // regular channel message
  });
});

describe("thread support: spawn node (thread_id)", () => {
  test("thread message stores thread_id equal to message channelId", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const { getMessage } = await import("../src/storage/messages.ts");
    await ingestMessage(
      buildMessage({ id: "t6", channelId: "thread-100b", content: "thread reply" }),
      "100",
      "Planning Session",
    );
    const row = getMessage("t6");
    // thread_id = message.channelId when in a thread (Discord guarantee: thread.id === starter msg id)
    expect(row!.thread_id).toBe("thread-100b");
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
      id: "thread-100b",          // starter message id == thread channel id
      channelId: "100",           // originally posted in main channel
      authorId: "u1",
      authorName: "alice",
      content: "started a thread here",
      createdAt: 500,
      threadId: "thread-100b",    // set to self to mark as spawn node
      threadName: "Planning Session",
    });
    const starter = getMessage("thread-100b")!;
    expect(starter.thread_id).toBe(starter.id);
  });

  test("thread_name is stored and retrievable", async () => {
    const { getMessage } = await import("../src/storage/messages.ts");
    const row = getMessage("t6")!;
    expect(row.thread_name).toBe("Planning Session");
  });
});
