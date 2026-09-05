import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChannelType, type Client } from "discord.js";
import { getChannel, resetChannelsForTest } from "../src/config.ts";
import { getDb } from "../src/storage/db.ts";
import { getState } from "../src/storage/crawl-state.ts";
import { getMessage } from "../src/storage/messages.ts";
import { withTempCwd, withTempDb, writeCanonicalChannels } from "./helpers.ts";

const cwd = withTempCwd();
writeCanonicalChannels();
const db = withTempDb();

const PARENT = "1001";
const THREAD_ID = "800000000000001000";
const THREAD_MSG = "800000000000001001";
const PARENT_IDS = Array.from({ length: 100 }, (_, i) => String(800000000000000000n + BigInt(i)));

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

function newestFirst(ids: string[]): string[] {
  return [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1));
}

function fetchByBefore(allIds: string[], channelId: string, contentFor: (id: string) => string) {
  return async ({ limit, before }: { limit: number; before?: string }) => {
    const older = allIds.filter((id) => (before ? BigInt(id) < BigInt(before) : true));
    const page = newestFirst(older).slice(0, limit);
    return collectionOf(page.map((id) => mockMsg(id, channelId, contentFor(id))));
  };
}

describe("backfillChannel include_threads", () => {
  test("runs thread backfill when parent history ends on a full 100-message page", async () => {
    const thread = {
      id: THREAD_ID,
      name: "Budget thread",
      messages: {
        fetch: fetchByBefore(
          [THREAD_MSG],
          THREAD_ID,
          () => "thread backfill unique-token snacks",
        ),
      },
    };
    const parentChannel = {
      id: PARENT,
      type: ChannelType.GuildText,
      messages: {
        fetch: fetchByBefore(PARENT_IDS, PARENT, (id) => `parent history page body ${id}`),
      },
      threads: {
        fetchActive: async () => ({ threads: collectionOf([thread]) }),
        fetchArchived: async () => ({ threads: new Map(), hasMore: false }),
      },
    };
    const client = {
      channels: {
        fetch: async (id: string) => {
          if (id === PARENT) return parentChannel;
          return null;
        },
      },
    } as unknown as Client;

    const { backfillChannel } = await import("../src/crawler/backfill.ts");
    const channel = getChannel(PARENT)!;
    expect(channel.include_threads).toBe(true);
    const result = await backfillChannel(client, channel);

    expect(result.complete).toBe(true);
    expect(result.ingested).toBe(100);
    expect(getState(PARENT)?.last_backfill_complete).toBe(1);
    expect(getMessage(THREAD_MSG)).not.toBeNull();
    expect(getMessage(THREAD_MSG)?.parent_channel_id).toBe(PARENT);
    expect(getMessage(THREAD_MSG)?.thread_id).toBe(THREAD_ID);
    expect(getState(THREAD_ID)?.last_backfill_complete).toBe(1);
  }, 20_000);

  test("does not mark parent complete when include_threads fetchActive throws", async () => {
    // Distinct allowlisted include_threads channel so the 100-page suite above
    // does not leave this parent already last_backfill_complete.
    const parentId = "2002";
    const parentMsg = "800000000000002000";
    const parentChannel = {
      id: parentId,
      type: ChannelType.GuildText,
      messages: {
        fetch: fetchByBefore([parentMsg], parentId, () => "parent body for thread-fetch throw"),
      },
      threads: {
        fetchActive: async () => {
          throw new Error("missing GuildMembers (simulated)");
        },
        fetchArchived: async () => ({ threads: new Map(), hasMore: false }),
      },
    };
    const client = {
      channels: {
        fetch: async (id: string) => {
          if (id === parentId) return parentChannel;
          return null;
        },
      },
    } as unknown as Client;

    const { backfillChannel } = await import("../src/crawler/backfill.ts");
    const channel = getChannel(parentId)!;
    expect(channel.include_threads).toBe(true);
    const result = await backfillChannel(client, channel);

    expect(result.complete).toBe(false);
    expect(getState(parentId)?.last_backfill_complete).not.toBe(1);
    expect(getMessage(parentMsg)).not.toBeNull();
  }, 20_000);

  test("backfillThread does not rewind parent oldest_seen_id from thread snowflakes", async () => {
    const parentId = "3003";
    const oldestSeen = "300000000000090000";
    const mid = "300000000000050000";
    const threadId = "300000000000020000";
    const threadMsg = "300000000000010000";
    const parentContent = "mentorship parent for thread-backfill cursor isolate";
    const midContent = "parent mid unique-thread-backfill-mid snacks";
    const threadContent = "thread reply unique-thread-backfill-token snacks";

    const { setOldestSeen } = await import("../src/storage/crawl-state.ts");
    setOldestSeen(parentId, oldestSeen);
    expect(getState(parentId)?.last_backfill_complete).toBe(0);

    const thread = {
      id: threadId,
      name: "Archived planning thread",
      messages: {
        fetch: fetchByBefore([threadMsg], threadId, () => threadContent),
      },
    };
    const parentChannel = {
      id: parentId,
      type: ChannelType.GuildText,
      messages: {
        fetch: fetchByBefore([oldestSeen, mid], parentId, (id) => (id === mid ? midContent : parentContent)),
      },
      threads: {
        fetchActive: async () => ({ threads: new Map() }),
        fetchArchived: async () => ({ threads: collectionOf([thread]), hasMore: false }),
      },
    };
    const client = {
      channels: {
        fetch: async (id: string) => {
          if (id === parentId) return parentChannel;
          return null;
        },
      },
    } as unknown as Client;

    const { backfillChannel } = await import("../src/crawler/backfill.ts");
    const channel = getChannel(parentId)!;
    expect(channel.include_threads).toBe(true);
    const result = await backfillChannel(client, channel);

    expect(getMessage(mid)).not.toBeNull();
    expect(getMessage(threadMsg)).not.toBeNull();
    expect(getState(parentId)?.oldest_seen_id).not.toBe(threadMsg);
    expect(BigInt(getState(parentId)!.oldest_seen_id!)).toBeGreaterThan(BigInt(threadMsg));
    expect(result.complete).toBe(true);
  }, 20_000);

  test("ingests a private archived thread that public fetchArchived omits", async () => {
    const parentId = "4004";
    const parentMsg = "400000000000002000";
    const threadId = "400000000000002100";
    const threadMsg = "400000000000002101";
    const threadContent = "private-thread-unique-token snacks";
    const thread = {
      id: threadId,
      name: "Private planning thread",
      messages: {
        fetch: fetchByBefore([threadMsg], threadId, () => threadContent),
      },
    };
    const parentChannel = {
      id: parentId,
      type: ChannelType.GuildText,
      messages: {
        fetch: fetchByBefore([parentMsg], parentId, () => "dev parent for private archived thread"),
      },
      threads: {
        fetchActive: async () => ({ threads: new Map() }),
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
          return null;
        },
      },
    } as unknown as Client;

    const { backfillChannel } = await import("../src/crawler/backfill.ts");
    const channel = getChannel(parentId)!;
    expect(channel.include_threads).toBe(true);
    const result = await backfillChannel(client, channel);

    expect(getMessage(threadMsg)).not.toBeNull();
    expect(getMessage(threadMsg)?.content).toBe(threadContent);
    expect(getMessage(threadMsg)?.parent_channel_id).toBe(parentId);
    expect(getMessage(threadMsg)?.thread_id).toBe(threadId);
    expect(result.complete).toBe(true);
    expect(getState(parentId)?.last_backfill_complete).toBe(1);
  }, 20_000);

  test("does not mark parent complete when private archived listing throws", async () => {
    // Resume 2002 (left incomplete by the fetchActive-throw case). Parent id
    // must be older than that run's oldest_seen or fetch({before}) skips it.
    const parentId = "2002";
    const parentMsg = "800000000000001000";
    const parentChannel = {
      id: parentId,
      type: ChannelType.GuildText,
      messages: {
        fetch: fetchByBefore([parentMsg], parentId, () => "parent body for private-archived throw"),
      },
      threads: {
        fetchActive: async () => ({ threads: new Map() }),
        fetchArchived: async (opts?: { type?: string }) => {
          if (opts?.type === "private") {
            throw new Error("missing Manage Threads (simulated)");
          }
          return { threads: new Map(), hasMore: false };
        },
      },
    };
    const client = {
      channels: {
        fetch: async (id: string) => {
          if (id === parentId) return parentChannel;
          return null;
        },
      },
    } as unknown as Client;

    const { backfillChannel } = await import("../src/crawler/backfill.ts");
    const channel = getChannel(parentId)!;
    expect(channel.include_threads).toBe(true);
    const result = await backfillChannel(client, channel);

    expect(result.complete).toBe(false);
    expect(getState(parentId)?.last_backfill_complete).not.toBe(1);
    expect(getMessage(parentMsg)).not.toBeNull();
  }, 20_000);

  test("paginates archived threads with archiveTimestamp, not thread id", async () => {
    // discord.js drops `before` when it is a snowflake not in cache, so a
    // hasMore page that keys off thread id refetches the first page forever.
    const parentId = "4004";
    getDb().query(`DELETE FROM crawl_state WHERE channel_id = ?`).run(parentId);

    const parentMsg = "400000000000003000";
    const page1 = [
      {
        id: "400000000000003100",
        name: "Archived recent",
        archiveTimestamp: 3_000,
        msg: "400000000000003101",
        content: "archived-page1-recent unique-archive-page snacks",
      },
      {
        id: "400000000000003200",
        name: "Archived mid",
        archiveTimestamp: 2_000,
        msg: "400000000000003201",
        content: "archived-page1-mid unique-archive-page snacks",
      },
    ];
    const page2 = {
      id: "400000000000003300",
      name: "Archived oldest",
      archiveTimestamp: 1_000,
      msg: "400000000000003301",
      content: "archived-page2-oldest unique-archive-page snacks",
    };

    const threadOf = (t: { id: string; name: string; archiveTimestamp: number; msg: string; content: string }) => ({
      id: t.id,
      name: t.name,
      archiveTimestamp: t.archiveTimestamp,
      messages: { fetch: fetchByBefore([t.msg], t.id, () => t.content) },
    });

    let publicCalls = 0;
    const parentChannel = {
      id: parentId,
      type: ChannelType.GuildText,
      messages: {
        fetch: fetchByBefore([parentMsg], parentId, () => "dev parent for archived pagination"),
      },
      threads: {
        fetchActive: async () => ({ threads: new Map() }),
        fetchArchived: async (opts?: { type?: string; before?: unknown }) => {
          if (opts?.type === "private") return { threads: new Map(), hasMore: false };
          publicCalls++;
          if (publicCalls > 5) throw new Error("archived pagination did not terminate");
          if (opts?.before == null) {
            return { threads: collectionOf(page1.map(threadOf)), hasMore: true };
          }
          expect(opts.before).toBe(2_000);
          expect(typeof opts.before).not.toBe("string");
          return { threads: collectionOf([threadOf(page2)]), hasMore: false };
        },
      },
    };
    const client = {
      channels: {
        fetch: async (id: string) => {
          if (id === parentId) return parentChannel;
          return null;
        },
      },
    } as unknown as Client;

    const { backfillChannel } = await import("../src/crawler/backfill.ts");
    const channel = getChannel(parentId)!;
    expect(channel.include_threads).toBe(true);
    const result = await backfillChannel(client, channel);

    expect(publicCalls).toBe(2);
    expect(getMessage(page1[0]!.msg)).not.toBeNull();
    expect(getMessage(page1[1]!.msg)).not.toBeNull();
    expect(getMessage(page2.msg)).not.toBeNull();
    expect(getMessage(page2.msg)?.content).toBe(page2.content);
    expect(result.complete).toBe(true);
  }, 20_000);

  test("stops archived pagination when hasMore but no archive cursor", async () => {
    const parentId = "1001";
    getDb().query(`DELETE FROM crawl_state WHERE channel_id = ?`).run(parentId);

    const parentMsg = "800000000000009000";
    const threadId = "800000000000009100";
    const threadMsg = "800000000000009101";
    const thread = {
      id: threadId,
      name: "No timestamp archive",
      messages: {
        fetch: fetchByBefore([threadMsg], threadId, () => "no-timestamp-archive unique snacks"),
      },
    };
    let publicCalls = 0;
    const parentChannel = {
      id: parentId,
      type: ChannelType.GuildText,
      messages: {
        fetch: fetchByBefore([parentMsg], parentId, () => "sponsors parent for no-cursor archive"),
      },
      threads: {
        fetchActive: async () => ({ threads: new Map() }),
        fetchArchived: async (opts?: { type?: string }) => {
          if (opts?.type === "private") return { threads: new Map(), hasMore: false };
          publicCalls++;
          if (publicCalls > 5) throw new Error("archived pagination did not terminate");
          return { threads: collectionOf([thread]), hasMore: true };
        },
      },
    };
    const client = {
      channels: {
        fetch: async (id: string) => {
          if (id === parentId) return parentChannel;
          return null;
        },
      },
    } as unknown as Client;

    const { backfillChannel } = await import("../src/crawler/backfill.ts");
    const channel = getChannel(parentId)!;
    const result = await backfillChannel(client, channel);

    expect(publicCalls).toBe(1);
    expect(getMessage(threadMsg)).not.toBeNull();
    expect(result.complete).toBe(true);
  }, 20_000);
});

