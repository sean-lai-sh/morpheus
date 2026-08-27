import { describe, expect, test } from "bun:test";
import { formatFeedContent, postFeed, webhookUrlFor } from "../src/notify/webhooks.ts";

describe("webhookUrlFor", () => {
  test("empty env → null (skip post)", () => {
    expect(webhookUrlFor("sponsors", {})).toBeNull();
  });

  test("rejects non-discord URLs", () => {
    expect(() =>
      webhookUrlFor("sponsors", { DISCORD_WEBHOOK_SPONSORS: "https://example.com/hook" }),
    ).toThrow(/not a Discord incoming webhook/);
  });

  test("accepts discord.com webhook URL", () => {
    const url = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx";
    expect(webhookUrlFor("sponsors", { DISCORD_WEBHOOK_SPONSORS: url })).toBe(url);
  });

  test("ptb./canary. Discord hosts are recognized as Discord webhooks", () => {
    for (const host of ["ptb.discord.com", "canary.discord.com", "ptb.discordapp.com"]) {
      const url = `https://${host}/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx`;
      expect(webhookUrlFor("sponsors", { DISCORD_WEBHOOK_SPONSORS: url })).toBe(url);
    }
    // The documented versioned execute path is a Discord webhook too.
    const versioned = "https://discord.com/api/v10/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx";
    expect(webhookUrlFor("sponsors", { DISCORD_WEBHOOK_SPONSORS: versioned })).toBe(versioned);
    // A lookalike host is NOT Discord.
    expect(() =>
      webhookUrlFor("sponsors", {
        DISCORD_WEBHOOK_SPONSORS: "https://evildiscord.com/api/webhooks/1/tok",
      }),
    ).toThrow(/not a Discord incoming webhook/);
  });
});

describe("formatFeedContent", () => {
  test("labels INBOUND vs OUTBOUND and does not include webhook URLs", () => {
    const content = formatFeedContent({
      channel: "sponsors",
      direction: "inbound",
      kind: "sponsor",
      text: "Acme pitched $5k",
      source: "hello@",
      urgency: "urgent",
    });
    expect(content).toContain("INBOUND");
    expect(content).toContain("URGENT");
    expect(content).toContain("Acme pitched");
    expect(content).not.toMatch(/api\/webhooks/);
  });

  test("truncates to Discord 2000 cap", () => {
    const content = formatFeedContent({
      channel: "inbox",
      direction: "outbound",
      kind: "unknown",
      text: "x".repeat(5000),
    });
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).toContain("[truncated]");
  });
});

describe("postFeed", () => {
  test("skips when URL missing", async () => {
    const r = await postFeed(
      { channel: "speakers", direction: "inbound", kind: "speaker", text: "hi" },
      { env: {} },
    );
    expect(r.posted).toBe(false);
    expect(r.skipped).toBe("missing-webhook-url");
  });

  test("POSTs JSON with allowed_mentions parse none", async () => {
    const url = "https://discord.com/api/webhooks/1/token-token-token-token";
    let captured: unknown;
    const r = await postFeed(
      {
        channel: "opportunities",
        direction: "outbound",
        kind: "job",
        text: "We might forward the Jane Street intern post",
      },
      {
        env: { DISCORD_WEBHOOK_OPPORTUNITIES: url },
        poster: async (postedUrl, body) => {
          expect(postedUrl).toBe(url);
          captured = body;
          return { ok: true, status: 204 };
        },
      },
    );
    expect(r.posted).toBe(true);
    const body = captured as {
      content: string;
      allowed_mentions: { parse: string[]; users: string[]; roles: string[] };
    };
    expect(body.allowed_mentions.parse).toEqual([]);
    expect(body.allowed_mentions.users).toEqual([]);
    expect(body.allowed_mentions.roles).toEqual([]);
    expect(body.content).toContain("OUTBOUND");
  });
});
