import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseEnv, resetEnvForTest, type Env } from "../src/config.ts";
import {
  capGrokPayload,
  dispatchGrokJob,
  grokBotWebhookSecret,
  grokBotWebhookUrl,
  grokDispatchAuthHeaders,
  redactSecrets,
  type GrokJobPayload,
} from "../src/notify/grok-dispatch.ts";
import {
  DEV_CHAT,
  DEV_CHAT_PATH,
  EBOARD,
  EBOARD_TOKEN,
  LEADERSHIP,
  LEADERSHIP_TOKEN,
  TOKEN_ENV,
  LEADERSHIP_TEAM_PATH,
  MENTORSHIP_CHAT_PATH,
  PROGRAMS_DEV,
  SPONSORS,
  SPONSORS_PATH,
  withWorkspaceConfig,
} from "./jobs-fixture.ts";

const URL = "https://example.com/grok-routine";
const SECRET = "grok-sender-key-not-a-discord-token";
const GUILD = "123456789012345678";

let cfg: ReturnType<typeof withWorkspaceConfig>;
beforeAll(() => {
  cfg = withWorkspaceConfig();
});
afterAll(() => cfg.cleanup());

function envFor(over: Record<string, string | undefined> = {}): Env {
  return parseEnv({
    DISCORD_BOT_TOKEN: "test-discord-token-value",
    DISCORD_GUILD_ID: GUILD,
    ...over,
  });
}

/** URL + secret + an explicit dispatch allowlist. */
function liveEnv(workspaces: string, over: Record<string, string | undefined> = {}): Env {
  return envFor({
    GROK_BOT_WEBHOOK_URL: URL,
    GROK_BOT_WEBHOOK_SECRET: SECRET,
    GROK_DISPATCH_WORKSPACES: workspaces,
    ...over,
  });
}

describe("grokBotWebhookUrl", () => {
  test("missing → null", () => {
    expect(grokBotWebhookUrl(envFor())).toBeNull();
  });

  test("accepts https", () => {
    expect(grokBotWebhookUrl(envFor({ GROK_BOT_WEBHOOK_URL: URL }))).toBe(URL);
  });
});

