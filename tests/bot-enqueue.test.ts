import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import {
  DEV_CHAT,
  DEV_CHAT_PATH,
  EBOARD,
  GENERAL_CHAT,
  GENERAL_CHAT_PATH,
  LEADERSHIP,
  LEADERSHIP_TEAM,
  LEADERSHIP_TEAM_PATH,
  MENTORSHIP_CHAT,
  PROGRAMS_DEV,
  PROGRAMS_MENTORSHIP,
  SPONSORS,
  SPONSORS_PATH,
  withWorkspaceConfig,
} from "./jobs-fixture.ts";
import { authorPassesRoleGate, tryEnqueueJob, type JobCandidate } from "../src/bot/enqueue.ts";
import { parseEnv } from "../src/config.ts";
import type { ChannelResolver } from "../src/context/namespace.ts";
import { upsertMessage } from "../src/storage/messages.ts";
import { getJobByDiscordMessageId } from "../src/storage/jobs.ts";

const ROLE = "role-eboard";
const BOT = "bot-1";
const DISPATCHABLE = [LEADERSHIP, EBOARD, PROGRAMS_MENTORSHIP, PROGRAMS_DEV].join(",");

/** Mirrors the fixture channels.yml, injected so this suite never mutates global config. */
const RESOLVED: Record<
  string,
  { workspace: string; include_threads?: boolean; id: string; name: string; category?: string }
> = {
  [SPONSORS]: { workspace: EBOARD, id: SPONSORS, name: "sponsors", category: "eboard-teams" },
  [GENERAL_CHAT]: { workspace: EBOARD, id: GENERAL_CHAT, name: "general-chat" },
  [LEADERSHIP_TEAM]: {
    workspace: LEADERSHIP,
    include_threads: true,
    id: LEADERSHIP_TEAM,
    name: "leadership-team",
    category: "eboard-teams",
  },
  [MENTORSHIP_CHAT]: {
    workspace: PROGRAMS_MENTORSHIP,
    id: MENTORSHIP_CHAT,
    name: "mentorship-chat",
    category: "programs",
  },
  [DEV_CHAT]: {
    workspace: PROGRAMS_DEV,
    include_threads: true,
    id: DEV_CHAT,
    name: "dev-chat",
    category: "programs",
  },
};
const resolveChannel: ChannelResolver = (id) => RESOLVED[id];

const db = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;
beforeAll(() => {
  cfg = withWorkspaceConfig();
});
afterAll(() => {
  cfg.cleanup();
  db.cleanup();
});

