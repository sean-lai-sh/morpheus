import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import { authorPassesRoleGate, tryEnqueueJob, type JobCandidate } from "../src/bot/enqueue.ts";
import { parseEnv } from "../src/config.ts";
import { upsertMessage } from "../src/storage/messages.ts";
import { getJobByDiscordMessageId, type ChannelResolver } from "../src/storage/jobs.ts";

const ROLE = "role-eboard";
const BOT = "bot-1";
const GENERAL = "111111111111111111";
const LEADERSHIP = "222222222222222222";
const MARKETING = "333333333333333333";
const LEADERSHIP_B = "444444444444444444";

const CHANNELS = new Map<string, { isolated?: boolean; include_threads?: boolean }>([
  [GENERAL, { isolated: false }],
  [LEADERSHIP, { isolated: true }],
  [MARKETING, { isolated: false, include_threads: true }],
  [LEADERSHIP_B, { isolated: true }],
]);
const resolveChannel: ChannelResolver = (id) => CHANNELS.get(id);

const db = withTempDb();
beforeAll(() => {});
afterAll(() => {
  db.cleanup();
});

function candidate(over: Partial<JobCandidate> & { discordMessageId: string }): JobCandidate {
  return {
    discordChannelId: GENERAL,
    discordThreadId: null,
    parentChannelId: null,
    authorId: "u1",
    authorIsBot: false,
    authorRoleIds: [ROLE],
    content: `<@${BOT}> hello there`,
    mentionedBot: true,
    replyToBot: false,
    source: "mention",
    ...over,
  };
}

const policy = {
  triggerRoleIds: new Set([ROLE]),
  dispatch: false as const,
  maxOutstanding: 50,
  maxPerHour: 50,
  resolveChannel,
};

describe("tryEnqueueJob positives", () => {
  test("mention in allowlisted general channel → queued namespace=general", async () => {
    const r = await tryEnqueueJob(candidate({ discordMessageId: "e-gen" }), policy);
    expect(r.skipped).toBeUndefined();
    expect(r.job?.namespace).toBe("general");
    expect(r.job?.status).toBe("queued");
  });

  test("mention in isolated thread → namespace=leadership (not fail-open general)", async () => {
    const r = await tryEnqueueJob(
      candidate({
        discordMessageId: "e-lead-thread",
        discordChannelId: "thread-999",
        discordThreadId: "thread-999",
        parentChannelId: LEADERSHIP,
        content: `<@${BOT}> budget?`,
      }),
      policy,
    );
    expect(r.job?.namespace).toBe("leadership");
    expect(r.job?.discord_thread_id).toBe("thread-999");
  });

  test("bare @bot enqueues even if ingest would drop as too-short", async () => {
    const r = await tryEnqueueJob(
      candidate({ discordMessageId: "e-bare", content: `<@${BOT}>`, mentionedBot: true }),
      policy,
    );
    expect(r.job?.status).toBe("queued");
    expect(r.job?.content).toBe(`<@${BOT}>`);
  });

  test("/ask uses the same jobs table", async () => {
    const r = await tryEnqueueJob(
      candidate({
        discordMessageId: "e-slash",
        content: "what's the sponsor status?",
        mentionedBot: false,
        replyToBot: false,
        source: "slash",
      }),
      policy,
    );
    expect(r.job?.status).toBe("queued");
    expect(getJobByDiscordMessageId("e-slash")?.content).toContain("sponsor");
  });
});

