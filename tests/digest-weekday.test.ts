import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resetChannelsForTest, resetEnvForTest } from "../src/config.ts";
import { collectDigestHits, digestScopes } from "../src/digest/collect.ts";
import { clearDigestPostsForTest, hasDigestPosted, reserveDigestPost } from "../src/digest/state.ts";
import {
  calendarDay,
  isMiniDigestEnabled,
  isWeekday,
  redactDigestText,
  redactDiscordWebhookUrls,
  runWeekdayDigest,
} from "../src/digest/weekday.ts";
import { indexFromRow } from "../src/context/store.ts";
import { isDiscordWebhookUrl } from "../src/notify/webhooks.ts";
import { getMessage, upsertMessage } from "../src/storage/messages.ts";
import {
  withTempCwd,
  withTempDb,
  writeCanonicalChannels,
} from "./helpers.ts";

const cwd = withTempCwd();
writeCanonicalChannels();
const db = withTempDb();

/** Wednesday 2026-08-26 15:00 UTC = 11:00 America/New_York. */
const WED = Date.parse("2026-08-26T15:00:00Z");
/** Saturday 2026-08-29 15:00 UTC. */
const SAT = Date.parse("2026-08-29T15:00:00Z");
/** Thursday 2026-08-27 15:00 UTC — isolated day for unset-webhook. */
const THU = Date.parse("2026-08-27T15:00:00Z");
/** Friday 2026-08-28 15:00 UTC — isolated day for thrown-poster. */
const FRI = Date.parse("2026-08-28T15:00:00Z");

const HOOK = {
  sponsors: "https://discord.com/api/webhooks/111111111111111111/sponsor-token-token-token",
  opportunities: "https://discord.com/api/webhooks/222222222222222222/opp-token-token-token-token",
  speakers: "https://discord.com/api/webhooks/333333333333333333/speaker-token-token-token",
  inbox: "https://discord.com/api/webhooks/444444444444444444/inbox-token-token-token-token",
} as const;

const ALL_HOOKS = {
  DISCORD_WEBHOOK_SPONSORS: HOOK.sponsors,
  DISCORD_WEBHOOK_OPPORTUNITIES: HOOK.opportunities,
  DISCORD_WEBHOOK_SPEAKERS: HOOK.speakers,
  DISCORD_WEBHOOK_INBOX: HOOK.inbox,
};

const ENCODED_WEBHOOKS = [
  "https://discord.com/api/%77ebhooks/123456789012345678/secret-token-token",
  "https://discord.com/api/webhooks%2F123456789012345678%2Fsecret-token-token",
] as const;

function seed(id: string, channelId: string, content: string, createdAt = WED - 3_600_000): void {
  upsertMessage({
    id,
    channelId,
    authorId: "u1",
    authorName: "alice",
    content,
    createdAt,
  });
  indexFromRow(getMessage(id)!);
}

beforeAll(() => {
  resetChannelsForTest();
  resetEnvForTest();
  seed("d-sponsor", "5005", "Acme wants to sponsor Startup Week — cc @everyone <@123>");
  seed("d-job", "3003", "Summer fellowship for NYU students");
  seed("d-talk", "5005", "Can Jane be a guest speaker in April?");
  seed("d-inbox", "4004", "The jobs board needs a volunteer");
  seed("d-echo", "1001", "Acme wants to sponsor Startup Week from #sponsors");
  seed("d-lead-talk", "2002", "Leadership-only guest speaker for the board retreat zebra-lead-digest");
});

beforeEach(() => {
  clearDigestPostsForTest();
});

afterAll(() => {
  resetChannelsForTest();
  db.cleanup();
  cwd.cleanup();
});

describe("isMiniDigestEnabled", () => {
  test("default OFF", () => {
    expect(isMiniDigestEnabled({})).toBe(false);
    expect(isMiniDigestEnabled({ MINI_DIGEST_ENABLED: "" })).toBe(false);
    expect(isMiniDigestEnabled({ MINI_DIGEST_ENABLED: "false" })).toBe(false);
  });

  test("true/1/yes enable", () => {
    expect(isMiniDigestEnabled({ MINI_DIGEST_ENABLED: "true" })).toBe(true);
    expect(isMiniDigestEnabled({ MINI_DIGEST_ENABLED: "1" })).toBe(true);
    expect(isMiniDigestEnabled({ MINI_DIGEST_ENABLED: "yes" })).toBe(true);
  });
});

describe("calendar helpers", () => {
  test("weekday vs weekend in America/New_York", () => {
    expect(isWeekday(WED)).toBe(true);
    expect(isWeekday(SAT)).toBe(false);
    expect(calendarDay(WED)).toBe("2026-08-26");
    expect(calendarDay(SAT)).toBe("2026-08-29");
  });
});

