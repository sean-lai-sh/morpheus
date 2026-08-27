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

  test("default-refuses leadership jobs unless GROK_DISPATCH_LEADERSHIP is on", async () => {
    let posted = 0;
    const lead = {
      ...payload,
      job: { ...payload.job, namespace: "leadership" as const },
    };
    const refused = await dispatchGrokJob(lead, {
      env: envFor({ GROK_BOT_WEBHOOK_URL: URL, GROK_BOT_WEBHOOK_SECRET: SECRET }),
      poster: async () => {
        posted += 1;
        return { ok: true, status: 200 };
      },
    });
    expect(refused.dispatched).toBe(false);
    expect(refused.skipped).toBe("leadership-not-dispatchable");
    expect(posted).toBe(0);

    const allowed = await dispatchGrokJob(lead, {
      env: envFor({
        GROK_BOT_WEBHOOK_URL: URL,
        GROK_BOT_WEBHOOK_SECRET: SECRET,
        GROK_DISPATCH_LEADERSHIP: "true",
      }),
      poster: async () => {
        posted += 1;
        return { ok: true, status: 200 };
      },
    });
    expect(allowed.dispatched).toBe(true);
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
    expect(captured).toEqual({ ...payload, first_pass: true });
    expect(capturedHeaders?.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(captured)).not.toContain(SECRET);
    expect(JSON.stringify(captured)).not.toContain("GROK_BOT_WEBHOOK_SECRET");
    expect(JSON.stringify(capturedHeaders)).not.toContain("test-discord-token-value");
  });

  test("caps job content, snippet bytes, path, and feed_hint", async () => {
    let captured: {
      job: { content: string };
      snippets: Array<{ content: string; path?: string }>;
      feed_hint?: string;
    } | undefined;
    await dispatchGrokJob(
      {
        job: { id: "j2", namespace: "general", content: "x".repeat(8000) },
        snippets: Array.from({ length: 20 }, () => ({
          content: "y".repeat(5000),
          path: `/general/${"a".repeat(500)}`,
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