describe("GROK_BOT_WEBHOOK_URL refuses Discord incoming webhooks on every Discord host", () => {
  const HOSTS = [
    "discord.com",
    "ptb.discord.com",
    "canary.discord.com",
    "discordapp.com",
    "canary.discordapp.com",
    // Absolute DNS names (trailing dot) resolve to the same hosts.
    "discord.com.",
    "ptb.discord.com.",
    "discordapp.com.",
  ];

  test("parseEnv rejects a Discord webhook URL on any Discord host (first layer)", () => {
    for (const host of HOSTS) {
      const hook = `https://${host}/api/webhooks/123456789012345678/tok-tok-tok`;
      expect(() => envFor({ GROK_BOT_WEBHOOK_URL: hook })).toThrow(/Discord incoming webhook/);
    }
  });

  test("dispatch-time guard nulls every Discord host form, trailing dots included (second layer)", () => {
    for (const host of HOSTS) {
      const env: Env = {
        ...liveEnv(EBOARD),
        GROK_BOT_WEBHOOK_URL: `https://${host}/api/webhooks/123456789012345678/tok-tok-tok`,
      };
      expect(grokBotWebhookUrl(env)).toBeNull();
    }
  });

  test("versioned (/api/v10, /api/v9) and case-variant webhook paths are refused at both layers", () => {
    const paths = [
      "/api/v10/webhooks/123456789012345678/tok-tok-tok",
      "/api/v9/webhooks/123456789012345678/tok-tok-tok",
      "/API/webhooks/123456789012345678/tok-tok-tok",
      "/api/V10/Webhooks/123456789012345678/tok-tok-tok",
    ];
    for (const host of ["discord.com", "ptb.discord.com"]) {
      for (const p of paths) {
        const hook = `https://${host}${p}`;
        expect(() => envFor({ GROK_BOT_WEBHOOK_URL: hook })).toThrow(/Discord incoming webhook/);
        const env: Env = { ...liveEnv(EBOARD), GROK_BOT_WEBHOOK_URL: hook };
        expect(grokBotWebhookUrl(env)).toBeNull();
      }
    }
  });

  test("percent-encoded webhook paths are refused at both layers (Discord decodes them)", () => {
    // All of these execute as webhooks on Discord (%77=w, %65…=ebhooks, %31%30=10, %61=a, %68=h).
    const hooks = [
      "https://discord.com/api/%77ebhooks/123456789012345678/tok-tok-tok",
      "https://discord.com/api/%77%65%62%68%6f%6f%6b%73/123456789012345678/tok-tok-tok",
      "https://discord.com/api/v%31%30/webhooks/123456789012345678/tok-tok-tok",
      "https://discord.com/api/v10/%77ebhooks/123456789012345678/tok-tok-tok",
      "https://discord.com/%61pi/webhooks/123456789012345678/tok-tok-tok",
      "https://discord.com/api/web%68ooks/123456789012345678/tok-tok-tok",
      "https://ptb.discord.com/api/%77ebhooks/123456789012345678/tok-tok-tok",
      // Malformed encoding on a Discord host fails closed: treated as a webhook.
      "https://discord.com/api/%zzebhooks/123456789012345678/tok-tok-tok",
    ];
    for (const hook of hooks) {
      expect(() => envFor({ GROK_BOT_WEBHOOK_URL: hook })).toThrow(/Discord incoming webhook/);
      const env: Env = { ...liveEnv(EBOARD), GROK_BOT_WEBHOOK_URL: hook };
      expect(grokBotWebhookUrl(env)).toBeNull();
    }
    // Control pinning one-decode semantics: a double-encoded path is a generic
    // 404 on Discord (not an executable webhook), so it stays allowed.
    const doubleEncoded = "https://discord.com/api/%2577ebhooks/123456789012345678/tok-tok-tok";
    expect(grokBotWebhookUrl({ ...liveEnv(EBOARD), GROK_BOT_WEBHOOK_URL: doubleEncoded })).toBe(doubleEncoded);
  });

  test("encoded-slash (%2F) webhook paths are refused at both layers (Discord splits on the decoded separator)", () => {
    // All live-verified as execute paths on Discord (code 10015).
    const hooks = [
      "https://discord.com/api/webhooks%2F123456789012345678/tok-tok-tok",
      "https://discord.com/api/webhooks%2F123456789012345678%2Ftok-tok-tok",
      "https://discord.com/api/%2fwebhooks/123456789012345678/tok-tok-tok",
      "https://discord.com/api/v10%2Fwebhooks/123456789012345678/tok-tok-tok",
      "https://discord.com/api/v10/webhooks%2F123456789012345678%2Ftok-tok-tok",
      "https://discord.com/api/webhooks/123456789012345678%2Ftok-tok-tok",
      "https://discord.com/api/%2fwebhooks%2F123456789012345678%2Ftok-tok-tok",
    ];
    for (const hook of hooks) {
      expect(() => envFor({ GROK_BOT_WEBHOOK_URL: hook })).toThrow(/Discord incoming webhook/);
      const env: Env = { ...liveEnv(EBOARD), GROK_BOT_WEBHOOK_URL: hook };
      expect(grokBotWebhookUrl(env)).toBeNull();
    }
    // One-decode control: double-encoded %252F is a generic 404 on Discord —
    // it must not become a separator after the single decode.
    const doubleEncoded = "https://discord.com/api/webhooks%252F123456789012345678%252Ftok-tok-tok";
    expect(grokBotWebhookUrl({ ...liveEnv(EBOARD), GROK_BOT_WEBHOOK_URL: doubleEncoded })).toBe(doubleEncoded);
  });

  test("dispatchGrokJob refuses an encoded-slash webhook path; the poster is never called", async () => {
    const env: Env = {
      ...liveEnv(EBOARD),
      GROK_BOT_WEBHOOK_URL: "https://discord.com/api/webhooks%2F123456789012345678%2Ftok-tok-tok",
    };
    let posted = 0;
    const result = await dispatchGrokJob(
      {
        job: { id: "j-encslash", namespace: EBOARD, discord_channel_id: SPONSORS, content: "hi there friends" },
        snippets: [],
        first_pass: true,
      },
      {
        env,
        poster: async () => {
          posted += 1;
          return { ok: true, status: 204 };
        },
      },
    );
    expect(result.dispatched).toBe(false);
    expect(result.skipped).toBe("refused-discord-incoming-webhook");
    expect(posted).toBe(0);
  });

  test("dispatchGrokJob refuses a percent-encoded webhook path; the poster is never called", async () => {
    const env: Env = {
      ...liveEnv(EBOARD),
      GROK_BOT_WEBHOOK_URL: "https://discord.com/api/%77ebhooks/123456789012345678/tok-tok-tok",
    };
    let posted = 0;
    const result = await dispatchGrokJob(
      {
        job: { id: "j-enc", namespace: EBOARD, discord_channel_id: SPONSORS, content: "hi there friends" },
        snippets: [],
        first_pass: true,
      },
      {
        env,
        poster: async () => {
          posted += 1;
          return { ok: true, status: 204 };
        },
      },
    );
    expect(result.dispatched).toBe(false);
    expect(result.skipped).toBe("refused-discord-incoming-webhook");
    expect(posted).toBe(0);
  });

  test("dispatchGrokJob refuses a versioned v10 Discord webhook; the poster is never called", async () => {
    const env: Env = {
      ...liveEnv(EBOARD),
      GROK_BOT_WEBHOOK_URL: "https://discord.com/api/v10/webhooks/123456789012345678/tok-tok-tok",
    };
    let posted = 0;
    const result = await dispatchGrokJob(
      {
        job: { id: "j-v10", namespace: EBOARD, discord_channel_id: SPONSORS, content: "hi there friends" },
        snippets: [],
        first_pass: true,
      },
      {
        env,
        poster: async () => {
          posted += 1;
          return { ok: true, status: 204 };
        },
      },
    );
    expect(result.dispatched).toBe(false);
    expect(result.skipped).toBe("refused-discord-incoming-webhook");
    expect(posted).toBe(0);
  });

  test("dispatch-time guard refuses a ptb webhook even if env validation were bypassed", async () => {
    // Forge the Env to exercise the runtime guard directly (defense in depth).
    const env: Env = { ...liveEnv(EBOARD), GROK_BOT_WEBHOOK_URL: "https://ptb.discord.com./api/webhooks/123456789012345678/tok-tok-tok" };
    expect(grokBotWebhookUrl(env)).toBeNull();
    let posted = 0;
    const result = await dispatchGrokJob(
      {
        job: { id: "j-ptb", namespace: EBOARD, discord_channel_id: SPONSORS, content: "hi there friends" },
        snippets: [],
        first_pass: true,
      },
      {
        env,
        poster: async () => {
          posted += 1;
          return { ok: true, status: 200 };
        },
      },
    );
    expect(result.dispatched).toBe(false);
    expect(result.skipped).toBe("refused-discord-incoming-webhook");
    expect(posted).toBe(0);
  });
});

