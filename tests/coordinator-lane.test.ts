import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv, type Env } from "../src/config.ts";
import {
  dispatchEnqueuedJob,
  laneForSource,
  tryEnqueueJob,
  type JobCandidate,
} from "../src/bot/enqueue.ts";
import { publishOutboxEvent } from "../src/coordinator/publisher.ts";
import { coordinatorJobMessageId } from "../src/coordinator/calendar-job.ts";
import { createScheduledMeeting } from "../src/storage/coordinator-meetings.ts";
import { getDb } from "../src/storage/db.ts";
import { getJobByDiscordMessageId, type JobRow, type JobStatus } from "../src/storage/jobs.ts";
import type { HttpsPoster } from "../src/notify/grok-dispatch.ts";
import type { ChannelResolver } from "../src/context/namespace.ts";
import { withTempDb } from "./helpers.ts";
import { EBOARD, SPONSORS, withWorkspaceConfig } from "./jobs-fixture.ts";

const GROK_URL = "https://example.com/grok-routine";
const GROK_SECRET = "grok-sender-key-not-a-discord-token";
const SDK_URL = "http://127.0.0.1:8790";
const SDK_SECRET = "sdk-sibling-secret-not-a-discord-token";
const ROLE = "role-eboard";

const db = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;
beforeAll(() => {
  cfg = withWorkspaceConfig();
  getDb();
});
afterAll(() => {
  cfg.cleanup();
  db.cleanup();
});

const resolveChannel: ChannelResolver = (id) =>
  id === SPONSORS
    ? { workspace: EBOARD, id: SPONSORS, name: "sponsors", category: "eboard-teams" }
    : undefined;

/** Both workers fully configured, so only the lane/flag decides the route. */
function bothConfigured(over: Record<string, string | undefined> = {}): Env {
  return parseEnv({
    DISCORD_BOT_TOKEN: "test-discord-token-value",
    DISCORD_GUILD_ID: "123456789012345678",
    GROK_BOT_WEBHOOK_URL: GROK_URL,
    GROK_BOT_WEBHOOK_SECRET: GROK_SECRET,
    GROK_DISPATCH_WORKSPACES: EBOARD,
    CURSOR_SDK_WEBHOOK_URL: SDK_URL,
    CURSOR_SDK_WEBHOOK_SECRET: SDK_SECRET,
    ...over,
  });
}

function countingPoster(): { poster: HttpsPoster; posts: Array<{ url: string }> } {
  const posts: Array<{ url: string }> = [];
  return {
    posts,
    poster: async (url) => {
      posts.push({ url });
      return { ok: true, status: 200 };
    },
  };
}

