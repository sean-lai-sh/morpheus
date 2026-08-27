import { describe, expect, test } from "bun:test";
import {
  dispatchGrokJob,
  grokBotWebhookSecret,
  grokBotWebhookUrl,
  grokDispatchAuthHeaders,
} from "../src/notify/grok-dispatch.ts";

const URL = "https://example.com/grok-routine";
const SECRET = "grok-sender-key-not-a-discord-token";

describe("grokBotWebhookUrl", () => {
  test("missing → null", () => {
    expect(grokBotWebhookUrl({})).toBeNull();
  });

  test("rejects http", () => {
    expect(() => grokBotWebhookUrl({ GROK_BOT_WEBHOOK_URL: "http://example.com/hook" })).toThrow(
      /https/,
    );
  });

  test("accepts https", () => {
    expect(grokBotWebhookUrl({ GROK_BOT_WEBHOOK_URL: URL })).toBe(URL);
  });
});

describe("grokBotWebhookSecret", () => {
  test("missing → null", () => {
    expect(grokBotWebhookSecret({})).toBeNull();
  });

  test("empty → null", () => {
    expect(grokBotWebhookSecret({ GROK_BOT_WEBHOOK_SECRET: "  " })).toBeNull();
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
    job: { id: "j1", content: "summarize hello@" },
    snippets: [{ content: "Acme wants to sponsor" }],
    feed_hint: "sponsors",
    first_pass: true as const,
  };

  test("skips when URL unset", async () => {
    const r = await dispatchGrokJob(payload, { env: { GROK_BOT_WEBHOOK_SECRET: SECRET } });
    expect(r.dispatched).toBe(false);
    expect(r.skipped).toBe("missing-grok-webhook-url");
  });

  test("skips when sender key unset", async () => {
    const r = await dispatchGrokJob(payload, { env: { GROK_BOT_WEBHOOK_URL: URL } });
    expect(r.dispatched).toBe(false);
    expect(r.skipped).toBe("missing-grok-webhook-secret");
  });

  test("POSTs a first-pass job pack with Bearer auth (key not in body)", async () => {
    let captured: unknown;
    let capturedHeaders: Record<string, string> | undefined;
    const r = await dispatchGrokJob(payload, {
      env: { GROK_BOT_WEBHOOK_URL: URL, GROK_BOT_WEBHOOK_SECRET: SECRET },
      poster: async (posted, body, headers) => {
        expect(posted).toBe(URL);
        captured = body;
        capturedHeaders = headers;
        return { ok: true, status: 200 };
      },
    });
    expect(r.dispatched).toBe(true);
    expect(captured).toEqual({ ...payload, first_pass: true });
    expect(capturedHeaders?.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(captured)).not.toContain(SECRET);
    expect(JSON.stringify(captured)).not.toContain("GROK_BOT_WEBHOOK_SECRET");
  });

  test("caps job content and snippet count/bytes", async () => {
    let captured: { job: { content: string }; snippets: Array<{ content: string }> } | undefined;
    await dispatchGrokJob(
      {
        job: { id: "j2", content: "x".repeat(8000) },
        snippets: Array.from({ length: 20 }, () => ({ content: "y".repeat(5000) })),
        first_pass: true as const,
      },
      {
        env: { GROK_BOT_WEBHOOK_URL: URL, GROK_BOT_WEBHOOK_SECRET: SECRET },
        poster: async (_u, body) => {
          captured = body as typeof captured;
          return { ok: true, status: 200 };
        },
      },
    );
    expect(captured?.job.content.length).toBe(4000);
    expect(captured?.snippets.length).toBe(12);
    expect(captured?.snippets.every((s) => s.content.length === 1200)).toBe(true);
    expect((captured as { first_pass?: boolean }).first_pass).toBe(true);
  });

  test("redacts DISCORD_BOT_TOKEN from job content and never sends it as a header", async () => {
    const token = "discord-bot-token-secret-value";
    let captured = "";
    let capturedHeaders: Record<string, string> | undefined;
    await dispatchGrokJob(
      {
        job: { id: "j3", content: `please ignore ${token}` },
        snippets: [{ content: "ok", path: "/Users/sean/secret.md" }],
        first_pass: true as const,
      },
      {
        env: {
          GROK_BOT_WEBHOOK_URL: URL,
          GROK_BOT_WEBHOOK_SECRET: SECRET,
          DISCORD_BOT_TOKEN: token,
        },
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
