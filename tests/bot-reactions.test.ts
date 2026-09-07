import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Collection } from "discord.js";
import { getChannel, resetChannelsForTest } from "../src/config.ts";
import { withTempCwd, withTempDb, writeCanonicalChannels } from "./helpers.ts";
import { fetchReactorIds, handleReactionChange } from "../src/bot/reactions.ts";
import { channelFilePath } from "../src/storage/markdown.ts";
import { getMessage, parseReactions, upsertMessage } from "../src/storage/messages.ts";

const cwd = withTempCwd();
writeCanonicalChannels();
const db = withTempDb();

const ALLOWED = "1001";
const DISALLOWED = "999";

beforeAll(() => {
  resetChannelsForTest();
});
afterAll(() => {
  resetChannelsForTest();
  db.cleanup();
  cwd.cleanup();
});

function userCollection(ids: string[]): Collection<string, { id: string }> {
  const col = new Collection<string, { id: string }>();
  for (const id of ids) col.set(id, { id });
  return col;
}

function buildReaction(opts: {
  messageId: string;
  channelId: string;
  partial?: boolean;
  messagePartial?: boolean;
  emojis: Array<{ name: string; count: number; users: string[] }>;
}): { reaction: any; user: { id: string } } {
  const cache = new Map<string, any>();
  for (const emoji of opts.emojis) {
    cache.set(emoji.name, {
      emoji: { name: emoji.name },
      count: emoji.count,
      users: {
        fetch: async () => userCollection(emoji.users),
      },
    });
  }

  const fullMessage = {
    id: opts.messageId,
    channelId: opts.channelId,
    partial: false,
    reactions: { cache },
  };

  const message = opts.messagePartial
    ? { id: opts.messageId, channelId: opts.channelId, partial: true, fetch: async () => fullMessage }
    : fullMessage;

  const fullReaction = {
    partial: false,
    message,
    emoji: { name: opts.emojis[0]?.name ?? "👍" },
  };

  const reaction = opts.partial
    ? { partial: true, message, fetch: async () => ({ ...fullReaction, message }) }
    : fullReaction;

  return { reaction, user: { id: "event-user" } };
}

describe("bot/reactions handleReactionChange", () => {
  test("persists current user ids per emoji on an allowlisted message", async () => {
    upsertMessage({
      id: "rx1",
      channelId: ALLOWED,
      authorId: "u1",
      authorName: "alice",
      content: "please react",
      createdAt: 1_000,
    });
    const { reaction, user } = buildReaction({
      messageId: "rx1",
      channelId: ALLOWED,
      emojis: [
        { name: "👍", count: 2, users: ["u2", "u3"] },
        { name: "✅", count: 1, users: ["u2"] },
      ],
    });
    await handleReactionChange(reaction, user as any);
    expect(parseReactions(getMessage("rx1")!.reactions)).toEqual({
      "👍": { count: 2, users: ["u2", "u3"] },
      "✅": { count: 1, users: ["u2"] },
    });
    const channel = getChannel(ALLOWED)!;
    expect(readFileSync(channelFilePath(channel), "utf8")).toContain("**Reactions**: 👍×2 ✅×1");
  });

  test("fetchReactorIds pages after 100 users", async () => {
    const page1 = userCollection(Array.from({ length: 100 }, (_, i) => `u${String(i).padStart(3, "0")}`));
    const page2 = userCollection(["u100", "u101"]);
    let calls = 0;
    const ids = await fetchReactorIds({
      users: {
        fetch: async (opts?: { after?: string }) => {
          calls += 1;
          if (calls === 1) {
            expect(opts?.after).toBeUndefined();
            return page1;
          }
          expect(opts?.after).toBe("u099");
          return page2;
        },
      },
    } as any);
    expect(ids).toHaveLength(102);
    expect(ids.slice(0, 3)).toEqual(["u000", "u001", "u002"]);
    expect(ids.slice(-2)).toEqual(["u100", "u101"]);
    expect(calls).toBe(2);
  });

  test("does not store reactions for a disallowed channel", async () => {
    upsertMessage({
      id: "rx-deny",
      channelId: DISALLOWED,
      authorId: "u1",
      authorName: "alice",
      content: "off channel",
      createdAt: 2_000,
    });
    const { reaction, user } = buildReaction({
      messageId: "rx-deny",
      channelId: DISALLOWED,
      emojis: [{ name: "👍", count: 1, users: ["u9"] }],
    });
    await handleReactionChange(reaction, user as any);
    expect(getMessage("rx-deny")!.reactions).toBeNull();
  });

  test("uses stored parent channel for thread allowlist", async () => {
    upsertMessage({
      id: "rx-thread",
      channelId: "thread-1001",
      parentChannelId: ALLOWED,
      authorId: "u1",
      authorName: "alice",
      content: "thread reply here",
      createdAt: 3_000,
      threadId: "thread-1001",
      threadName: "A thread",
    });
    const { reaction, user } = buildReaction({
      messageId: "rx-thread",
      channelId: "thread-1001",
      emojis: [{ name: "🔥", count: 1, users: ["u4"] }],
    });
    await handleReactionChange(reaction, user as any);
    expect(parseReactions(getMessage("rx-thread")!.reactions)).toEqual({
      "🔥": { count: 1, users: ["u4"] },
    });
  });

  test("skips unstored thread messages (thread id is not in channels.yml)", async () => {
    const { reaction, user } = buildReaction({
      messageId: "rx-unknown-thread",
      channelId: "thread-1001",
      emojis: [{ name: "👍", count: 1, users: ["u4"] }],
    });
    await handleReactionChange(reaction, user as any);
    expect(getMessage("rx-unknown-thread")).toBeNull();
  });

  test("fetches partial reaction and message before writing", async () => {
    upsertMessage({
      id: "rx-partial",
      channelId: ALLOWED,
      authorId: "u1",
      authorName: "alice",
      content: "partial event",
      createdAt: 4_000,
    });
    const { reaction, user } = buildReaction({
      messageId: "rx-partial",
      channelId: ALLOWED,
      partial: true,
      messagePartial: true,
      emojis: [{ name: "🎉", count: 1, users: ["u5"] }],
    });
    await handleReactionChange(reaction, user as any);
    expect(parseReactions(getMessage("rx-partial")!.reactions)).toEqual({
      "🎉": { count: 1, users: ["u5"] },
    });
  });

  test("clears stored reactions when the cache is empty", async () => {
    upsertMessage({
      id: "rx-clear",
      channelId: ALLOWED,
      authorId: "u1",
      authorName: "alice",
      content: "was reacted",
      createdAt: 5_000,
    });
    const first = buildReaction({
      messageId: "rx-clear",
      channelId: ALLOWED,
      emojis: [{ name: "👍", count: 1, users: ["u2"] }],
    });
    await handleReactionChange(first.reaction, first.user as any);
    expect(parseReactions(getMessage("rx-clear")!.reactions)["👍"]?.users).toEqual(["u2"]);

    const empty = buildReaction({
      messageId: "rx-clear",
      channelId: ALLOWED,
      emojis: [],
    });
    await handleReactionChange(empty.reaction, empty.user as any);
    expect(parseReactions(getMessage("rx-clear")!.reactions)).toEqual({});
  });
});
