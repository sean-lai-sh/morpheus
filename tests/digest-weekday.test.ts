import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetChannelsForTest, resetEnvForTest } from "../src/config.ts";
import { collectDigestHits } from "../src/digest/collect.ts";
import { hasDigestPosted } from "../src/digest/state.ts";
import {
  calendarDay,
  isMiniDigestEnabled,
  isWeekday,
  redactDigestText,
  runWeekdayDigest,
} from "../src/digest/weekday.ts";
import { indexFromRow } from "../src/context/store.ts";
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
  seed("d-sponsor", "5005", "Acme wants to sponsor Startup Week");
  seed("d-job", "3003", "Summer fellowship for NYU students");
  seed("d-talk", "2002", "Can Jane be a guest speaker in April?");
  seed("d-inbox", "4004", "The jobs board needs a volunteer");
  seed("d-echo", "1001", "Acme wants to sponsor Startup Week from #sponsors");
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
  test("classifies index hits and excludes feed-channel sources", () => {
    const hits = collectDigestHits({ sinceMs: WED - 36 * 3600_000, untilMs: WED });
    const byId = new Map(hits.map((h) => [h.id, h]));

    expect(byId.get("d-sponsor")?.channel).toBe("sponsors");
    expect(byId.get("d-job")?.channel).toBe("opportunities");
    expect(byId.get("d-talk")?.channel).toBe("speakers");
    expect(byId.get("d-inbox")?.channel).toBe("inbox");
    expect(byId.has("d-echo")).toBe(false);
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

  test("posts DIGEST buckets; unknown → inbox; unset/empty skip; no webhook URL in body", async () => {
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
      expect(p.body.content).toContain("INBOUND");
      expect(p.body.content).toContain("mini-index");
    }
  });

  test("no double-post same day+channel", async () => {
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
    seed("d-late-opp", "3003", "New internship posting for the spring cohort", WED + 86_400_000);
    const posted: string[] = [];
    const r = await runWeekdayDigest({
      nowMs: WED + 86_400_000,
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
});

describe("redactDigestText", () => {
  test("strips webhook URLs from hit text", () => {
    const leaked = `see ${HOOK.sponsors} please`;
    const out = redactDigestText(leaked, { DISCORD_WEBHOOK_SPONSORS: HOOK.sponsors });
    expect(out).not.toContain("webhooks");
    expect(out).not.toContain("sponsor-token");
  });
});
