import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Collection, ReactionType } from "discord.js";
import { getChannel, resetChannelsForTest } from "../src/config.ts";
import { withTempCwd, withTempDb, writeCanonicalChannels } from "./helpers.ts";
import { fetchReactorIds, handleReactionChange, reactionEmojiKey } from "../src/bot/reactions.ts";
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
  emojis: Array<{
    name: string;
    id?: string;
    count: number;
    users: string[];
    burstUsers?: string[];
    fetchGate?: Promise<void>;
    onFetchStart?: () => void;
  }>;
}): { reaction: any; user: { id: string } } {
  const cache = new Map<string, any>();
  for (const emoji of opts.emojis) {
    const cacheKey = emoji.id ?? emoji.name;
    cache.set(cacheKey, {
      emoji: { name: emoji.name, id: emoji.id ?? null },
      count: emoji.count,
      users: {
        fetch: async (fetchOpts?: { after?: string; type?: number }) => {
          emoji.onFetchStart?.();
          if (emoji.fetchGate) await emoji.fetchGate;
          if (fetchOpts?.type === ReactionType.Burst) return userCollection(emoji.burstUsers ?? []);
          return userCollection(emoji.users);
        },
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
    let normalCalls = 0;
    const ids = await fetchReactorIds({
      users: {
        fetch: async (opts?: { after?: string; type?: number }) => {
          if (opts?.type === ReactionType.Burst) return userCollection([]);
          normalCalls += 1;
          if (normalCalls === 1) {
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
    expect(normalCalls).toBe(2);
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

  test("reactionEmojiKey prefers custom snowflake over a colliding name", () => {
    expect(reactionEmojiKey({ name: "👍", id: null })).toBe("👍");
    expect(reactionEmojiKey({ name: "ship", id: "111" })).toBe("111");
    expect(reactionEmojiKey({ name: "ship", id: "222" })).toBe("222");
    expect(reactionEmojiKey({ name: null, id: null })).toBeNull();
  });

  test("two custom emojis with the same name stay distinct", async () => {
    upsertMessage({
      id: "rx-custom",
      channelId: ALLOWED,
      authorId: "u1",
      authorName: "alice",
      content: "custom emoji collide by name",
      createdAt: 6_000,
    });
    const { reaction, user } = buildReaction({
      messageId: "rx-custom",
      channelId: ALLOWED,
      emojis: [
        { name: "ship", id: "111111111111111111", count: 1, users: ["u2"] },
        { name: "ship", id: "222222222222222222", count: 2, users: ["u3", "u4"] },
      ],
    });
    await handleReactionChange(reaction, user as any);
    expect(parseReactions(getMessage("rx-custom")!.reactions)).toEqual({
      "111111111111111111": { count: 1, users: ["u2"], id: "111111111111111111", name: "ship" },
      "222222222222222222": { count: 2, users: ["u3", "u4"], id: "222222222222222222", name: "ship" },
    });
    const channel = getChannel(ALLOWED)!;
    const md = readFileSync(channelFilePath(channel), "utf8");
    expect(md).toContain("ship×1");
    expect(md).toContain("ship×2");
    expect(md).not.toContain("111111111111111111");
  });

  test("burst reactors are unioned with normal ones", async () => {
    upsertMessage({
      id: "rx-burst",
      channelId: ALLOWED,
      authorId: "u1",
      authorName: "alice",
      content: "super react",
      createdAt: 7_000,
    });
    const { reaction, user } = buildReaction({
      messageId: "rx-burst",
      channelId: ALLOWED,
      emojis: [{ name: "🔥", count: 3, users: ["u2"], burstUsers: ["u3", "u2"] }],
    });
    await handleReactionChange(reaction, user as any);
    expect(parseReactions(getMessage("rx-burst")!.reactions)).toEqual({
      "🔥": { count: 3, users: ["u2", "u3"] },
    });
  });

  test("overlapping events serialize so the later snapshot wins", async () => {
    upsertMessage({
      id: "rx-race",
      channelId: ALLOWED,
      authorId: "u1",
      authorName: "alice",
      content: "race",
      createdAt: 8_000,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const stale = buildReaction({
      messageId: "rx-race",
      channelId: ALLOWED,
      emojis: [{ name: "👍", count: 1, users: ["stale"], fetchGate: gate, onFetchStart: markStarted }],
    });
    const fresh = buildReaction({
      messageId: "rx-race",
      channelId: ALLOWED,
      emojis: [{ name: "👍", count: 2, users: ["fresh-a", "fresh-b"] }],
    });

    const first = handleReactionChange(stale.reaction, stale.user as any);
    await started;
    const second = handleReactionChange(fresh.reaction, fresh.user as any);
    release();
    await Promise.all([first, second]);

    expect(parseReactions(getMessage("rx-race")!.reactions)).toEqual({
      "👍": { count: 2, users: ["fresh-a", "fresh-b"] },
    });
  });
});