describe("collectDigestHits", () => {
  test("classifies eboard-visible index hits and excludes feed-channel sources", () => {
    const hits = collectDigestHits({ sinceMs: WED - 36 * 3600_000, untilMs: WED });
    const byId = new Map(hits.map((h) => [h.id, h]));

    expect(digestScopes().map((s) => s.root)).toEqual(["eboard"]);
    expect(byId.get("d-sponsor")?.channel).toBe("sponsors");
    expect(byId.get("d-job")?.channel).toBe("opportunities");
    expect(byId.get("d-talk")?.channel).toBe("speakers");
    expect(byId.get("d-inbox")?.channel).toBe("inbox");
    expect(byId.has("d-echo")).toBe(false);
  });

  test("leadership-only hits never leave that workspace", () => {
    const hits = collectDigestHits({ sinceMs: WED - 36 * 3600_000, untilMs: WED });
    expect(hits.some((h) => h.id === "d-lead-talk")).toBe(false);
    expect(hits.some((h) => h.text.includes("zebra-lead-digest"))).toBe(false);
    expect(hits.some((h) => h.sourceChannelId === "2002")).toBe(false);
  });
});

describe("runWeekdayDigest", () => {
  test("disabled by default — no posts", async () => {
    const calls: unknown[] = [];
    const r = await runWeekdayDigest({
      nowMs: WED,
      env: { ...ALL_HOOKS },
      poster: async (_url, body) => {
        calls.push(body);
        return { ok: true, status: 204 };
      },
    });
    expect(r.ran).toBe(false);
    expect(r.skipped).toBe("disabled");
    expect(calls).toHaveLength(0);
  });

  test("weekend skip unless --force", async () => {
    const calls: unknown[] = [];
    const poster = async () => {
      calls.push(1);
      return { ok: true, status: 204 };
    };
    const skipped = await runWeekdayDigest({
      nowMs: SAT,
      env: { MINI_DIGEST_ENABLED: "true", ...ALL_HOOKS },
      poster,
    });
    expect(skipped.ran).toBe(false);
    expect(skipped.skipped).toBe("weekend");
    expect(calls).toHaveLength(0);

    const forced = await runWeekdayDigest({
      nowMs: SAT,
      force: true,
      lookbackMs: 5 * 86_400_000,
      env: { MINI_DIGEST_ENABLED: "true", ...ALL_HOOKS },
      poster,
    });
    expect(forced.ran).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  test("posts DIGEST buckets; unknown → inbox; leadership never on webhooks; mentions stripped", async () => {
    const posted: { url: string; body: { content: string; allowed_mentions: { parse: string[] } } }[] = [];
    const r = await runWeekdayDigest({
      nowMs: WED,
      env: {
        MINI_DIGEST_ENABLED: "true",
        DISCORD_WEBHOOK_SPONSORS: HOOK.sponsors,
        DISCORD_WEBHOOK_OPPORTUNITIES: HOOK.opportunities,
        DISCORD_WEBHOOK_SPEAKERS: HOOK.speakers,
        DISCORD_WEBHOOK_INBOX: HOOK.inbox,
      },
      poster: async (url, body) => {
        posted.push({ url, body: body as (typeof posted)[number]["body"] });
        return { ok: true, status: 204 };
      },
    });

    expect(r.ran).toBe(true);
    expect(r.day).toBe("2026-08-26");
    expect(r.channels.sponsors.posted).toBe(true);
    expect(r.channels.opportunities.posted).toBe(true);
    expect(r.channels.speakers.posted).toBe(true);
    expect(r.channels.inbox.posted).toBe(true);

    const byUrl = new Map(posted.map((p) => [p.url, p.body]));
    expect(byUrl.get(HOOK.sponsors)!.content).toContain("DIGEST");
    expect(byUrl.get(HOOK.sponsors)!.content).toContain("sponsor");
    expect(byUrl.get(HOOK.opportunities)!.content).toContain("fellowship");
    expect(byUrl.get(HOOK.speakers)!.content).toContain("guest speaker");
    expect(byUrl.get(HOOK.inbox)!.content).toContain("jobs board");
    expect(byUrl.get(HOOK.inbox)!.allowed_mentions.parse).toEqual([]);

    for (const p of posted) {
      expect(p.body.content).not.toMatch(/api\/webhooks/);
      expect(p.body.content).not.toContain("sponsor-token");
      expect(p.body.content).not.toContain("zebra-lead-digest");
      expect(p.body.content).not.toContain("Leadership-only");
      expect(p.body.content).not.toMatch(/@everyone\b/i);
      expect(p.body.content).not.toMatch(/<@!?\d+>/);
      expect(p.body.content).toContain("INBOUND");
      expect(p.body.content).toContain("mini-index");
    }
  });

  test("no double-post same day+channel (own reservation, not prior test)", async () => {
    reserveDigestPost("2026-08-26", "sponsors", WED);
    reserveDigestPost("2026-08-26", "opportunities", WED);
    reserveDigestPost("2026-08-26", "speakers", WED);
    reserveDigestPost("2026-08-26", "inbox", WED);
    let n = 0;
    const r = await runWeekdayDigest({
      nowMs: WED,
      env: { MINI_DIGEST_ENABLED: "true", ...ALL_HOOKS },
      poster: async () => {
        n++;
        return { ok: true, status: 204 };
      },
    });
    expect(r.ran).toBe(true);
    expect(n).toBe(0);
    expect(r.channels.sponsors.skipped).toBe("already-posted");
    expect(hasDigestPosted("2026-08-26", "sponsors")).toBe(true);
  });

  test("empty buckets skip without posting", async () => {
    const calls: unknown[] = [];
    const r = await runWeekdayDigest({
      nowMs: WED,
      lookbackMs: 1,
      env: { MINI_DIGEST_ENABLED: "true", ...ALL_HOOKS },
      poster: async () => {
        calls.push(1);
        return { ok: true, status: 204 };
      },
    });
    expect(r.ran).toBe(true);
    expect(r.channels.sponsors.skipped).toBe("empty");
    expect(r.channels.opportunities.skipped).toBe("empty");
    expect(r.channels.speakers.skipped).toBe("empty");
    expect(r.channels.inbox.skipped).toBe("empty");
    expect(calls).toHaveLength(0);
  });

  test("unset webhook skips that channel only", async () => {
    seed("d-late-opp", "3003", "New internship posting for the spring cohort", THU - 3_600_000);
    const posted: string[] = [];
    const r = await runWeekdayDigest({
      nowMs: THU,
      env: {
        MINI_DIGEST_ENABLED: "true",
        DISCORD_WEBHOOK_OPPORTUNITIES: HOOK.opportunities,
      },
      poster: async (url) => {
        posted.push(url);
        return { ok: true, status: 204 };
      },
    });
    expect(r.ran).toBe(true);
    expect(r.day).toBe("2026-08-27");
    expect(r.channels.opportunities.posted).toBe(true);
    expect(r.channels.sponsors.skipped).toBe("missing-webhook-url");
    expect(r.channels.speakers.skipped).toBe("missing-webhook-url");
    expect(r.channels.inbox.skipped).toBe("missing-webhook-url");
    expect(posted).toEqual([HOOK.opportunities]);
  });

  test("thrown poster releases the reservation so the same day can retry", async () => {
    seed("d-fri-job", "3003", "Friday fellowship reminder for NYU students", FRI - 3_600_000);
    const r1 = await runWeekdayDigest({
      nowMs: FRI,
      env: { MINI_DIGEST_ENABLED: "true", DISCORD_WEBHOOK_OPPORTUNITIES: HOOK.opportunities },
      poster: async () => {
        throw new Error("redirect: error");
      },
    });
    expect(r1.ran).toBe(true);
    expect(r1.channels.opportunities.posted).toBe(false);
    expect(r1.channels.opportunities.skipped).toBe("post-error");
    expect(hasDigestPosted("2026-08-28", "opportunities")).toBe(false);

    let n = 0;
    const r2 = await runWeekdayDigest({
      nowMs: FRI,
      env: { MINI_DIGEST_ENABLED: "true", DISCORD_WEBHOOK_OPPORTUNITIES: HOOK.opportunities },
      poster: async () => {
        n++;
        return { ok: true, status: 204 };
      },
    });
    expect(r2.channels.opportunities.posted).toBe(true);
    expect(n).toBe(1);
    expect(hasDigestPosted("2026-08-28", "opportunities")).toBe(true);
  });
});

describe("redactDigestText / redactDiscordWebhookUrls", () => {
  test("strips configured webhook URLs from hit text", () => {
    const leaked = `see ${HOOK.sponsors} please`;
    const out = redactDigestText(leaked, { DISCORD_WEBHOOK_SPONSORS: HOOK.sponsors });
    expect(out).not.toContain("webhooks");
    expect(out).not.toContain("sponsor-token");
  });

  test("encoded Discord webhook paths are redacted via isDiscordWebhookUrl", () => {
    for (const url of ENCODED_WEBHOOKS) {
      expect(isDiscordWebhookUrl(url)).toBe(true);
      const out = redactDiscordWebhookUrls(`leak ${url} here`);
      expect(out).toContain("[redacted-webhook]");
      expect(out).not.toContain("secret-token");
      expect(out).not.toContain("%77ebhooks");
      expect(out).not.toContain("webhooks%2F");
    }
  });
});