describe("grokBotWebhookSecret", () => {
  test("missing → null", () => {
    expect(grokBotWebhookSecret(envFor())).toBeNull();
  });

  test("empty → null", () => {
    expect(grokBotWebhookSecret(envFor({ GROK_BOT_WEBHOOK_SECRET: "" }))).toBeNull();
  });
});

describe("grokDispatchAuthHeaders", () => {
  test("Authorization Bearer sender key; no Discord token field", () => {
    const headers = grokDispatchAuthHeaders(SECRET);
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.stringify(headers)).not.toMatch(/DISCORD/);
  });
});

describe("redactSecrets", () => {
  test("strips every configured workspace bearer", () => {
    const out = redactSecrets(`leaked ${EBOARD_TOKEN} here`, envFor());
    expect(out).not.toContain(EBOARD_TOKEN);
    expect(out).toContain("[redacted]");
  });
});

describe("fail closed when workspace tokens cannot load", () => {
  /** Two workspaces sharing one bearer makes loadWorkspaceTokens() throw. */
  function withBrokenTokenEnv<T>(fn: () => T): T {
    const saved = process.env[TOKEN_ENV.eboard];
    process.env[TOKEN_ENV.eboard] = process.env[TOKEN_ENV.leadership];
    resetEnvForTest();
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env[TOKEN_ENV.eboard];
      else process.env[TOKEN_ENV.eboard] = saved;
      resetEnvForTest();
    }
  }

  test("redactSecrets throws instead of silently redacting nothing", () => {
    withBrokenTokenEnv(() => {
      expect(() => redactSecrets(`leaked ${LEADERSHIP_TOKEN} here`, envFor())).toThrow(/distinct/);
    });
  });

  test("dispatchGrokJob refuses dispatch; the poster is never called", async () => {
    await withBrokenTokenEnv(async () => {
      let posted = 0;
      const result = await dispatchGrokJob(
        {
          job: { id: "j-fc", namespace: EBOARD, discord_channel_id: SPONSORS, content: `leak ${LEADERSHIP_TOKEN}` },
          snippets: [],
          first_pass: true,
        },
        {
          env: liveEnv(EBOARD),
          poster: async () => {
            posted += 1;
            return { ok: true, status: 200 };
          },
        },
      );
      expect(result.dispatched).toBe(false);
      expect(result.skipped).toBe("secret-redaction-unavailable");
      expect(posted).toBe(0);
    });
  });
});

