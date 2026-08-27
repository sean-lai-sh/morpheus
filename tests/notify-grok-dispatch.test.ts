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
  };

  test("skips when unset", async () => {
    const r = await dispatchGrokJob(payload, { env: {} });
    expect(r.dispatched).toBe(false);
    expect(r.skipped).toBe("missing-grok-webhook-url");
  });

  test("POSTs job + snippets to the routine URL", async () => {
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
    expect(captured).toEqual(payload);
  });

  test("caps job content and snippet count/bytes", async () => {
    const url = "https://example.com/grok-routine";
    let captured: { job: { content: string }; snippets: Array<{ content: string }> } | undefined;
    await dispatchGrokJob(
      {
        job: { id: "j2", content: "x".repeat(8000) },
        snippets: Array.from({ length: 20 }, () => ({ content: "y".repeat(5000) })),
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
  });
});
