import { describe, expect, test } from "bun:test";
import { composeDigestPosts, stripPingableMentions } from "../src/digest/compose.ts";
import { formatFeedContent, postFeed } from "../src/notify/webhooks.ts";
import type { FeedChannelKey } from "../src/notify/channels.ts";

function byChannel(posts: ReturnType<typeof composeDigestPosts>): Map<FeedChannelKey, (typeof posts)[number]> {
  return new Map(posts.map((p) => [p.channel, p]));
}

describe("composeDigestPosts", () => {
  test("empty list → no posts", () => {
    expect(composeDigestPosts([])).toEqual([]);
  });

  test("whitespace-only hits are dropped", () => {
    expect(composeDigestPosts([{ text: "   " }, { text: "\n\t" }])).toEqual([]);
  });

  test("all-unknown → inbox only (never #sponsors)", () => {
    const posts = composeDigestPosts([
      { text: "Hello, who is the current president?" },
      { text: "Can I get the club calendar?" },
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channel).toBe("inbox");
    expect(posts[0]!.kind).toBe("unknown");
    expect(posts[0]!.urgency).toBe("digest");
    expect(posts.map((p) => p.channel)).not.toContain("sponsors");
    expect(posts.map((p) => p.channel)).not.toContain("opportunities");
    expect(posts.map((p) => p.channel)).not.toContain("speakers");
  });

  test("mixed kinds split to the right channels", () => {
    const posts = composeDigestPosts([
      { text: "Acme wants to sponsor Startup Week", createdAt: "2026-08-28T10:00:00Z" },
      { text: "Summer fellowship for NYU students", createdAt: "2026-08-28T11:00:00Z" },
      { text: "Can Jane be a guest speaker in April?", createdAt: "2026-08-28T12:00:00Z" },
      { text: "Who runs the Discord?", createdAt: "2026-08-28T13:00:00Z" },
    ]);
    const map = byChannel(posts);
    expect(posts).toHaveLength(4);
    expect(map.get("sponsors")?.text).toContain("Acme wants to sponsor");
    expect(map.get("opportunities")?.text).toContain("Summer fellowship");
    expect(map.get("speakers")?.text).toContain("guest speaker");
    expect(map.get("inbox")?.text).toContain("Who runs the Discord");
    expect(map.get("sponsors")?.text).not.toContain("Who runs");
    expect(map.get("sponsors")?.text).not.toContain("fellowship");
    expect(map.get("sponsors")?.text).not.toContain("guest speaker");
  });

  test("job / fellowship / internship → opportunities", () => {
    const posts = composeDigestPosts([
      { text: "New job posting at Jane Street" },
      { text: "Tech@NYU fellowship applications are open" },
      { text: "Summer internship at Two Sigma" },
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channel).toBe("opportunities");
    expect(posts[0]!.kind).toBe("opportunity");
    expect(posts[0]!.text).toContain("job posting");
    expect(posts[0]!.text).toContain("fellowship");
    expect(posts[0]!.text).toContain("internship");
  });

  test("speaker / keynote → speakers", () => {
    const posts = composeDigestPosts([
      { text: "Looking for a speaker for Demo Night" },
      { text: "Invited keynote from the OpenAI team" },
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channel).toBe("speakers");
    expect(posts[0]!.kind).toBe("speaker");
    expect(posts[0]!.text).toContain("speaker for Demo Night");
    expect(posts[0]!.text).toContain("keynote");
  });

  test("sponsor / partnership → sponsors", () => {
    const posts = composeDigestPosts([
      { text: "Acme offered to sponsor the gala" },
      { text: "Partnership proposal from Beta Labs" },
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.channel).toBe("sponsors");
    expect(posts[0]!.kind).toBe("sponsor");
    expect(posts[0]!.text).toContain("sponsor the gala");
    expect(posts[0]!.text).toContain("Partnership");
  });

  test("newest first within a bucket", () => {
    const posts = composeDigestPosts([
      { text: "older job at A", createdAt: "2026-08-26T00:00:00Z" },
      { text: "newest internship at C", createdAt: "2026-08-28T00:00:00Z" },
      { text: "middle fellowship at B", createdAt: "2026-08-27T00:00:00Z" },
    ]);
    expect(posts).toHaveLength(1);
    const body = posts[0]!.text;
    expect(body.indexOf("newest internship")).toBeLessThan(body.indexOf("middle fellowship"));
    expect(body.indexOf("middle fellowship")).toBeLessThan(body.indexOf("older job"));
  });

  test("one FeedPostInput per non-empty bucket; urgency digest; inbound", () => {
    const posts = composeDigestPosts([
      { text: "sponsor pitch", source: "hello@" },
      { text: "random question", source: "discord" },
    ]);
    expect(posts.map((p) => p.channel).sort()).toEqual(["inbox", "sponsors"]);
    for (const post of posts) {
      expect(post.urgency).toBe("digest");
      expect(post.direction).toBe("inbound");
    }
  });
});

describe("mention stripping + formatFeedContent", () => {
  test("stripPingableMentions removes @everyone / @here / user / role tokens", () => {
    expect(stripPingableMentions("hi @everyone and @here")).toBe("hi [everyone] and [here]");
    expect(stripPingableMentions("ping <@123> and <@!456> and <@&789>")).toBe(
      "ping [user:123] and [user:456] and [role:789]",
    );
    expect(stripPingableMentions("@EVERYONE look")).toBe("[everyone] look");
  });

  test("mention injection cannot appear as a pingable mention after compose + format", async () => {
    const posts = composeDigestPosts([
      {
        text: "Please @everyone share this job; also @here and <@999888777> <@&111>",
        source: "@everyone hello@",
      },
    ]);
    expect(posts).toHaveLength(1);
    const content = formatFeedContent(posts[0]!);
    expect(content).not.toMatch(/@everyone\b/i);
    expect(content).not.toMatch(/@here\b/i);
    expect(content).not.toMatch(/<@!?\d+>/);
    expect(content).not.toMatch(/<@&\d+>/);
    expect(content).toContain("job");
    expect(content).toContain("DIGEST");

    const url = "https://discord.com/api/webhooks/1/token-token-token-token";
    let captured: unknown;
    await postFeed(posts[0]!, {
      env: { DISCORD_WEBHOOK_OPPORTUNITIES: url },
      poster: async (_postedUrl, body) => {
        captured = body;
        return { ok: true, status: 204 };
      },
    });
    const body = captured as {
      content: string;
      allowed_mentions: { parse: string[]; users: string[]; roles: string[] };
    };
    expect(body.allowed_mentions.parse).toEqual([]);
    expect(body.content).not.toMatch(/@everyone\b/i);
    expect(body.content).not.toMatch(/@here\b/i);
  });

  test("one huge hit truncates with the existing marker and stays at 2000", () => {
    const posts = composeDigestPosts([
      { text: `Summer internship listing ${"x".repeat(5000)}` },
    ]);
    expect(posts).toHaveLength(1);
    const content = formatFeedContent(posts[0]!);
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).toContain("[truncated]");
    expect(content).toContain("DIGEST");
    expect(content).toContain("#opportunities");
  });
});