describe("dispatchGrokJob", () => {
  const payload: GrokJobPayload = {
    job: {
      id: "j1",
      namespace: EBOARD,
      discord_channel_id: SPONSORS,
      content: "summarize hello@",
    },
    snippets: [
      {
        content: "Acme wants to sponsor",
        path: `${SPONSORS_PATH}/m1`,
        channelId: SPONSORS,
      },
    ],
    feed_hint: "sponsors",
    first_pass: true,
  };

  test("skips when URL unset", async () => {
    const r = await dispatchGrokJob(payload, {
      env: envFor({ GROK_BOT_WEBHOOK_SECRET: SECRET, GROK_DISPATCH_WORKSPACES: EBOARD }),
    });
    expect(r.dispatched).toBe(false);
    expect(r.skipped).toBe("missing-grok-webhook-url");
  });

  test("skips when sender key unset", async () => {
    const r = await dispatchGrokJob(payload, {
      env: envFor({ GROK_BOT_WEBHOOK_URL: URL, GROK_DISPATCH_WORKSPACES: EBOARD }),
    });
    expect(r.dispatched).toBe(false);
    expect(r.skipped).toBe("missing-grok-webhook-secret");
  });

  test("an unknown workspace is refused before anything is posted", async () => {
    let posted = 0;
    const r = await dispatchGrokJob(
      { ...payload, job: { ...payload.job, namespace: "general" } },
      {
        env: liveEnv("general, eboard"),
        poster: async () => {
          posted += 1;
          return { ok: true, status: 200 };
        },
      },
    );
    expect(r.dispatched).toBe(false);
    expect(r.skipped).toBe("namespace-required");
    expect(posted).toBe(0);
  });

  test("empty GROK_DISPATCH_WORKSPACES refuses everything (default deny)", async () => {
    let posted = 0;
    const poster = async () => {
      posted += 1;
      return { ok: true, status: 200 };
    };
    for (const namespace of [EBOARD, LEADERSHIP, PROGRAMS_DEV]) {
      const r = await dispatchGrokJob(
        { ...payload, job: { ...payload.job, namespace } },
        { env: liveEnv(""), poster },
      );
      expect(r.dispatched).toBe(false);
      expect(r.skipped).toBe("workspace-not-dispatchable");
    }
    expect(posted).toBe(0);
  });

  test("membership is exact, not hierarchical: `eboard` does not enable programs-dev", async () => {
    let posted = 0;
    const poster = async () => {
      posted += 1;
      return { ok: true, status: 200 };
    };
    const allowed = await dispatchGrokJob(payload, { env: liveEnv(EBOARD), poster });
    expect(allowed.dispatched).toBe(true);
    expect(posted).toBe(1);

    const refused = await dispatchGrokJob(
      {
        ...payload,
        job: { ...payload.job, namespace: PROGRAMS_DEV, discord_channel_id: DEV_CHAT },
        snippets: [{ content: "dev", path: `${DEV_CHAT_PATH}/m1`, channelId: DEV_CHAT }],
      },
      { env: liveEnv(EBOARD), poster },
    );
    expect(refused.dispatched).toBe(false);
    expect(refused.skipped).toBe("workspace-not-dispatchable");
    expect(posted).toBe(1);
  });

  test("POSTs a first-pass job pack with Bearer auth (key not in body or query)", async () => {
    let captured: unknown;
    let capturedHeaders: Record<string, string> | undefined;
    let postedUrl = "";
    const r = await dispatchGrokJob(payload, {
      env: liveEnv(EBOARD),
      poster: async (posted, body, headers) => {
        postedUrl = posted;
        captured = body;
        capturedHeaders = headers;
        return { ok: true, status: 200 };
      },
    });
    expect(r.dispatched).toBe(true);
    expect(postedUrl).toBe(URL);
    expect(postedUrl).not.toMatch(/[?&]/);
    expect(postedUrl).not.toMatch(/:1340/);
    expect(captured).toEqual({
      first_pass: true,
      feed_hint: "sponsors",
      job: {
        id: "j1",
        namespace: EBOARD,
        scope: "channel",
        channel_ids: [SPONSORS],
        discord_channel_id: SPONSORS,
        content: "summarize hello@",
      },
      snippets: [
        {
          content: "Acme wants to sponsor",
          path: `${SPONSORS_PATH}/m1`,
          channelId: SPONSORS,
        },
      ],
    });
    expect(capturedHeaders?.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(captured)).not.toContain(SECRET);
    expect(JSON.stringify(capturedHeaders)).not.toContain("test-discord-token-value");
  });

  test("caps job content, snippet bytes, path, feed_hint, and channel_ids", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `${"1".repeat(16)}${String(i).padStart(2, "0")}`);
    let captured:
      | {
          job: { content: string; channel_ids?: string[] };
          snippets: Array<{ content: string; path?: string }>;
          feed_hint?: string;
        }
      | undefined;
    await dispatchGrokJob(
      {
        job: {
          id: "j2",
          namespace: EBOARD,
          content: "x".repeat(8000),
          channel_ids: [SPONSORS, ...ids],
        },
        snippets: Array.from({ length: 20 }, () => ({
          content: "y".repeat(5000),
          path: `${SPONSORS_PATH}/${"a".repeat(500)}`,
        })),
        feed_hint: "z".repeat(200),
        first_pass: true,
      },
      {
        env: liveEnv(EBOARD),
        poster: async (_u, body) => {
          captured = body as typeof captured;
          return { ok: true, status: 200 };
        },
      },
    );
    expect(captured?.job.content.length).toBe(4000);
    expect(captured?.job.channel_ids?.length).toBe(8);
    expect(captured?.snippets.length).toBe(12);
    expect(captured?.snippets.every((s) => s.content.length === 1200)).toBe(true);
    expect(captured?.snippets.every((s) => (s.path?.length ?? 0) <= 200)).toBe(true);
    expect(captured?.feed_hint?.length).toBe(40);
    expect((captured as { first_pass?: boolean }).first_pass).toBe(true);
  });

  test("redacts DISCORD_BOT_TOKEN from job content and never sends it as a header", async () => {
    const token = "discord-bot-token-secret-value";
    let captured = "";
    let capturedHeaders: Record<string, string> | undefined;
    await dispatchGrokJob(
      {
        job: { id: "j3", namespace: EBOARD, content: `please ignore ${token}` },
        snippets: [{ content: "ok", path: "/Users/sean/secret.md" }],
        first_pass: true,
      },
      {
        env: liveEnv(EBOARD, { DISCORD_BOT_TOKEN: token }),
        poster: async (_u, body, headers) => {
          captured = JSON.stringify(body);
          capturedHeaders = headers;
          return { ok: true, status: 200 };
        },
      },
    );
    expect(captured).not.toContain(token);
    expect(captured).toContain("[redacted]");
    expect(captured).not.toContain("/Users/sean");
    expect((JSON.parse(captured) as { snippets: unknown[] }).snippets).toEqual([]);
    expect(capturedHeaders?.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(capturedHeaders)).not.toContain(token);
  });
});