function candidate(over: Partial<JobCandidate> & { discordMessageId: string }): JobCandidate {
  return {
    discordChannelId: SPONSORS,
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
  test("mention in an allowlisted eboard channel → queued namespace=eboard", async () => {
    const r = await tryEnqueueJob(candidate({ discordMessageId: "e-eboard" }), policy);
    expect(r.skipped).toBeUndefined();
    expect(r.job?.namespace).toBe(EBOARD);
    expect(r.job?.scope).toBe("channel");
    expect(r.job?.status).toBe("queued");
  });

  test("mention in a leadership thread → namespace=leadership (not the thread id, not a default)", async () => {
    const r = await tryEnqueueJob(
      candidate({
        discordMessageId: "e-lead-thread",
        discordChannelId: "thread-999",
        discordThreadId: "thread-999",
        parentChannelId: LEADERSHIP_TEAM,
        content: `<@${BOT}> budget?`,
      }),
      policy,
    );
    expect(r.job?.namespace).toBe(LEADERSHIP);
    expect(r.job?.discord_thread_id).toBe("thread-999");
  });

  test("mention in a descendant workspace keeps that workspace, not the parent", async () => {
    const r = await tryEnqueueJob(
      candidate({ discordMessageId: "e-dev", discordChannelId: DEV_CHAT }),
      policy,
    );
    expect(r.job?.namespace).toBe(PROGRAMS_DEV);
    expect(r.job?.scope).toBe("channel");
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

  test("a channel that resolves but has no workspace → unknown-namespace", async () => {
    const r = await tryEnqueueJob(candidate({ discordMessageId: "e-no-ws", discordChannelId: "777" }), {
      ...policy,
      // Resolver knows the channel for the allowlist check but reports no workspace.
      resolveChannel: (id) => (id === "777" ? ({ workspace: "" } as never) : RESOLVED[id]),
    });
    expect(r.job).toBeNull();
    expect(r.skipped).toBe("unknown-namespace");
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
    const r = await tryEnqueueJob(candidate({ discordMessageId: "e-bot", authorIsBot: true }), policy);
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
    for (const id of ["e-cap-1", "e-cap-2"]) {
      await tryEnqueueJob(candidate({ discordMessageId: id, authorId: author }), {
        ...policy,
        maxOutstanding: 2,
        maxPerHour: 50,
      });
    }
    const r = await tryEnqueueJob(candidate({ discordMessageId: "e-cap-3", authorId: author }), {
      ...policy,
      maxOutstanding: 2,
      maxPerHour: 50,
    });
    expect(r.skipped).toBe("outstanding-cap");
  });

  test("over hourly cap → no job", async () => {
    const author = "rate-u";
    const now = 10_000_000;
    for (let i = 0; i < 5; i++) {
      await tryEnqueueJob(candidate({ discordMessageId: `e-rate-${i}`, authorId: author }), {
        ...policy,
        now,
        maxPerHour: 5,
        maxOutstanding: 50,
      });
    }
    const r = await tryEnqueueJob(candidate({ discordMessageId: "e-rate-6", authorId: author }), {
      ...policy,
      now: now + 1000,
      maxPerHour: 5,
      maxOutstanding: 50,
    });
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
      env: parseEnv({
        ...process.env,
        GROK_BOT_WEBHOOK_URL: "",
        GROK_DISPATCH_WORKSPACES: DISPATCHABLE,
      }),
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
        GROK_DISPATCH_WORKSPACES: DISPATCHABLE,
      }),
    });
    expect(r.job?.status).toBe("queued");
    expect(r.dispatched).toBe(false);
  });

  test("a workspace missing from GROK_DISPATCH_WORKSPACES is queued but never POSTed", async () => {
    let posted = 0;
    const r = await tryEnqueueJob(candidate({ discordMessageId: "e-not-dispatchable", authorId: "disp-deny" }), {
      ...policy,
      dispatch: true,
      env: parseEnv({
        ...process.env,
        GROK_BOT_WEBHOOK_URL: "https://example.com/grok-routine",
        GROK_BOT_WEBHOOK_SECRET: "grok-sender-key-for-tests",
        GROK_DISPATCH_WORKSPACES: "",
      }),
      poster: async () => {
        posted += 1;
        return { ok: true, status: 200 };
      },
    });
    expect(r.job?.status).toBe("queued");
    expect(r.dispatched).toBe(false);
    expect(posted).toBe(0);
  });

  test("a leadership job dispatches with workspace scope", async () => {
    let posted = 0;
    const r = await tryEnqueueJob(
      candidate({
        discordMessageId: "e-lead-dispatch",
        discordChannelId: "thread-lead-disp",
        discordThreadId: "thread-lead-disp",
        parentChannelId: LEADERSHIP_TEAM,
        content: `<@${BOT}> budget?`,
      }),
      {
        ...policy,
        dispatch: true,
        env: parseEnv({
          ...process.env,
          GROK_BOT_WEBHOOK_URL: "https://example.com/grok-routine",
          GROK_BOT_WEBHOOK_SECRET: "grok-sender-key-for-tests",
          GROK_DISPATCH_WORKSPACES: DISPATCHABLE,
        }),
        poster: async () => {
          posted += 1;
          return { ok: true, status: 200 };
        },
      },
    );
    expect(r.job?.namespace).toBe(LEADERSHIP);
    expect(r.job?.scope).toBe("workspace");
    expect(r.job?.channel_ids).toEqual([]);
    expect(r.job?.status).toBe("queued");
    expect(r.dispatched).toBe(true);
    expect(posted).toBe(1);
  });

  test("POSTs thin first_pass pack (not the whole index, no tokens)", async () => {
    upsertMessage({
      id: "ctx-1",
      channelId: SPONSORS,
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
          GROK_DISPATCH_WORKSPACES: DISPATCHABLE,
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
    expect(captured.job?.channel_ids).toEqual([SPONSORS]);
    expect(captured.snippets?.length ?? 0).toBeGreaterThan(0);
    expect(captured.snippets?.every((s) => !s.path || s.path.startsWith(`${SPONSORS_PATH}/`))).toBe(true);
  });
});