describe("tryEnqueueJob negatives", () => {
  test("unknown / non-allowlisted channel → no job", async () => {
    const r = await tryEnqueueJob(
      candidate({ discordMessageId: "e-unknown", discordChannelId: "999", parentChannelId: null }),
      policy,
    );
    expect(r.job).toBeNull();
    expect(r.skipped).toBe("channel-not-allowlisted");
  });

  test("author without trigger role → no job", async () => {
    const r = await tryEnqueueJob(
      candidate({ discordMessageId: "e-norole", authorRoleIds: ["other-role"] }),
      policy,
    );
    expect(r.skipped).toBe("role-gate");
  });

  test("empty trigger role set fail-closes (including production)", async () => {
    expect(authorPassesRoleGate([ROLE], new Set())).toBe(false);
    const r = await tryEnqueueJob(candidate({ discordMessageId: "e-empty-roles" }), {
      ...policy,
      triggerRoleIds: new Set(),
      nodeEnv: "production",
    });
    expect(r.skipped).toBe("role-gate");
  });

  test("bot-authored → no job", async () => {
    const r = await tryEnqueueJob(
      candidate({ discordMessageId: "e-bot", authorIsBot: true }),
      policy,
    );
    expect(r.skipped).toBe("bot-author");
  });

  test("not a mention or reply → no job", async () => {
    const r = await tryEnqueueJob(
      candidate({
        discordMessageId: "e-plain",
        mentionedBot: false,
        replyToBot: false,
        content: "just chatting",
      }),
      policy,
    );
    expect(r.skipped).toBe("not-trigger");
  });

  test("over outstanding cap → no job", async () => {
    const author = "cap-u";
    await tryEnqueueJob(
      candidate({ discordMessageId: "e-cap-1", authorId: author }),
      { ...policy, maxOutstanding: 2, maxPerHour: 50 },
    );
    await tryEnqueueJob(
      candidate({ discordMessageId: "e-cap-2", authorId: author }),
      { ...policy, maxOutstanding: 2, maxPerHour: 50 },
    );
    const r = await tryEnqueueJob(
      candidate({ discordMessageId: "e-cap-3", authorId: author }),
      { ...policy, maxOutstanding: 2, maxPerHour: 50 },
    );
    expect(r.skipped).toBe("outstanding-cap");
  });

  test("over hourly cap → no job", async () => {
    const author = "rate-u";
    const now = 10_000_000;
    for (let i = 0; i < 5; i++) {
      await tryEnqueueJob(
        candidate({ discordMessageId: `e-rate-${i}`, authorId: author }),
        { ...policy, now, maxPerHour: 5, maxOutstanding: 50 },
      );
    }
    const r = await tryEnqueueJob(
      candidate({ discordMessageId: "e-rate-6", authorId: author }),
      { ...policy, now: now + 1000, maxPerHour: 5, maxOutstanding: 50 },
    );
    expect(r.skipped).toBe("rate-cap");
  });

  test("duplicate discord_message_id is skipped", async () => {
    const author = "dup-u";
    await tryEnqueueJob(candidate({ discordMessageId: "e-dup", authorId: author }), policy);
    const r = await tryEnqueueJob(candidate({ discordMessageId: "e-dup", authorId: author }), policy);
    expect(r.skipped).toBe("duplicate");
  });
});