describe("dispatchGrokJob default fetch must not follow redirects", () => {
  const jobPack: GrokJobPayload = {
    job: {
      id: "j-redir",
      namespace: EBOARD,
      discord_channel_id: SPONSORS,
      content: "summarize the private planning notes",
    },
    snippets: [{ content: "secret-snippet-body", path: `${SPONSORS_PATH}/m1`, channelId: SPONSORS }],
    first_pass: true,
  };

  test("307 to 127.0.0.1 HEALTH_PORT /v1/jobs does not POST the job pack", async () => {
    const hopPosts: { method: string; url: string; body: string }[] = [];
    const hop = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        hopPosts.push({ method: req.method, url: req.url, body: await req.text() });
        return new Response("captured", { status: 200 });
      },
    });
    const first = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(null, {
          status: 307,
          headers: { Location: `http://127.0.0.1:${hop.port}/v1/jobs` },
        });
      },
    });
    try {
      const env: Env = {
        ...liveEnv(EBOARD, { GROK_DISPATCH_TIMEOUT_MS: "3000" }),
        GROK_BOT_WEBHOOK_URL: `http://127.0.0.1:${first.port}/grok`,
      };
      const r = await dispatchGrokJob(jobPack, { env });
      expect(r.dispatched).toBe(false);
      expect(r.skipped).toBe("refused-redirect");
      expect(hopPosts).toEqual([]);
    } finally {
      first.stop(true);
      hop.stop(true);
    }
  });

  test("307 to discord.com/api/webhooks does not POST the job pack", async () => {
    const first = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(null, {
          status: 307,
          headers: {
            Location: "https://discord.com/api/webhooks/123456789012345678/tok-tok-tok",
          },
        });
      },
    });
    try {
      const env: Env = {
        ...liveEnv(EBOARD, { GROK_DISPATCH_TIMEOUT_MS: "3000" }),
        GROK_BOT_WEBHOOK_URL: `http://127.0.0.1:${first.port}/grok`,
      };
      const r = await dispatchGrokJob(jobPack, { env });
      expect(r.dispatched).toBe(false);
      expect(r.skipped).toBe("refused-discord-incoming-webhook");
    } finally {
      first.stop(true);
    }
  });
});

