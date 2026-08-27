import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseEnv, type Env } from "../src/config.ts";
import type { GrokJobPayload, HttpsPoster } from "../src/notify/grok-dispatch.ts";
import {
  cursorSdkWebhookSecret,
  cursorSdkWebhookUrl,
  dispatchSdkJob,
} from "../src/notify/sdk-dispatch.ts";
import { dispatchEnqueuedJob, laneForSource, tryEnqueueJob, type JobCandidate } from "../src/bot/enqueue.ts";
import type { ChannelResolver } from "../src/context/namespace.ts";
import type { JobRow } from "../src/storage/jobs.ts";
import { withTempDb } from "./helpers.ts";
import { EBOARD, SPONSORS, SPONSORS_PATH, withWorkspaceConfig } from "./jobs-fixture.ts";

const SDK_URL = "http://127.0.0.1:8790";
const SDK_SECRET = "sdk-sibling-secret-not-a-discord-token";
const GROK_URL = "https://example.com/grok-routine";
const GROK_SECRET = "grok-sender-key-not-a-discord-token";
const GUILD = "123456789012345678";
const BOT_TOKEN = "test-discord-token-value";

let cfg: ReturnType<typeof withWorkspaceConfig>;
let db: ReturnType<typeof withTempDb>;
beforeAll(() => {
  cfg = withWorkspaceConfig();
  db = withTempDb();
});
afterAll(() => {
  db.cleanup();
  cfg.cleanup();
});

function envFor(over: Record<string, string | undefined> = {}): Env {
  return parseEnv({
    DISCORD_BOT_TOKEN: BOT_TOKEN,
    DISCORD_GUILD_ID: GUILD,
    ...over,
  });
}

/** SDK flag on with URL + secret + dispatch allowlist. */
function sdkEnv(over: Record<string, string | undefined> = {}): Env {
  return envFor({
    CURSOR_SDK_DISPATCH: "true",
    CURSOR_SDK_WEBHOOK_URL: SDK_URL,
    CURSOR_SDK_WEBHOOK_SECRET: SDK_SECRET,
    GROK_DISPATCH_WORKSPACES: EBOARD,
    ...over,
  });
}

const payload: GrokJobPayload = {
  job: {
    id: "j1",
    namespace: EBOARD,
    discord_channel_id: SPONSORS,
    content: "summarize sponsors",
  },
  snippets: [{ content: "Acme wants to sponsor", path: `${SPONSORS_PATH}/m1`, channelId: SPONSORS }],
  first_pass: true,
};

function countingPoster(): { poster: HttpsPoster; posts: Array<{ url: string; body: unknown; headers?: Record<string, string> }> } {
  const posts: Array<{ url: string; body: unknown; headers?: Record<string, string> }> = [];
  return {
    posts,
    poster: async (url, body, headers) => {
      posts.push({ url, body, ...(headers ? { headers } : {}) });
      return { ok: true, status: 200 };
    },
  };
}

describe("CURSOR_SDK_DISPATCH env", () => {
  test("defaults to false (experiment gate off)", () => {
    expect(envFor().CURSOR_SDK_DISPATCH).toBe(false);
  });

  test("accepts http on loopback and https elsewhere", () => {
    expect(envFor({ CURSOR_SDK_WEBHOOK_URL: "http://127.0.0.1:8790" }).CURSOR_SDK_WEBHOOK_URL).toBe(
      "http://127.0.0.1:8790",
    );
    expect(envFor({ CURSOR_SDK_WEBHOOK_URL: "https://mini.ts.net:8790" }).CURSOR_SDK_WEBHOOK_URL).toBe(
      "https://mini.ts.net:8790",
    );
  });

  test("rejects plain http off loopback/Tailscale, :1340, and Discord incoming webhooks", () => {
    expect(() => envFor({ CURSOR_SDK_WEBHOOK_URL: "http://example.com/hook" })).toThrow();
    expect(() => envFor({ CURSOR_SDK_WEBHOOK_URL: "https://example.com:1340/hook" })).toThrow();
    expect(() =>
      envFor({ CURSOR_SDK_WEBHOOK_URL: "https://discord.com/api/webhooks/1/token" }),
    ).toThrow();
  });
});

