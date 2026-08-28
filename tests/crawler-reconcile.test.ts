import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChannelType, type Client } from "discord.js";
import { getChannel, resetChannelsForTest } from "../src/config.ts";
import { scopeFor } from "../src/context/namespace.ts";
import { contextStore, indexFromRow } from "../src/context/store.ts";
import { getState, setOldestSeen } from "../src/storage/crawl-state.ts";
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

  test("thread reconcile ingest does not rewind parent oldest_seen_id", async () => {
    // In-progress parent backfill cursor sits above unfetched MID. An archived
    // thread last-N snowflake is older than MID; ingesting it must not jump the
    // parent cursor or backfill(before=threadId) skips MID and marks complete.
    const parentId = "2002";
    const oldestSeen = "200000000000000900";
    const mid = "200000000000000500";
    const old = "200000000000000100";
    const threadId = "200000000000000200";
    const parentRecent = "200000000000000950";
    const parentContent = "leadership parent lookback for cursor isolate";
    const threadContent = "archived thread last-n unique-cursor-rewind snacks";
    const midContent = "parent mid unique-unfetched-mid-token snacks";
    const oldContent = "parent old unique-unfetched-old-token snacks";

    setOldestSeen(parentId, oldestSeen);
    expect(getState(parentId)?.last_backfill_complete).toBe(0);

    upsertMessage({
      id: threadId,
      channelId: threadId,
      parentChannelId: parentId,
      authorId: "u1",
      authorName: "alice",
      content: threadContent,
      createdAt: 1_200,
      threadId,
      threadName: "Archived budget thread",
    });
    indexFromRow(getMessage(threadId)!);

    const contentFor = (id: string) => {
      if (id === mid) return midContent;
      if (id === old) return oldContent;
      return parentContent;
    };
    const thread = {
      id: threadId,
      name: "Archived budget thread",
      messages: {
        fetch: async () => collectionOf([mockMsg(threadId, threadId, threadContent)]),
      },
    };
    const parentChannel = {
      id: parentId,
      type: ChannelType.GuildText,
      messages: {
        fetch: async ({ limit, before }: { limit: number; before?: string }) => {
          if (!before) {
            return collectionOf([mockMsg(parentRecent, parentId, parentContent)]);
          }
          const older = [parentRecent, oldestSeen, mid, old].filter((id) => BigInt(id) < BigInt(before));
          const page = [...older].sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1)).slice(0, limit);
          return collectionOf(page.map((id) => mockMsg(id, parentId, contentFor(id))));
        },
      },
      threads: {
        fetchActive: async () => ({ threads: new Map(), hasMore: false }),
        fetchArchived: async () => ({ threads: collectionOf([thread]), hasMore: false }),
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

    expect(getState(parentId)?.oldest_seen_id).toBe(oldestSeen);
    expect(getMessage(mid)).toBeNull();

    const { backfillChannel } = await import("../src/crawler/backfill.ts");
    const channel = getChannel(parentId)!;
    expect(channel.include_threads).toBe(true);
    await backfillChannel(client, channel);

    expect(getMessage(mid)).not.toBeNull();
    expect(getMessage(mid)?.content).toBe(midContent);
    expect(getMessage(old)).not.toBeNull();
  }, 20_000);

  test("live ingestMessage of a thread reply does not rewind parent oldest_seen_id", async () => {
    // Same skip class as the reconcile fixture, without updateCrawlCursors:false.
    // Live MessageCreate/Update calls ingestMessage(thread, parent, name) with defaults.
    const parentId = "3003";
    const oldestSeen = "300000000000000900";
    const mid = "300000000000000500";
    const old = "300000000000000100";
    const threadId = "300000000000000250";
    const threadMsg = "300000000000000200";
    const parentRecent = "300000000000000950";
    const parentContent = "mentorship parent for live cursor isolate";
    const threadContent = "live thread edit unique-live-cursor-rewind snacks";
    const midContent = "parent mid unique-live-unfetched-mid snacks";
    const oldContent = "parent old unique-live-unfetched-old snacks";

    setOldestSeen(parentId, oldestSeen);
    expect(getState(parentId)?.last_backfill_complete).toBe(0);

    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(
      mockMsg(threadMsg, threadId, threadContent) as any,
      parentId,
      "Live archive thread",
    );
    expect(r.action).toBe("inserted");
    expect(getState(parentId)?.oldest_seen_id).toBe(oldestSeen);

    const contentFor = (id: string) => {
      if (id === mid) return midContent;
      if (id === old) return oldContent;
      return parentContent;
    };
    const parentChannel = {
      id: parentId,
      type: ChannelType.GuildText,
      messages: {
        fetch: async ({ limit, before }: { limit: number; before?: string }) => {
          if (!before) {
            return collectionOf([mockMsg(parentRecent, parentId, parentContent)]);
          }
          const older = [parentRecent, oldestSeen, mid, old].filter((id) => BigInt(id) < BigInt(before));
          const page = [...older].sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1)).slice(0, limit);
          return collectionOf(page.map((id) => mockMsg(id, parentId, contentFor(id))));
        },
      },
      threads: {
        fetchActive: async () => ({ threads: new Map(), hasMore: false }),
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

    const { backfillChannel } = await import("../src/crawler/backfill.ts");
    const channel = getChannel(parentId)!;
    expect(channel.include_threads).toBe(true);
    await backfillChannel(client, channel);

    expect(getMessage(mid)).not.toBeNull();
    expect(getMessage(mid)?.content).toBe(midContent);
    expect(getMessage(old)).not.toBeNull();
  }, 20_000);

  test("reconcile last-N lists private archived threads", async () => {
    const parentId = "1001";
    const parentMsg = "100000000000020000";
    const threadId = "100000000000029999";
    const replyId = "100000000000029050";
    const parentContent = "sponsors parent for private archived reconcile";
    const replyContent = "private-archived-reconcile-unique snacks";

    const thread = {
      id: threadId,
      name: "Private archived planning",
      messages: {
        fetch: async () => collectionOf([mockMsg(replyId, threadId, replyContent)]),
      },
    };
    const parentChannel = {
      id: parentId,
      type: ChannelType.GuildText,
      messages: {
        fetch: async () => collectionOf([mockMsg(parentMsg, parentId, parentContent)]),
      },
      threads: {
        fetchActive: async () => ({ threads: new Map(), hasMore: false }),
        fetchArchived: async (opts?: { type?: string }) => {
          if (opts?.type === "private") {
            return { threads: collectionOf([thread]), hasMore: false };
          }
          return { threads: new Map(), hasMore: false };
        },
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

    expect(getMessage(replyId)).not.toBeNull();
    expect(getMessage(replyId)?.parent_channel_id).toBe(parentId);
    expect(getMessage(replyId)?.thread_id).toBe(threadId);
  });

  test("reconcile last-N paginates archived threads with archiveTimestamp", async () => {
    const parentId = "4004";
    const parentMsg = "400000000000040000";
    const parentContent = "dev parent for archived reconcile pagination";
    const page1 = {
      id: "400000000000041000",
      name: "Reconcile archived p1",
      archiveTimestamp: 8_000,
      replyId: "400000000000041050",
      content: "reconcile-archive-p1 unique-recon-page snacks",
    };
    const page2 = {
      id: "400000000000042000",
      name: "Reconcile archived p2",
      archiveTimestamp: 7_000,
      replyId: "400000000000042050",
      content: "reconcile-archive-p2 unique-recon-page snacks",
    };
    const threadOf = (t: typeof page1) => ({
      id: t.id,
      name: t.name,
      archiveTimestamp: t.archiveTimestamp,
      messages: {
        fetch: async () => collectionOf([mockMsg(t.replyId, t.id, t.content)]),
      },
    });

    let publicCalls = 0;
    const parentChannel = {
      id: parentId,
      type: ChannelType.GuildText,
      messages: {
        fetch: async () => collectionOf([mockMsg(parentMsg, parentId, parentContent)]),
      },
      threads: {
        fetchActive: async () => ({ threads: new Map(), hasMore: false }),
        fetchArchived: async (opts?: { type?: string; before?: unknown }) => {
          if (opts?.type === "private") return { threads: new Map(), hasMore: false };
          publicCalls++;
          if (publicCalls > 5) throw new Error("archived pagination did not terminate");
          if (opts?.before == null) {
            return { threads: collectionOf([threadOf(page1)]), hasMore: true };
          }
          expect(opts.before).toBe(8_000);
          return { threads: collectionOf([threadOf(page2)]), hasMore: false };
        },
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

    expect(publicCalls).toBe(2);
    expect(getMessage(page1.replyId)?.thread_id).toBe(page1.id);
    expect(getMessage(page2.replyId)?.thread_id).toBe(page2.id);
    expect(getMessage(page2.replyId)?.content).toBe(page2.content);
  });
});
