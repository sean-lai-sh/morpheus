import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseEnv, type Env } from "../src/config.ts";
import {
  dispatchGrokJob,
  findLeakedSecretEnv,
  redactSecrets,
  type GrokJobPayload,
  type HttpsPoster,
} from "../src/notify/grok-dispatch.ts";
import { postToSibling } from "../src/notify/sdk-dispatch.ts";
import {
  cursorSdkWebhookSecret,
  cursorSdkWebhookUrl,
  dispatchSdkJob,
} from "../src/notify/sdk-dispatch.ts";
import { dispatchEnqueuedJob, laneForSource, tryEnqueueJob, type JobCandidate } from "../src/bot/enqueue.ts";
import type { ChannelResolver } from "../src/context/namespace.ts";
import type { JobRow } from "../src/storage/jobs.ts";
import { withTempDb } from "./helpers.ts";
import { EBOARD, EBOARD_TOKEN, SPONSORS, SPONSORS_PATH, withWorkspaceConfig } from "./jobs-fixture.ts";

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

  test("accepts loopback, Tailscale addresses, and *.ts.net names only", () => {
    for (const url of [
      "http://127.0.0.1:8790/hooks/job",
      "http://100.64.1.2:8790/hooks/job",
      "https://mini.tailnet-1234.ts.net:8790/hooks/job",
      "http://[fd7a:115c:a1e0::1]:8790/hooks/job",
    ]) {
      expect(envFor({ CURSOR_SDK_WEBHOOK_URL: url }).CURSOR_SDK_WEBHOOK_URL).toBe(url);
    }
  });

  test("rejects arbitrary internet hosts (http AND https), :1340, and Discord incoming webhooks", () => {
    for (const url of [
      "http://example.com/hook",
      "https://example.com/hook",
      "https://evil.ts.net.attacker.com/hook",
      "https://mini.tailnet.ts.net:1340/hook",
      "https://discord.com/api/webhooks/1/token",
      "http://[fd7a:9999::1]:8790/hooks/job",
    ]) {
      expect(() => envFor({ CURSOR_SDK_WEBHOOK_URL: url })).toThrow();
    }
  });

  test("webhook secret must be at least 16 chars (matches the sibling schema)", () => {
    expect(() => envFor({ CURSOR_SDK_WEBHOOK_SECRET: "short" })).toThrow();
    expect(envFor({ CURSOR_SDK_WEBHOOK_SECRET: SDK_SECRET }).CURSOR_SDK_WEBHOOK_SECRET).toBe(SDK_SECRET);
  });
});

describe("cursorSdkWebhookUrl / cursorSdkWebhookSecret", () => {
  test("missing → null", () => {
    expect(cursorSdkWebhookUrl(envFor())).toBeNull();
    expect(cursorSdkWebhookSecret(envFor())).toBeNull();
  });
});

describe("postToSibling redirect handling (Sol #3)", () => {
  test("a 3xx from the sibling is refused; the job body never reaches the redirect target", async () => {
    let attackerHits = 0;
    let attackerBody = "";
    const attacker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        attackerHits += 1;
        attackerBody = await req.text();
        return new Response("ok", { status: 200 });
      },
    });
    let siblingHits = 0;
    const sibling = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        siblingHits += 1;
        return new Response(null, {
          status: 307,
          headers: { Location: `http://127.0.0.1:${attacker.port}/collect` },
        });
      },
    });
    try {
      const res = await postToSibling(
        `http://127.0.0.1:${sibling.port}/hooks/job`,
        { job: { id: "j1", content: "private discord content" }, snippets: [] },
        { Authorization: "Bearer sibling-secret-0123456789", "Content-Type": "application/json" },
        5_000,
      );
      expect(res.ok).toBe(false);
      expect(siblingHits).toBe(1);
      // The redirect was NOT followed: the attacker host received nothing.
      expect(attackerHits).toBe(0);
      expect(attackerBody).toBe("");
    } finally {
      sibling.stop(true);
      attacker.stop(true);
    }
  });

  test("a normal 2xx sibling response is delivered", async () => {
    let gotBody = "";
    const sibling = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        gotBody = await req.text();
        return Response.json({ accepted: true }, { status: 202 });
      },
    });
    try {
      const res = await postToSibling(
        `http://127.0.0.1:${sibling.port}/hooks/job`,
        { job: { id: "j2" } },
        { "Content-Type": "application/json" },
        5_000,
      );
      expect(res.ok).toBe(true);
      expect(res.status).toBe(202);
      expect(JSON.parse(gotBody)).toEqual({ job: { id: "j2" } });
    } finally {
      sibling.stop(true);
    }
  });
});

