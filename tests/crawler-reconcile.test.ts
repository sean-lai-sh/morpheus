import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChannelType, type Client } from "discord.js";
import { resetChannelsForTest } from "../src/config.ts";
import { scopeFor } from "../src/context/namespace.ts";
import { contextStore, indexFromRow } from "../src/context/store.ts";
import { getMessage, upsertMessage } from "../src/storage/messages.ts";
import { withTempCwd, withTempDb, writeCanonicalChannels } from "./helpers.ts";

const cwd = withTempCwd();
writeCanonicalChannels();
const db = withTempDb();

const PARENT = "1001";
const THREAD_ID = "100000000000019999";
const PARENT_A = "100000000000010000";
const THREAD_REPLY = "100000000000010050";
const PARENT_GONE = "100000000000010075";
const PARENT_B = "100000000000010100";

beforeAll(() => {
  resetChannelsForTest();
});

afterAll(() => {
  resetChannelsForTest();
  db.cleanup();
  cwd.cleanup();
});

function mockMsg(id: string, channelId: string, content: string) {
  return {
    id,
    channelId,
    content,
    createdTimestamp: 1_000,
    editedTimestamp: null,
    author: { id: "u1", username: "alice", globalName: "alice", bot: false },
    member: { displayName: "alice" },
  };
}

function collectionOf<T extends { id: string }>(items: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.id, item);
  return map;
}

describe("reconcileChannel", () => {
  test("does not tombstone in-scope thread replies that the parent fetch never returned", async () => {
    const parentContent = "parent message alpha for reconcile";
    const threadContent = "thread reply unique-reconcile-token snacks";
    for (const id of [PARENT_A, PARENT_GONE, PARENT_B]) {
      upsertMessage({
        id,
        channelId: PARENT,
        authorId: "u1",
        authorName: "alice",
        content: parentContent,
        createdAt: 1_000,
      });
      indexFromRow(getMessage(id)!);
    }
    upsertMessage({
      id: THREAD_REPLY,
      channelId: THREAD_ID,
      parentChannelId: PARENT,
      authorId: "u1",
      authorName: "alice",
      content: threadContent,
      createdAt: 1_050,
      threadId: THREAD_ID,
      threadName: "Budget thread",
    });
    indexFromRow(getMessage(THREAD_REPLY)!);

    const fetched = collectionOf([
      mockMsg(PARENT_A, PARENT, parentContent),
      mockMsg(PARENT_B, PARENT, parentContent),
    ]);
    const parentChannel = {
      id: PARENT,
      type: ChannelType.GuildText,
      messages: {
        fetch: async () => fetched,
      },
    };
    const client = {
      channels: {
        fetch: async (id: string) => {
          if (id === PARENT) return parentChannel;
          return { id, type: ChannelType.GuildVoice };
        },
      },
    } as unknown as Client;

    const { reconcileAll } = await import("../src/crawler/reconcile.ts");
    await reconcileAll(client);

    expect(getMessage(THREAD_REPLY)?.deleted_at).toBeNull();
    expect(getMessage(PARENT_A)?.deleted_at).toBeNull();
    expect(getMessage(PARENT_B)?.deleted_at).toBeNull();
    expect(getMessage(PARENT_GONE)?.deleted_at).not.toBeNull();

    const eboard = scopeFor("eboard")!;
    const hits = contextStore.search({ query: "unique-reconcile-token", scope: eboard });
    expect(hits.map((h) => h.id)).toContain(THREAD_REPLY);
  });
});