describe("cursorSdkWebhookUrl / cursorSdkWebhookSecret", () => {
  test("missing → null", () => {
    expect(cursorSdkWebhookUrl(envFor())).toBeNull();
    expect(cursorSdkWebhookSecret(envFor())).toBeNull();
  });
});

describe("dispatchSdkJob", () => {
  test("flag off (default): silent skip, nothing posted", async () => {
    const { poster, posts } = countingPoster();
    const r = await dispatchSdkJob(payload, {
      env: envFor({
        CURSOR_SDK_WEBHOOK_URL: SDK_URL,
        CURSOR_SDK_WEBHOOK_SECRET: SDK_SECRET,
        GROK_DISPATCH_WORKSPACES: EBOARD,
      }),
      poster,
    });
    expect(r.dispatched).toBe(false);
    expect(r.skipped).toBe("sdk-dispatch-disabled");
    expect(posts.length).toBe(0);
  });

  test("workspace allowlist is default deny (empty GROK_DISPATCH_WORKSPACES)", async () => {
    const { poster, posts } = countingPoster();
    const r = await dispatchSdkJob(payload, { env: sdkEnv({ GROK_DISPATCH_WORKSPACES: "" }), poster });
    expect(r.dispatched).toBe(false);
    expect(r.skipped).toBe("workspace-not-dispatchable");
    expect(posts.length).toBe(0);
  });

  test("unknown workspace refused before anything is posted", async () => {
    const { poster, posts } = countingPoster();
    const r = await dispatchSdkJob(
      { ...payload, job: { ...payload.job, namespace: "general" } },
      { env: sdkEnv({ GROK_DISPATCH_WORKSPACES: "general" }), poster },
    );
    expect(r.dispatched).toBe(false);
    expect(r.skipped).toBe("namespace-required");
    expect(posts.length).toBe(0);
  });

  test("missing URL → warn skip, same as grok-dispatch", async () => {
    const r = await dispatchSdkJob(payload, { env: sdkEnv({ CURSOR_SDK_WEBHOOK_URL: "" }) });
    expect(r.dispatched).toBe(false);
    expect(r.skipped).toBe("missing-sdk-webhook-url");
  });

  test("missing secret → warn skip", async () => {
    const r = await dispatchSdkJob(payload, { env: sdkEnv({ CURSOR_SDK_WEBHOOK_SECRET: "" }) });
    expect(r.dispatched).toBe(false);
    expect(r.skipped).toBe("missing-sdk-webhook-secret");
  });

  test("POSTs the capped pack with Bearer auth; no bot token or secret in body", async () => {
    const { poster, posts } = countingPoster();
    const r = await dispatchSdkJob(payload, { env: sdkEnv(), poster });
    expect(r.dispatched).toBe(true);
    expect(posts.length).toBe(1);
    const post = posts[0]!;
    expect(post.url).toBe(SDK_URL);
    expect(post.headers?.Authorization).toBe(`Bearer ${SDK_SECRET}`);
    const bodyJson = JSON.stringify(post.body);
    expect(bodyJson).not.toContain(BOT_TOKEN);
    expect(bodyJson).not.toContain(SDK_SECRET);
    const body = post.body as GrokJobPayload;
    expect(body.first_pass).toBe(true);
    expect(body.job.id).toBe("j1");
    expect(body.job.namespace).toBe(EBOARD);
    expect(body.snippets[0]?.path).toBe(`${SPONSORS_PATH}/m1`);
  });
});

describe("laneForSource", () => {
  test("mention and /ask are interactive; /background is background", () => {
    expect(laneForSource("mention")).toBe("interactive");
    expect(laneForSource("slash")).toBe("interactive");
    expect(laneForSource("background")).toBe("background");
  });
});