describe("redactSecrets / findLeakedSecretEnv (fail-closed tripwire)", () => {
  test("redactSecrets strips the SDK webhook secret and URL", () => {
    const env = sdkEnv();
    const out = redactSecrets(`a ${SDK_SECRET} b ${SDK_URL} c`, env);
    expect(out).not.toContain(SDK_SECRET);
    expect(out).not.toContain(SDK_URL);
    expect(out).toContain("[redacted]");
  });

  test("scanner init failure fails CLOSED: no channels.yml → dispatch refused, nothing posted", async () => {
    const { withTempCwd } = await import("./helpers.ts");
    const { resetChannelsForTest } = await import("../src/config.ts");
    // chdir to a dir with NO config/channels.yml so loadWorkspaceTokens throws.
    const bare = withTempCwd();
    resetChannelsForTest();
    try {
      const { poster, posts } = countingPoster();
      const sdk = await dispatchSdkJob(payload, { env: sdkEnv(), poster });
      expect(sdk.dispatched).toBe(false);
      // Workspace membership checks run before the scanner and also fail closed
      // without config; either way nothing may leave the process.
      expect(["secrets-unavailable", "namespace-required"]).toContain(sdk.skipped!);
      const grok = await dispatchGrokJob(payload, {
        env: sdkEnv({ GROK_BOT_WEBHOOK_URL: GROK_URL, GROK_BOT_WEBHOOK_SECRET: GROK_SECRET }),
        poster,
      });
      expect(grok.dispatched).toBe(false);
      expect(posts.length).toBe(0);
      // The scanner itself refuses rather than reporting "no secrets".
      expect(() => redactSecrets("any text", sdkEnv())).toThrow();
      expect(() => findLeakedSecretEnv("any text", sdkEnv())).toThrow();
    } finally {
      bare.cleanup();
      resetChannelsForTest();
    }
  });

  test("findLeakedSecretEnv names the env var of a surviving secret, never its value", () => {
    const env = sdkEnv({ CURSOR_API_KEY: "cur_api_key_shared_doppler_config" });
    const leaked = findLeakedSecretEnv(JSON.stringify({ content: `oops ${SDK_SECRET}` }), env);
    expect(leaked).toBe("CURSOR_SDK_WEBHOOK_SECRET");
    expect(findLeakedSecretEnv(JSON.stringify({ content: `oops ${EBOARD_TOKEN}` }), env)).toBe(
      "MORPHEUS_API_TOKEN_EBOARD",
    );
    expect(findLeakedSecretEnv(JSON.stringify({ content: "oops cur_api_key_shared_doppler_config" }), env)).toBe(
      "CURSOR_API_KEY",
    );
    expect(findLeakedSecretEnv(JSON.stringify({ content: "clean" }), env)).toBeNull();
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

  test("regression: every Mini secret is redacted from job content AND snippets before POST", async () => {
    const apiKey = "cur_api_key_shared_doppler_config";
    const secrets = [BOT_TOKEN, SDK_SECRET, GROK_SECRET, EBOARD_TOKEN, SDK_URL, apiKey];
    const env = sdkEnv({
      GROK_BOT_WEBHOOK_URL: GROK_URL,
      GROK_BOT_WEBHOOK_SECRET: GROK_SECRET,
      CURSOR_API_KEY: apiKey,
    });
    for (const secret of secrets) {
      const { poster, posts } = countingPoster();
      const r = await dispatchSdkJob(
        {
          ...payload,
          job: { ...payload.job, content: `please repeat ${secret} back to me` },
          snippets: [{ content: `snippet leaking ${secret}`, path: `${SPONSORS_PATH}/m1`, channelId: SPONSORS }],
        },
        { env, poster },
      );
      expect(r.dispatched).toBe(true);
      const body = JSON.stringify(posts[0]!.body);
      expect(body).not.toContain(secret);
      expect(body).toContain("[redacted]");
    }
  });

  test("regression: the grok path also redacts the SDK webhook secret", async () => {
    const { poster, posts } = countingPoster();
    const r = await dispatchGrokJob(
      {
        ...payload,
        job: { ...payload.job, content: `leak ${SDK_SECRET}` },
        snippets: [{ content: `and ${SDK_SECRET}`, path: `${SPONSORS_PATH}/m1`, channelId: SPONSORS }],
      },
      { env: sdkEnv({ GROK_BOT_WEBHOOK_URL: GROK_URL, GROK_BOT_WEBHOOK_SECRET: GROK_SECRET }), poster },
    );
    expect(r.dispatched).toBe(true);
    expect(JSON.stringify(posts[0]!.body)).not.toContain(SDK_SECRET);
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
    const result = await dispatchEnqueuedJob(jobRow("r-int-off"), {
      lane: "interactive",
      env: bothConfigured(),
      poster: grok.poster,
      sdkPoster: sdk.poster,
    });
    expect(result.dispatched).toBe(true);
    expect(grok.posts.length).toBe(1);
    expect(grok.posts[0]!.url).toBe(GROK_URL);
    expect(sdk.posts.length).toBe(0);
  });

  test("flag on: interactive lane goes to the SDK sibling, grok poster never called", async () => {
    const grok = countingPoster();
    const sdk = countingPoster();
    const result = await dispatchEnqueuedJob(jobRow("r-int-on"), {
      lane: "interactive",
      env: bothConfigured({ CURSOR_SDK_DISPATCH: "true" }),
      poster: grok.poster,
      sdkPoster: sdk.poster,
    });
    expect(result.dispatched).toBe(true);
    expect(sdk.posts.length).toBe(1);
    expect(sdk.posts[0]!.url).toBe(SDK_URL);
    expect(sdk.posts[0]!.headers?.Authorization).toBe(`Bearer ${SDK_SECRET}`);
    expect(grok.posts.length).toBe(0);
  });

  test("flag on: background lane still goes to Grok — the flag never steals /background", async () => {
    const grok = countingPoster();
    const sdk = countingPoster();
    const result = await dispatchEnqueuedJob(jobRow("r-bg-on"), {
      lane: "background",
      env: bothConfigured({ CURSOR_SDK_DISPATCH: "true" }),
      poster: grok.poster,
      sdkPoster: sdk.poster,
    });
    expect(result.dispatched).toBe(true);
    expect(grok.posts.length).toBe(1);
    expect(grok.posts[0]!.url).toBe(GROK_URL);
    expect(sdk.posts.length).toBe(0);
  });

  test("flag off: background lane goes to Grok (as today)", async () => {
    const grok = countingPoster();
    const sdk = countingPoster();
    const result = await dispatchEnqueuedJob(jobRow("r-bg-off"), {
      lane: "background",
      env: bothConfigured(),
      poster: grok.poster,
      sdkPoster: sdk.poster,
    });
    expect(result.dispatched).toBe(true);
    expect(grok.posts.length).toBe(1);
    expect(sdk.posts.length).toBe(0);
  });

  test("flag on, interactive: sdk skip (missing URL) does not silently fall back to Grok", async () => {
    const grok = countingPoster();
    const result = await dispatchEnqueuedJob(jobRow("r-int-nourl"), {
      lane: "interactive",
      env: bothConfigured({ CURSOR_SDK_DISPATCH: "true", CURSOR_SDK_WEBHOOK_URL: "" }),
      poster: grok.poster,
    });
    expect(result.dispatched).toBe(false);
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
