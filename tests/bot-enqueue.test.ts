import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { withTempCwd, withTempDb } from "./helpers.ts";
import { resetChannelsForTest } from "../src/config.ts";
import { authorPassesRoleGate, tryEnqueueJob, type JobCandidate } from "../src/bot/enqueue.ts";
import { upsertMessage } from "../src/storage/messages.ts";
import { getJobByDiscordMessageId } from "../src/storage/jobs.ts";

const ROLE = "role-eboard";
const BOT = "bot-1";
const GENERAL = "111111111111111111";
const LEADERSHIP = "222222222222222222";

function writeChannels(): void {
  mkdirSync(resolve(process.cwd(), "config"), { recursive: true });
  writeFileSync(
    resolve(process.cwd(), "config/channels.yml"),
    `
channels:
  - id: "${GENERAL}"
    name: "eboard"
    include_threads: true
    isolated: false
  - id: "${LEADERSHIP}"
    name: "leadership-team"
    include_threads: true
    isolated: true
defaults:
  confidence_threshold: 0.5
  reconcile_lookback: 200
  reconcile_interval_hours: 6
`,
    "utf8",
  );
  resetChannelsForTest();
}

const cwd = withTempCwd();
writeChannels();
const db = withTempDb();
beforeAll(() => {});
afterAll(() => {
  db.cleanup();
  cwd.cleanup();
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
      env: { ...process.env, GROK_BOT_WEBHOOK_URL: "" },
    });
    expect(r.job?.status).toBe("queued");
    expect(r.dispatched).toBe(false);
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
      job?: { content: string; id: string };
      snippets?: Array<{ content: string; path?: string }>;
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
        env: {
          GROK_BOT_WEBHOOK_URL: "https://example.com/grok-routine",
          DISCORD_BOT_TOKEN: token,
        },
        poster: async (_url, body) => {
          captured = body as typeof captured;
          const json = JSON.stringify(body);
          expect(json).not.toContain(token);
          expect(json).not.toContain("DISCORD_BOT_TOKEN");
          expect(json).not.toMatch(/api\/webhooks/);
          expect(json).not.toContain("/Users/");
          return { ok: true, status: 200 };
        },
      },
    );
    expect(r.dispatched).toBe(true);
    expect(captured.first_pass).toBe(true);
    expect(captured.job?.id).toBe(r.job?.id);
    expect(captured.snippets?.length ?? 0).toBeGreaterThan(0);
    expect(captured.snippets?.every((s) => !s.path || s.path.startsWith("/general"))).toBe(true);
  });
});