describe("dispatchEnqueuedJob lane routing", () => {
  function jobRow(id: string): JobRow {
    return {
      id,
      discord_message_id: `msg-${id}`,
      discord_channel_id: SPONSORS,
      discord_thread_id: null,
      author_id: "42",
      namespace: EBOARD,
      scope: "channel",
      channel_ids: [SPONSORS],
      content: "summarize sponsors",
      status: "queued",
      claimed_by: null,
      claimed_at: null,
      result_discord_message_id: null,
      reply_text: null,
      completion_key: null,
      github_issue_url: null,
      error: null,
      created_at: 0,
      updated_at: 0,
    };
  }

  /** Grok + SDK both fully configured; only the flag/lane decides the route. */
  function bothConfigured(over: Record<string, string | undefined> = {}): Env {
    return envFor({
      GROK_BOT_WEBHOOK_URL: GROK_URL,
      GROK_BOT_WEBHOOK_SECRET: GROK_SECRET,
      GROK_DISPATCH_WORKSPACES: EBOARD,
      CURSOR_SDK_WEBHOOK_URL: SDK_URL,
      CURSOR_SDK_WEBHOOK_SECRET: SDK_SECRET,
      ...over,
    });
  }

  test("flag off (default): interactive lane goes to Grok, sdk poster never called", async () => {
    const grok = countingPoster();
    const sdk = countingPoster();
    const dispatched = await dispatchEnqueuedJob(jobRow("r-int-off"), {
      lane: "interactive",
      env: bothConfigured(),
      poster: grok.poster,
      sdkPoster: sdk.poster,
    });
    expect(dispatched).toBe(true);
    expect(grok.posts.length).toBe(1);
    expect(grok.posts[0]!.url).toBe(GROK_URL);
    expect(sdk.posts.length).toBe(0);
  });

  test("flag on: interactive lane goes to the SDK sibling, grok poster never called", async () => {
    const grok = countingPoster();
    const sdk = countingPoster();
    const dispatched = await dispatchEnqueuedJob(jobRow("r-int-on"), {
      lane: "interactive",
      env: bothConfigured({ CURSOR_SDK_DISPATCH: "true" }),
      poster: grok.poster,
      sdkPoster: sdk.poster,
    });
    expect(dispatched).toBe(true);
    expect(sdk.posts.length).toBe(1);
    expect(sdk.posts[0]!.url).toBe(SDK_URL);
    expect(sdk.posts[0]!.headers?.Authorization).toBe(`Bearer ${SDK_SECRET}`);
    expect(grok.posts.length).toBe(0);
  });

  test("flag on: background lane still goes to Grok — the flag never steals /background", async () => {
    const grok = countingPoster();
    const sdk = countingPoster();
    const dispatched = await dispatchEnqueuedJob(jobRow("r-bg-on"), {
      lane: "background",
      env: bothConfigured({ CURSOR_SDK_DISPATCH: "true" }),
      poster: grok.poster,
      sdkPoster: sdk.poster,
    });
    expect(dispatched).toBe(true);
    expect(grok.posts.length).toBe(1);
    expect(grok.posts[0]!.url).toBe(GROK_URL);
    expect(sdk.posts.length).toBe(0);
  });

  test("flag off: background lane goes to Grok (as today)", async () => {
    const grok = countingPoster();
    const sdk = countingPoster();
    const dispatched = await dispatchEnqueuedJob(jobRow("r-bg-off"), {
      lane: "background",
      env: bothConfigured(),
      poster: grok.poster,
      sdkPoster: sdk.poster,
    });
    expect(dispatched).toBe(true);
    expect(grok.posts.length).toBe(1);
    expect(sdk.posts.length).toBe(0);
  });

  test("flag on, interactive: sdk skip (missing URL) does not silently fall back to Grok", async () => {
    const grok = countingPoster();
    const dispatched = await dispatchEnqueuedJob(jobRow("r-int-nourl"), {
      lane: "interactive",
      env: bothConfigured({ CURSOR_SDK_DISPATCH: "true", CURSOR_SDK_WEBHOOK_URL: "" }),
      poster: grok.poster,
    });
    expect(dispatched).toBe(false);
    expect(grok.posts.length).toBe(0);
  });
});

