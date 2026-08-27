import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChannelType, type Client } from "discord.js";
import { getChannel, resetChannelsForTest } from "../src/config.ts";
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
});