describe("MVP channel scope", () => {
  beforeAll(() => {
    upsertMessage({
      id: "scope-sponsors",
      channelId: SPONSORS,
      authorId: "u2",
      authorName: "bob",
      content: "sponsors only secret",
      createdAt: 200,
    });
    upsertMessage({
      id: "scope-general",
      channelId: GENERAL_CHAT,
      authorId: "u2",
      authorName: "bob",
      content: "general chat notes",
      createdAt: 201,
    });
    upsertMessage({
      id: "scope-lead",
      channelId: LEADERSHIP_TEAM,
      authorId: "u2",
      authorName: "bob",
      content: "leadership budget confidential",
      createdAt: 202,
    });
    upsertMessage({
      id: "scope-dev",
      channelId: DEV_CHAT,
      authorId: "u2",
      authorName: "bob",
      content: "dev roadmap notes",
      createdAt: 203,
    });
    upsertMessage({
      id: "scope-mentorship",
      channelId: MENTORSHIP_CHAT,
      authorId: "u2",
      authorName: "bob",
      content: "mentorship pairing notes",
      createdAt: 204,
    });
  });

  type Captured = {
    job?: { scope?: string; channel_ids?: string[]; namespace?: string };
    snippets?: Array<{ content: string; path?: string; channelId?: string }>;
  };

  async function dispatchScope(
    over: Partial<JobCandidate> & { discordMessageId: string },
    canView?: (id: string) => boolean,
  ) {
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
        GROK_DISPATCH_WORKSPACES: DISPATCHABLE,
      }),
      poster: async (_url, body) => {
        posted += 1;
        captured = body as Captured;
        return { ok: true, status: 200 };
      },
    });
    return { result, captured, posted };
  }

  test("eboard @bot with no mentions → snippets/payload only the originating channel", async () => {
    const { result, captured } = await dispatchScope({ discordMessageId: "scope-no-mention" });
    expect(result.job?.scope).toBe("channel");
    expect(result.job?.channel_ids).toEqual([SPONSORS]);
    expect(captured.job?.channel_ids).toEqual([SPONSORS]);
    expect(captured.job?.scope).toBe("channel");
    const ids = captured.snippets?.map((s) => s.channelId) ?? [];
    expect(ids.every((id) => id === SPONSORS)).toBe(true);
    expect(captured.snippets?.some((s) => s.content.includes("sponsors only"))).toBe(true);
    expect(captured.snippets?.some((s) => s.content.includes("general chat"))).toBe(false);
    expect(captured.snippets?.some((s) => s.content.includes("leadership budget"))).toBe(false);
    expect(captured.snippets?.every((s) => !s.path || s.path.startsWith(`${SPONSORS_PATH}/`))).toBe(true);
  });

  test("eboard @bot mentioning a same-workspace channel with ViewChannel → both", async () => {
    const { result, captured } = await dispatchScope(
      {
        discordMessageId: "scope-general-view",
        content: `<@${BOT}> summarize here and also check <#${GENERAL_CHAT}>`,
        mentionedChannelIds: [GENERAL_CHAT],
      },
      (id) => id === GENERAL_CHAT,
    );
    expect(result.job?.channel_ids).toEqual([SPONSORS, GENERAL_CHAT]);
    expect(captured.job?.channel_ids).toEqual([SPONSORS, GENERAL_CHAT]);
    const ids = new Set(captured.snippets?.map((s) => s.channelId));
    expect(ids.has(SPONSORS)).toBe(true);
    expect(ids.has(GENERAL_CHAT)).toBe(true);
    expect(ids.has(LEADERSHIP_TEAM)).toBe(false);
    expect(captured.snippets?.some((s) => s.path === `${GENERAL_CHAT_PATH}/scope-general`)).toBe(true);
  });

  test("eboard @bot mentioning a descendant workspace channel → added", async () => {
    const { result, captured } = await dispatchScope(
      {
        discordMessageId: "scope-dev-view",
        content: `<@${BOT}> also see <#${DEV_CHAT}>`,
        mentionedChannelIds: [DEV_CHAT],
      },
      () => true,
    );
    expect(result.job?.channel_ids).toEqual([SPONSORS, DEV_CHAT]);
    expect(captured.snippets?.some((s) => s.path === `${DEV_CHAT_PATH}/scope-dev`)).toBe(true);
  });

  test("mention without ViewChannel → originating only", async () => {
    const { result, captured } = await dispatchScope({
      discordMessageId: "scope-general-noview",
      content: `<@${BOT}> check <#${GENERAL_CHAT}>`,
      mentionedChannelIds: [GENERAL_CHAT],
    });
    expect(result.job?.channel_ids).toEqual([SPONSORS]);
    expect(captured.job?.channel_ids).toEqual([SPONSORS]);
    expect(captured.snippets?.some((s) => s.channelId === GENERAL_CHAT)).toBe(false);
  });

  test("eboard @bot mentioning a PARENT-workspace channel → not added", async () => {
    const { result, captured } = await dispatchScope(
      {
        discordMessageId: "scope-lead-mention",
        content: `<@${BOT}> also see <#${LEADERSHIP_TEAM}>`,
        mentionedChannelIds: [LEADERSHIP_TEAM],
      },
      () => true,
    );
    expect(result.job?.channel_ids).not.toContain(LEADERSHIP_TEAM);
    expect(result.job?.channel_ids).toEqual([SPONSORS]);
    expect(captured.job?.channel_ids).toEqual([SPONSORS]);
    expect(captured.snippets?.some((s) => s.channelId === LEADERSHIP_TEAM)).toBe(false);
    expect(captured.snippets?.some((s) => s.content.includes("leadership budget"))).toBe(false);
  });

  test("a programs-dev job cannot pull in a sibling workspace's channel", async () => {
    const { result, captured } = await dispatchScope(
      {
        discordMessageId: "scope-dev-sibling",
        discordChannelId: DEV_CHAT,
        content: `<@${BOT}> compare with <#${MENTORSHIP_CHAT}>`,
        mentionedChannelIds: [MENTORSHIP_CHAT],
      },
      () => true,
    );
    expect(result.job?.namespace).toBe(PROGRAMS_DEV);
    expect(result.job?.channel_ids).toEqual([DEV_CHAT]);
    expect(captured.snippets?.some((s) => s.content.includes("mentorship pairing"))).toBe(false);
  });

  test("leadership @bot → whole subtree, no channel_ids restriction, dispatch not skipped", async () => {
    const { result, captured, posted } = await dispatchScope({
      discordMessageId: "scope-lead-full",
      discordChannelId: LEADERSHIP_TEAM,
      parentChannelId: null,
      content: `<@${BOT}> summarize leadership`,
    });
    expect(result.dispatched).toBe(true);
    expect(posted).toBe(1);
    expect(result.job?.namespace).toBe(LEADERSHIP);
    expect(result.job?.scope).toBe("workspace");
    expect(result.job?.channel_ids).toEqual([]);
    expect(captured.job?.scope).toBe("workspace");
    expect(captured.job?.channel_ids).toEqual([]);
    const contents = captured.snippets?.map((s) => s.content) ?? [];
    expect(contents.some((c) => c.includes("leadership budget"))).toBe(true);
    expect(contents.some((c) => c.includes("sponsors only"))).toBe(true);
    expect(contents.some((c) => c.includes("dev roadmap"))).toBe(true);
    expect(captured.snippets?.some((s) => s.path === `${LEADERSHIP_TEAM_PATH}/scope-lead`)).toBe(true);
  });
});