describe("tryEnqueueJob lane routing (source → worker)", () => {
  const ROLE = "role-eboard";
  const resolveChannel: ChannelResolver = (id) =>
    id === SPONSORS ? { workspace: EBOARD, id: SPONSORS, name: "sponsors", category: "eboard-teams" } : undefined;

  function candidate(over: Partial<JobCandidate> & { discordMessageId: string }): JobCandidate {
    return {
      discordChannelId: SPONSORS,
      discordThreadId: null,
      parentChannelId: null,
      authorId: "u-lane",
      authorIsBot: false,
      authorRoleIds: [ROLE],
      content: "research sponsor pipelines",
      mentionedBot: false,
      replyToBot: false,
      source: "background",
      ...over,
    };
  }

  const policy = {
    triggerRoleIds: new Set([ROLE]),
    maxOutstanding: 50,
    maxPerHour: 50,
    resolveChannel,
  };

  test("/background enqueues and POSTs to the Grok URL even with the SDK flag on", async () => {
    const grok = countingPoster();
    const sdk = countingPoster();
    const r = await tryEnqueueJob(candidate({ discordMessageId: "lane-bg-1", source: "background" }), {
      ...policy,
      env: sdkEnv({ GROK_BOT_WEBHOOK_URL: GROK_URL, GROK_BOT_WEBHOOK_SECRET: GROK_SECRET }),
      poster: grok.poster,
      sdkPoster: sdk.poster,
    });
    expect(r.skipped).toBeUndefined();
    expect(r.job?.status).toBe("queued");
    expect(r.dispatched).toBe(true);
    expect(grok.posts.length).toBe(1);
    expect(grok.posts[0]!.url).toBe(GROK_URL);
    expect(sdk.posts.length).toBe(0);
  });

  test("flag off: @mention goes to Grok as today", async () => {
    const grok = countingPoster();
    const sdk = countingPoster();
    const r = await tryEnqueueJob(
      candidate({ discordMessageId: "lane-mention-1", source: "mention", mentionedBot: true }),
      {
        ...policy,
        env: envFor({
          GROK_BOT_WEBHOOK_URL: GROK_URL,
          GROK_BOT_WEBHOOK_SECRET: GROK_SECRET,
          GROK_DISPATCH_WORKSPACES: EBOARD,
        }),
        poster: grok.poster,
        sdkPoster: sdk.poster,
      },
    );
    expect(r.dispatched).toBe(true);
    expect(grok.posts.length).toBe(1);
    expect(sdk.posts.length).toBe(0);
  });

  test("flag off: /ask goes to Grok as today", async () => {
    const grok = countingPoster();
    const sdk = countingPoster();
    const r = await tryEnqueueJob(candidate({ discordMessageId: "lane-ask-1", source: "slash" }), {
      ...policy,
      env: envFor({
        GROK_BOT_WEBHOOK_URL: GROK_URL,
        GROK_BOT_WEBHOOK_SECRET: GROK_SECRET,
        GROK_DISPATCH_WORKSPACES: EBOARD,
      }),
      poster: grok.poster,
      sdkPoster: sdk.poster,
    });
    expect(r.dispatched).toBe(true);
    expect(grok.posts.length).toBe(1);
    expect(sdk.posts.length).toBe(0);
  });

  test("flag on: /ask goes to the SDK sibling", async () => {
    const grok = countingPoster();
    const sdk = countingPoster();
    const r = await tryEnqueueJob(candidate({ discordMessageId: "lane-ask-sdk-1", source: "slash" }), {
      ...policy,
      env: sdkEnv({ GROK_BOT_WEBHOOK_URL: GROK_URL, GROK_BOT_WEBHOOK_SECRET: GROK_SECRET }),
      poster: grok.poster,
      sdkPoster: sdk.poster,
    });
    expect(r.dispatched).toBe(true);
    expect(sdk.posts.length).toBe(1);
    expect(grok.posts.length).toBe(0);
  });
});
