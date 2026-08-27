import { describe, expect, test } from "bun:test";
import { parseEnv, type Env } from "../src/config.ts";
import {
  capGrokPayload,
  dispatchGrokJob,
  grokBotWebhookSecret,
  grokBotWebhookUrl,
  grokDispatchAuthHeaders,
} from "../src/notify/grok-dispatch.ts";

const URL = "https://example.com/grok-routine";
const SECRET = "grok-sender-key-not-a-discord-token";
const GUILD = "123456789012345678";

function envFor(over: Record<string, string | undefined> = {}): Env {
  return parseEnv({
    DISCORD_BOT_TOKEN: "test-discord-token-value",
    DISCORD_GUILD_ID: GUILD,
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

describe("dispatchGrokJob", () => {
  const payload = {
    job: { id: "j1", namespace: "general" as const, content: "summarize hello@" },
    snippets: [{ content: "Acme wants to sponsor" }],
    feed_hint: "sponsors",
    first_pass: true as const,
  };

  test("skips when URL unset", async () => {
    const r = await dispatchGrokJob(payload, { env: envFor({ GROK_BOT_WEBHOOK_SECRET: SECRET }) });
    expect(r.dispatched).toBe(false);
    expect(r.skipped).toBe("missing-grok-webhook-url");
  });

  test("skips when sender key unset", async () => {
    const r = await dispatchGrokJob(payload, { env: envFor({ GROK_BOT_WEBHOOK_URL: URL }) });
    expect(r.dispatched).toBe(false);
    expect(r.skipped).toBe("missing-grok-webhook-secret");
  });

  test("dispatches leadership jobs by default; GROK_DISPATCH_LEADERSHIP=false still skips", async () => {
    let posted = 0;
    const lead = {
      ...payload,
      job: { ...payload.job, namespace: "leadership" as const, scope: "leadership" as const, channel_ids: [] },
    };
    const allowed = await dispatchGrokJob(lead, {
      env: envFor({ GROK_BOT_WEBHOOK_URL: URL, GROK_BOT_WEBHOOK_SECRET: SECRET }),
      poster: async () => {
        posted += 1;
        return { ok: true, status: 200 };
      },
    });
    expect(allowed.dispatched).toBe(true);
    expect(posted).toBe(1);

    const refused = await dispatchGrokJob(lead, {
      env: envFor({
        GROK_BOT_WEBHOOK_URL: URL,
        GROK_BOT_WEBHOOK_SECRET: SECRET,
        GROK_DISPATCH_LEADERSHIP: "false",
      }),
      poster: async () => {
        posted += 1;
        return { ok: true, status: 200 };
      },
    });
    expect(refused.dispatched).toBe(false);
    expect(refused.skipped).toBe("leadership-not-dispatchable");
    expect(posted).toBe(1);
  });

  test("POSTs a first-pass job pack with Bearer auth (key not in body or query)", async () => {
    let captured: unknown;
    let capturedHeaders: Record<string, string> | undefined;
    let postedUrl = "";
    const r = await dispatchGrokJob(payload, {
      env: envFor({ GROK_BOT_WEBHOOK_URL: URL, GROK_BOT_WEBHOOK_SECRET: SECRET }),
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
        namespace: "general",
        scope: "channel",
        channel_ids: [],
        content: "summarize hello@",
      },
      snippets: [{ content: "Acme wants to sponsor" }],
    });
    expect(capturedHeaders?.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(captured)).not.toContain(SECRET);
    expect(JSON.stringify(captured)).not.toContain("GROK_BOT_WEBHOOK_SECRET");
    expect(JSON.stringify(capturedHeaders)).not.toContain("test-discord-token-value");
  });

  test("caps job content, snippet bytes, path, feed_hint, and channel_ids", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `${"1".repeat(16)}${String(i).padStart(2, "0")}`);
    let captured: {
      job: { content: string; channel_ids?: string[] };
      snippets: Array<{ content: string; path?: string }>;
      feed_hint?: string;
    } | undefined;
    await dispatchGrokJob(
      {
        job: {
          id: "j2",
          namespace: "general",
          content: "x".repeat(8000),
          channel_ids: ids,
        },
        snippets: Array.from({ length: 20 }, () => ({
          content: "y".repeat(5000),
          path: `/general/${ids[0]}/${"a".repeat(500)}`,
        })),
        feed_hint: "z".repeat(200),
        first_pass: true as const,
      },
      {
        env: envFor({ GROK_BOT_WEBHOOK_URL: URL, GROK_BOT_WEBHOOK_SECRET: SECRET }),
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

  test("capGrokPayload drops Mini filesystem paths", () => {
    const capped = capGrokPayload(
      {
        job: { id: "j-path", namespace: "general", content: "q" },
        snippets: [{ content: "ok", path: "/Users/sean/secret.md" }],
        first_pass: true,
      },
      envFor(),
    );
    expect(capped.snippets[0]?.path).toBeUndefined();
  });

  test("capGrokPayload drops paths and feed_hint outside job.channel_ids", () => {
    const allowed = "111111111111111111";
    const other = "222222222222222222";
    const capped = capGrokPayload(
      {
        job: {
          id: "j-scope",
          namespace: "general",
          scope: "channel",
          channel_ids: [allowed],
          content: "q",
        },
        snippets: [
          { content: "keep", path: `/general/${allowed}/m1`, channelId: allowed },
          { content: "drop", path: `/general/${other}/m2`, channelId: other },
          { content: "drop-lead", path: `/leadership/${allowed}/m3` },
        ],
        feed_hint: `/general/${other}/nope`,
        first_pass: true,
      },
      envFor(),
    );
    expect(capped.job.channel_ids).toEqual([allowed]);
    expect(capped.snippets.map((s) => s.content)).toEqual(["keep"]);
    expect(capped.snippets[0]?.path).toBe(`/general/${allowed}/m1`);
    expect(capped.feed_hint).toBeUndefined();
  });

  test("capGrokPayload leadership scope keeps /leadership paths and empty channel_ids", () => {
    const capped = capGrokPayload(
      {
        job: {
          id: "j-lead",
          namespace: "leadership",
          scope: "leadership",
          channel_ids: [],
          content: "q",
        },
        snippets: [
          { content: "lead", path: "/leadership/222222222222222222/m1" },
          { content: "gen", path: "/general/111111111111111111/m2" },
        ],
        first_pass: true,
      },
      envFor(),
    );
    expect(capped.job.scope).toBe("leadership");
    expect(capped.job.channel_ids).toEqual([]);
    expect(capped.snippets.map((s) => s.content)).toEqual(["lead"]);
  });

  test("redacts DISCORD_BOT_TOKEN from job content and never sends it as a header", async () => {
    const token = "discord-bot-token-secret-value";
    let captured = "";
    let capturedHeaders: Record<string, string> | undefined;
    await dispatchGrokJob(
      {
        job: { id: "j3", namespace: "general", content: `please ignore ${token}` },
        snippets: [{ content: "ok", path: "/Users/sean/secret.md" }],
        first_pass: true as const,
      },
      {
        env: envFor({
          GROK_BOT_WEBHOOK_URL: URL,
          GROK_BOT_WEBHOOK_SECRET: SECRET,
          DISCORD_BOT_TOKEN: token,
        }),
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
    expect(capturedHeaders?.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(capturedHeaders)).not.toContain(token);
  });
});