describe("parseBackfillChannelFlag / channelFilterForBackfill", () => {
  test("reads --channel=<id> and ignores unrelated args", async () => {
    const { parseBackfillChannelFlag } = await import("../src/crawler/backfill.ts");
    expect(parseBackfillChannelFlag(["--channel=1001"])).toBe("1001");
    expect(parseBackfillChannelFlag(["--hot", "--channel=2002"])).toBe("2002");
    expect(parseBackfillChannelFlag([])).toBeUndefined();
    expect(parseBackfillChannelFlag(["--channel="])).toBeUndefined();
    expect(parseBackfillChannelFlag(["--channel", "1001"])).toBeUndefined();
  });

  test("filter keeps only the named allowlisted channel", async () => {
    const { channelFilterForBackfill } = await import("../src/crawler/backfill.ts");
    const channels = [
      { id: "1001", name: "sponsors" },
      { id: "2002", name: "leadership-team" },
    ] as any;
    const filter = channelFilterForBackfill("1001", channels)!;
    expect(channels.filter(filter).map((c: { id: string }) => c.id)).toEqual(["1001"]);
  });

  test("unknown --channel throws rather than crawling nothing", async () => {
    const { channelFilterForBackfill } = await import("../src/crawler/backfill.ts");
    expect(() => channelFilterForBackfill("9999", [{ id: "1001" }] as any)).toThrow(/unknown --channel 9999/);
    expect(channelFilterForBackfill(undefined, [{ id: "1001" }] as any)).toBeUndefined();
  });
});