describe("tryEnqueueJob grok dispatch", () => {
  test("missing GROK_BOT_WEBHOOK_URL skips with warn and does not throw", async () => {
    const r = await tryEnqueueJob(candidate({ discordMessageId: "e-nodispatch", authorId: "disp-skip" }), {
      ...policy,
      dispatch: true,
      env: parseEnv({ ...process.env, GROK_BOT_WEBHOOK_URL: "" }),
    });
    expect(r.job?.status).toBe("queued");
    expect(r.dispatched).toBe(false);
  });

  test("missing GROK_BOT_WEBHOOK_SECRET skips with warn and does not throw", async () => {
    const r = await tryEnqueueJob(candidate({ discordMessageId: "e-nosecret", authorId: "disp-nosecret" }), {
      ...policy,
      dispatch: true,
      env: parseEnv({
        ...process.env,
        GROK_BOT_WEBHOOK_URL: "https://example.com/grok-routine",
        GROK_BOT_WEBHOOK_SECRET: "",
      }),
    });
    expect(r.job?.status).toBe("queued");
    expect(r.dispatched).toBe(false);
  });

  test("leadership jobs dispatch by default (full leadership, not skipped)", async () => {
    let posted = 0;
    const r = await tryEnqueueJob(
      candidate({
        discordMessageId: "e-lead-dispatch",
        discordChannelId: "thread-lead-disp",
        discordThreadId: "thread-lead-disp",
        parentChannelId: LEADERSHIP,
        content: `<@${BOT}> budget?`,
      }),
      {
        ...policy,
        dispatch: true,
        env: parseEnv({
          ...process.env,
          GROK_BOT_WEBHOOK_URL: "https://example.com/grok-routine",
          GROK_BOT_WEBHOOK_SECRET: "grok-sender-key-for-tests",
        }),
        poster: async () => {
          posted += 1;
          return { ok: true, status: 200 };
        },
      },
    );
    expect(r.job?.namespace).toBe("leadership");
    expect(r.job?.scope).toBe("leadership");
    expect(r.job?.channel_ids).toEqual([]);
    expect(r.job?.status).toBe("queued");
    expect(r.dispatched).toBe(true);
    expect(posted).toBe(1);
  });

  test("POSTs thin first_pass pack (not the whole index, no tokens)", async () => {
    upsertMessage({
      id: "ctx-1",
      channelId: GENERAL,
      authorId: "u2",
      authorName: "bob",
      content: "Acme wants to sponsor the hackathon",
      createdAt: 1,
    });
    const token = "SUPER-SECRET-BOT-TOKEN-VALUE";
    let captured: {
      first_pass?: boolean;
      job?: { content: string; id: string; scope?: string; channel_ids?: string[] };
      snippets?: Array<{ content: string; path?: string; channelId?: string }>;
    } = {};
    const r = await tryEnqueueJob(
      candidate({
        discordMessageId: "e-dispatch",
        authorId: "disp-post",
        content: `<@${BOT}> summarize sponsors ${token}`,
      }),
      {
        triggerRoleIds: new Set([ROLE]),
        dispatch: true,
        resolveChannel,
        env: parseEnv({
          ...process.env,
          GROK_BOT_WEBHOOK_URL: "https://example.com/grok-routine",
          GROK_BOT_WEBHOOK_SECRET: "grok-sender-key-for-tests",
          DISCORD_BOT_TOKEN: token,
        }),
        poster: async (_url, body, headers) => {
          captured = body as typeof captured;
          const json = JSON.stringify(body);
          expect(json).not.toContain(token);
          expect(json).not.toContain("DISCORD_BOT_TOKEN");
          expect(json).not.toContain("grok-sender-key-for-tests");
          expect(json).not.toMatch(/api\/webhooks/);
          expect(json).not.toContain("/Users/");
          expect(headers?.Authorization).toBe("Bearer grok-sender-key-for-tests");
          expect(JSON.stringify(headers)).not.toContain(token);
          return { ok: true, status: 200 };
        },
      },
    );
    expect(r.dispatched).toBe(true);
    expect(captured.first_pass).toBe(true);
    expect(captured.job?.id).toBe(r.job?.id);
    expect(captured.job?.scope).toBe("channel");
    expect(captured.job?.channel_ids).toEqual([GENERAL]);
    expect(captured.snippets?.length ?? 0).toBeGreaterThan(0);
    expect(captured.snippets?.every((s) => !s.path || s.path.startsWith("/general"))).toBe(true);
  });
});

