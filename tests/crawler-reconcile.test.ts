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
      threads: {
        fetchActive: async () => ({ threads: new Map(), hasMore: false }),
        fetchArchived: async () => ({ threads: new Map(), hasMore: false }),
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

  test("tombstones a deleted thread reply in the thread lookback window and keeps unfetched live replies", async () => {
    const parentId = "4004";
    const threadId = "400000000000019999";
    const parentA = "400000000000010000";
    const parentB = "400000000000010900";
    const liveOld = "400000000000010100";
    const liveMid = "400000000000010400";
    const deleted = "400000000000010500";
    const liveNew = "400000000000010800";
    const parentContent = "parent message for thread reconcile";
    const liveOldContent = "thread live-old unique-unfetched-window snacks";
    const liveMidContent = "thread live-mid unique-fetched-window snacks";
    const deletedContent = "thread deleted unique-thread-delete-token snacks";
    const liveNewContent = "thread live-new unique-fetched-window snacks";

    for (const [id, channelId, parentChannelId, thread, content] of [
      [parentA, parentId, null, null, parentContent],
      [parentB, parentId, null, null, parentContent],
      [liveOld, threadId, parentId, threadId, liveOldContent],
      [liveMid, threadId, parentId, threadId, liveMidContent],
      [deleted, threadId, parentId, threadId, deletedContent],
      [liveNew, threadId, parentId, threadId, liveNewContent],
    ] as const) {
      upsertMessage({
        id,
        channelId,
        parentChannelId,
        authorId: "u1",
        authorName: "alice",
        content,
        createdAt: 1_000,
        threadId: thread,
        threadName: thread ? "Budget thread" : null,
      });
      indexFromRow(getMessage(id)!);
    }

    const thread = {
      id: threadId,
      name: "Budget thread",
      messages: {
        fetch: async ({ limit, before }: { limit: number; before?: string }) => {
          const live = [liveNew, liveMid];
          const older = live.filter((id) => (before ? BigInt(id) < BigInt(before) : true));
          const page = [...older].sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1)).slice(0, limit);
          return collectionOf(page.map((id) => mockMsg(id, threadId, id === liveNew ? liveNewContent : liveMidContent)));
        },
      },
    };
    const parentChannel = {
      id: parentId,
      type: ChannelType.GuildText,
      messages: {
        fetch: async () =>
          collectionOf([mockMsg(parentA, parentId, parentContent), mockMsg(parentB, parentId, parentContent)]),
      },
      threads: {
        fetchActive: async () => ({ threads: collectionOf([thread]), hasMore: false }),
        fetchArchived: async () => ({ threads: new Map(), hasMore: false }),
      },
    };
    const client = {
      channels: {
        fetch: async (id: string) => {
          if (id === parentId) return parentChannel;
          return { id, type: ChannelType.GuildVoice };
        },
      },
    } as unknown as Client;

    const { reconcileAll } = await import("../src/crawler/reconcile.ts");
    await reconcileAll(client);

    expect(getMessage(deleted)?.deleted_at).not.toBeNull();
    expect(getMessage(liveMid)?.deleted_at).toBeNull();
    expect(getMessage(liveNew)?.deleted_at).toBeNull();
    expect(getMessage(liveOld)?.deleted_at).toBeNull();
    expect(getMessage(parentA)?.deleted_at).toBeNull();
    expect(getMessage(parentB)?.deleted_at).toBeNull();

    const programsDev = scopeFor("programs-dev")!;
    const gone = contextStore.search({ query: "unique-thread-delete-token", scope: programsDev });
    expect(gone.map((h) => h.id)).not.toContain(deleted);
    const kept = contextStore.search({ query: "unique-unfetched-window", scope: programsDev });
    expect(kept.map((h) => h.id)).toContain(liveOld);
  });

  test("skips a thread diff when the first page is empty while the thread still exists", async () => {
    const parentId = "3003";
    const threadId = "300000000000019999";
    const parentMsg = "300000000000010000";
    const liveReply = "300000000000010200";
    const parentContent = "mentorship parent for empty-page thread reconcile";
    const replyContent = "thread empty-page unique-empty-skip-token snacks";

    upsertMessage({
      id: parentMsg,
      channelId: parentId,
      authorId: "u1",
      authorName: "alice",
      content: parentContent,
      createdAt: 1_000,
    });
    indexFromRow(getMessage(parentMsg)!);
    upsertMessage({
      id: liveReply,
      channelId: threadId,
      parentChannelId: parentId,
      authorId: "u1",
      authorName: "alice",
      content: replyContent,
      createdAt: 1_200,
      threadId,
      threadName: "Empty page thread",
    });
    indexFromRow(getMessage(liveReply)!);

    const thread = {
      id: threadId,
      name: "Empty page thread",
      messages: {
        fetch: async () => collectionOf([]),
      },
    };
    const parentChannel = {
      id: parentId,
      type: ChannelType.GuildText,
      messages: {
        fetch: async () => collectionOf([mockMsg(parentMsg, parentId, parentContent)]),
      },
      threads: {
        fetchActive: async () => ({ threads: collectionOf([thread]), hasMore: false }),
        fetchArchived: async () => ({ threads: new Map(), hasMore: false }),
      },
    };
    const client = {
      channels: {
        fetch: async (id: string) => {
          if (id === parentId) return parentChannel;
          return { id, type: ChannelType.GuildVoice };
        },
      },
    } as unknown as Client;

    const { reconcileAll } = await import("../src/crawler/reconcile.ts");
    await reconcileAll(client);

    expect(getMessage(liveReply)?.deleted_at).toBeNull();
    expect(getMessage(parentMsg)?.deleted_at).toBeNull();
  });
});
