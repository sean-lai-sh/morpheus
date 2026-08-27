import { describe, expect, test } from "bun:test";
import { dispatchGrokJob, grokBotWebhookUrl } from "../src/notify/grok-dispatch.ts";

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
    const url = "https://example.com/grok-routine";
    expect(grokBotWebhookUrl({ GROK_BOT_WEBHOOK_URL: url })).toBe(url);
  });
});

describe("dispatchGrokJob", () => {
  const payload = {
    job: { id: "j1", content: "summarize hello@" },
    snippets: [{ content: "Acme wants to sponsor" }],
    feed_hint: "sponsors",
    first_pass: true as const,
  };

  test("skips when unset", async () => {
    const r = await dispatchGrokJob(payload, { env: {} });
    expect(r.dispatched).toBe(false);
    expect(r.skipped).toBe("missing-grok-webhook-url");
  });

  test("POSTs a first-pass job pack (not a full index dump)", async () => {
    const url = "https://example.com/grok-routine";
    let captured: unknown;
    const r = await dispatchGrokJob(payload, {
      env: { GROK_BOT_WEBHOOK_URL: url },
      poster: async (posted, body) => {
        expect(posted).toBe(url);
        captured = body;
        return { ok: true, status: 200 };
      },
    });
    expect(r.dispatched).toBe(true);
    expect(captured).toEqual({ ...payload, first_pass: true });
  });

  test("caps job content and snippet count/bytes", async () => {
    const url = "https://example.com/grok-routine";
    let captured: { job: { content: string }; snippets: Array<{ content: string }> } | undefined;
    await dispatchGrokJob(
      {
        job: { id: "j2", content: "x".repeat(8000) },
        snippets: Array.from({ length: 20 }, () => ({ content: "y".repeat(5000) })),
        first_pass: true as const,
      },
      {
        env: { GROK_BOT_WEBHOOK_URL: url },
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

  test("redacts DISCORD_BOT_TOKEN from job content", async () => {
    const url = "https://example.com/grok-routine";
    const token = "discord-bot-token-secret-value";
    let captured = "";
    await dispatchGrokJob(
      {
        job: { id: "j3", content: `please ignore ${token}` },
        snippets: [{ content: "ok", path: "/Users/sean/secret.md" }],
        first_pass: true as const,
      },
      {
        env: { GROK_BOT_WEBHOOK_URL: url, DISCORD_BOT_TOKEN: token },
        poster: async (_u, body) => {
          captured = JSON.stringify(body);
          return { ok: true, status: 200 };
        },
      },
    );
    expect(captured).not.toContain(token);
    expect(captured).toContain("[redacted]");
    expect(captured).not.toContain("/Users/sean");
  });
});