describe("capGrokPayload", () => {
  test("drops Mini filesystem paths including body", () => {
    const capped = capGrokPayload(
      {
        job: { id: "j-path", namespace: EBOARD, content: "q" },
        snippets: [{ content: "ok", path: "/Users/sean/secret.md" }],
        first_pass: true,
      },
      envFor(),
    );
    expect(capped.snippets).toEqual([]);
  });

  test("drops pathless channel-scope snippets when channel_ids is set", () => {
    const capped = capGrokPayload(
      {
        job: {
          id: "j-nopath",
          namespace: EBOARD,
          scope: "channel",
          channel_ids: [SPONSORS],
          content: "q",
        },
        snippets: [
          { content: "unscoped body" },
          { content: "keep", path: `${SPONSORS_PATH}/m1`, channelId: SPONSORS },
        ],
        first_pass: true,
      },
      envFor(),
    );
    expect(capped.snippets.map((s) => s.content)).toEqual(["keep"]);
  });

  test("an eboard job is channel-scoped: only its own channel paths survive", () => {
    const capped = capGrokPayload(
      {
        job: {
          id: "j-scope",
          namespace: EBOARD,
          scope: "channel",
          channel_ids: [SPONSORS],
          content: "q",
        },
        snippets: [
          { content: "keep", path: `${SPONSORS_PATH}/m1`, channelId: SPONSORS },
          // A descendant workspace is visible, but not in channel_ids.
          { content: "drop-dev", path: `${DEV_CHAT_PATH}/m2`, channelId: DEV_CHAT },
          // The parent workspace is not visible at all.
          { content: "drop-lead", path: `${LEADERSHIP_TEAM_PATH}/m3` },
        ],
        feed_hint: `${DEV_CHAT_PATH}/nope`,
        first_pass: true,
      },
      envFor(),
    );
    expect(capped.job.scope).toBe("channel");
    expect(capped.job.channel_ids).toEqual([SPONSORS]);
    expect(capped.snippets.map((s) => s.content)).toEqual(["keep"]);
    expect(capped.snippets[0]?.path).toBe(`${SPONSORS_PATH}/m1`);
    expect(capped.feed_hint).toBeUndefined();
  });

  test("a leadership job is workspace-scoped: any path in the subtree survives", () => {
    const capped = capGrokPayload(
      {
        job: { id: "j-lead", namespace: LEADERSHIP, content: "q" },
        snippets: [
          { content: "lead", path: `${LEADERSHIP_TEAM_PATH}/m1` },
          { content: "eboard", path: `${SPONSORS_PATH}/m2` },
          { content: "mentorship", path: `${MENTORSHIP_CHAT_PATH}/m3` },
          { content: "not-a-workspace", path: "/general/111111111111111111/m4" },
        ],
        first_pass: true,
      },
      envFor(),
    );
    expect(capped.job.scope).toBe("workspace");
    expect(capped.job.channel_ids).toEqual([]);
    expect(capped.snippets.map((s) => s.content)).toEqual(["lead", "eboard", "mentorship"]);
  });

  test("an unknown workspace yields no snippets at all", () => {
    const capped = capGrokPayload(
      {
        job: { id: "j-unknown", namespace: "general", content: "q" },
        snippets: [{ content: "leak", path: `${SPONSORS_PATH}/m1`, channelId: SPONSORS }],
        first_pass: true,
      },
      envFor(),
    );
    expect(capped.snippets).toEqual([]);
  });
});