function jobRow(id: string, over: Partial<JobRow> = {}): JobRow {
  return {
    id,
    discord_message_id: `msg-${id}`,
    discord_channel_id: SPONSORS,
    discord_thread_id: null,
    author_id: "42",
    namespace: EBOARD,
    scope: "channel",
    channel_ids: [SPONSORS],
    content: "sync the calendar",
    status: "queued",
    claimed_by: null,
    claimed_at: null,
    result_discord_message_id: null,
    reply_text: null,
    completion_key: null,
    github_issue_url: null,
    error: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function laneOf(discordMessageId: string): string | undefined {
  const row = getDb()
    .query<{ lane: string }, [string]>(`SELECT lane FROM jobs WHERE discord_message_id = ?`)
    .get(discordMessageId);
  return row?.lane;
}

function seedCandidate(discordMessageId: string): JobCandidate {
  return {
    discordMessageId,
    discordChannelId: SPONSORS,
    discordThreadId: null,
    parentChannelId: null,
    authorId: "seed-author",
    authorIsBot: false,
    authorRoleIds: [ROLE],
    content: '{"kind":"roster.seed","members":[]}',
    mentionedBot: true,
    replyToBot: false,
    source: "coordinator",
  };
}

const policy = {
  triggerRoleIds: new Set([ROLE]),
  maxOutstanding: 50,
  maxPerHour: 50,
  resolveChannel,
};

describe("dispatchEnqueuedJob refuses non-queued rows", () => {
  // The outbox sweeper re-dispatches every 60s off a stored message id. A
  // cancelled/completed row can never be claimed, so a 2xx there is a silent
  // loss plus an endless retry loop.
  for (const status of ["cancelled", "completed", "failed", "claimed"] as JobStatus[]) {
    test(`${status} row is never POSTed`, async () => {
      const grok = countingPoster();
      const sdk = countingPoster();
      const result = await dispatchEnqueuedJob(jobRow(`stale-${status}`, { status }), {
        lane: "background",
        env: bothConfigured(),
        poster: grok.poster,
        sdkPoster: sdk.poster,
      });
      expect(result.dispatched).toBe(false);
      expect(grok.posts.length).toBe(0);
      expect(sdk.posts.length).toBe(0);
    });
  }

  test("a queued row still dispatches", async () => {
    const grok = countingPoster();
    const result = await dispatchEnqueuedJob(jobRow("fresh-queued"), {
      lane: "background",
      env: bothConfigured(),
      poster: grok.poster,
    });
    expect(result.dispatched).toBe(true);
    expect(grok.posts.length).toBe(1);
  });
});

describe("/meet seed runs in the background (Grok) lane", () => {
  test("laneForSource maps coordinator work to background", () => {
    expect(laneForSource("coordinator")).toBe("background");
  });

  test("the /meet seed call site enqueues as coordinator, not slash", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/bot/coordinator.ts"), "utf8");
    const seedBlock = src.slice(src.indexOf('if (sub === "seed")'), src.indexOf('if (sub === "cancel")'));
    expect(seedBlock).toContain('source: "coordinator"');
    expect(seedBlock).not.toContain('source: "slash"');
  });

  test("a seed job is stored in the background lane and posted to Grok despite CURSOR_SDK_DISPATCH", async () => {
    const grok = countingPoster();
    const sdk = countingPoster();
    const r = await tryEnqueueJob(seedCandidate("seed-lane-1"), {
      ...policy,
      env: bothConfigured({ CURSOR_SDK_DISPATCH: "true" }),
      poster: grok.poster,
      sdkPoster: sdk.poster,
    });
    expect(r.skipped).toBeUndefined();
    expect(laneOf("seed-lane-1")).toBe("background");
    expect(r.dispatched).toBe(true);
    expect(grok.posts.map((p) => p.url)).toEqual([GROK_URL]);
    expect(sdk.posts.length).toBe(0);
  });

  test("seed jobs do not consume the author's interactive /ask cap", async () => {
    // maxOutstanding 1: the seed above would block /ask if caps were shared.
    await tryEnqueueJob(seedCandidate("seed-cap-1"), { ...policy, maxOutstanding: 1, dispatch: false });
    const ask = await tryEnqueueJob(
      { ...seedCandidate("seed-cap-ask"), source: "slash", mentionedBot: false },
      { ...policy, maxOutstanding: 1, dispatch: false },
    );
    expect(ask.skipped).toBeUndefined();
    expect(laneOf("seed-cap-ask")).toBe("interactive");
  });
});

describe("calendar outbox handoff runs in the background (Grok) lane", () => {
  function scheduledMeeting(title: string) {
    return createScheduledMeeting({
      createdByUserId: "creator-lane",
      title,
      startsAt: Date.now() + 3_600_000,
      durationMinutes: 30,
      channelId: SPONSORS,
      participants: [{ userId: "u-1", displayName: "Sam" }],
    });
  }

  test("the enqueued calendar job carries lane=background", async () => {
    const { outboxEvents } = scheduledMeeting("Calendar lane");
    const event = outboxEvents[0]!;
    // Real enqueue path (not injected) so the stored row is what we assert on;
    // dispatch is stubbed to keep the webhook out of the test.
    const outcome = await publishOutboxEvent(event, { dispatchCalendar: async () => true });
    expect(outcome.status).toBe("accepted");
    expect(laneOf(coordinatorJobMessageId(event.id))).toBe("background");
  });

  test("re-dispatching that row with CURSOR_SDK_DISPATCH on still goes to Grok", async () => {
    const { outboxEvents } = scheduledMeeting("Calendar route");
    const event = outboxEvents[0]!;
    await publishOutboxEvent(event, { dispatchCalendar: async () => true });
    const job = getJobByDiscordMessageId(coordinatorJobMessageId(event.id));
    expect(job).not.toBeNull();

    const grok = countingPoster();
    const sdk = countingPoster();
    // No `lane` option — exactly how the sweeper's retry closure used to call
    // this. The row's persisted lane must keep it away from the SDK sibling.
    const result = await dispatchEnqueuedJob(job!, {
      env: bothConfigured({ CURSOR_SDK_DISPATCH: "true" }),
      poster: grok.poster,
      sdkPoster: sdk.poster,
    });
    expect(result.dispatched).toBe(true);
    expect(grok.posts.map((p) => p.url)).toEqual([GROK_URL]);
    expect(sdk.posts.length).toBe(0);
  });
});