describe("MVP channel scope", () => {
  beforeAll(() => {
    upsertMessage({
      id: "scope-gen",
      channelId: GENERAL,
      authorId: "u2",
      authorName: "bob",
      content: "general only secret",
      createdAt: 200,
    });
    upsertMessage({
      id: "scope-mkt",
      channelId: MARKETING,
      authorId: "u2",
      authorName: "bob",
      content: "marketing campaign notes",
      createdAt: 201,
    });
    upsertMessage({
      id: "scope-lead",
      channelId: LEADERSHIP,
      authorId: "u2",
      authorName: "bob",
      content: "leadership budget confidential",
      createdAt: 202,
    });
    upsertMessage({
      id: "scope-lead-b",
      channelId: LEADERSHIP_B,
      authorId: "u2",
      authorName: "bob",
      content: "other isolated channel",
      createdAt: 203,
    });
  });

  type Captured = {
    job?: { scope?: string; channel_ids?: string[]; namespace?: string };
    snippets?: Array<{ content: string; path?: string; channelId?: string }>;
  };

  async function dispatchScope(over: Partial<JobCandidate> & { discordMessageId: string }, canView?: (id: string) => boolean) {
    let captured: Captured = {};
    let posted = 0;
    const result = await tryEnqueueJob(candidate({ authorId: `scope-${over.discordMessageId}`, ...over }), {
      ...policy,
      dispatch: true,
      canViewChannel: canView,
      env: parseEnv({
        ...process.env,
        GROK_BOT_WEBHOOK_URL: "https://example.com/grok-routine",
        GROK_BOT_WEBHOOK_SECRET: "grok-sender-key-for-tests",
      }),
      poster: async (_url, body) => {
        posted += 1;
        captured = body as Captured;
        return { ok: true, status: 200 };
      },
    });
    return { result, captured, posted };
  }

  test("general @bot with no mentions → snippets/payload only originating channel", async () => {
    const { result, captured } = await dispatchScope({ discordMessageId: "scope-no-mention" });
    expect(result.job?.scope).toBe("channel");
    expect(result.job?.channel_ids).toEqual([GENERAL]);
    expect(captured.job?.channel_ids).toEqual([GENERAL]);
    expect(captured.job?.scope).toBe("channel");
    const ids = captured.snippets?.map((s) => s.channelId) ?? [];
    expect(ids.every((id) => id === GENERAL)).toBe(true);
    expect(captured.snippets?.some((s) => s.content.includes("general only"))).toBe(true);
    expect(captured.snippets?.some((s) => s.content.includes("marketing"))).toBe(false);
    expect(captured.snippets?.some((s) => s.content.includes("leadership"))).toBe(false);
    expect(captured.snippets?.every((s) => !s.path || s.path.startsWith(`/general/${GENERAL}/`))).toBe(true);
  });

  test("general @bot with #marketing mention + ViewChannel → originating + marketing", async () => {
    const { result, captured } = await dispatchScope(
      {
        discordMessageId: "scope-mkt-view",
        content: `<@${BOT}> summarize here and also check <#${MARKETING}>`,
        mentionedChannelIds: [MARKETING],
      },
      (id) => id === MARKETING,
    );
    expect(result.job?.channel_ids).toEqual([GENERAL, MARKETING]);
    expect(captured.job?.channel_ids).toEqual([GENERAL, MARKETING]);
    const ids = new Set(captured.snippets?.map((s) => s.channelId));
    expect(ids.has(GENERAL)).toBe(true);
    expect(ids.has(MARKETING)).toBe(true);
    expect(ids.has(LEADERSHIP)).toBe(false);
    expect(captured.snippets?.some((s) => s.content.includes("marketing campaign"))).toBe(true);
  });

  test("general @bot with #marketing but no ViewChannel → originating only", async () => {
    const { result, captured } = await dispatchScope({
      discordMessageId: "scope-mkt-noview",
      content: `<@${BOT}> check <#${MARKETING}>`,
      mentionedChannelIds: [MARKETING],
    });
    expect(result.job?.channel_ids).toEqual([GENERAL]);
    expect(captured.job?.channel_ids).toEqual([GENERAL]);
    expect(captured.snippets?.some((s) => s.channelId === MARKETING)).toBe(false);
    expect(captured.snippets?.some((s) => s.content.includes("marketing campaign"))).toBe(false);
  });

  test("general @bot mentioning an isolated channel → isolated id NOT added", async () => {
    const { result, captured } = await dispatchScope(
      {
        discordMessageId: "scope-iso-mention",
        content: `<@${BOT}> also see <#${LEADERSHIP}>`,
        mentionedChannelIds: [LEADERSHIP],
      },
      () => true,
    );
    expect(result.job?.channel_ids).not.toContain(LEADERSHIP);
    expect(result.job?.channel_ids).toEqual([GENERAL]);
    expect(captured.job?.channel_ids).toEqual([GENERAL]);
    expect(captured.snippets?.some((s) => s.channelId === LEADERSHIP)).toBe(false);
    expect(captured.snippets?.some((s) => s.content.includes("leadership budget"))).toBe(false);
  });

  test("leadership @bot → no channel_ids restriction / full leadership, and dispatch is not skipped", async () => {
    const { result, captured, posted } = await dispatchScope({
      discordMessageId: "scope-lead-full",
      discordChannelId: LEADERSHIP,
      parentChannelId: null,
      content: `<@${BOT}> summarize leadership`,
    });
    expect(result.dispatched).toBe(true);
    expect(posted).toBe(1);
    expect(result.job?.namespace).toBe("leadership");
    expect(result.job?.scope).toBe("leadership");
    expect(result.job?.channel_ids).toEqual([]);
    expect(captured.job?.scope).toBe("leadership");
    expect(captured.job?.channel_ids).toEqual([]);
    expect(captured.snippets?.some((s) => s.content.includes("leadership budget"))).toBe(true);
    expect(captured.snippets?.some((s) => s.content.includes("other isolated"))).toBe(true);
    expect(captured.snippets?.some((s) => s.content.includes("general only"))).toBe(false);
    expect(captured.snippets?.every((s) => !s.path || s.path.startsWith("/leadership"))).toBe(true);
  });
});
