import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import {
  DEV_CHAT,
  EBOARD,
  GENERAL_CHAT,
  LEADERSHIP,
  LEADERSHIP_TEAM,
  PROGRAMS_DEV,
  SPONSORS,
  withWorkspaceConfig,
} from "./jobs-fixture.ts";
import { scopeFor } from "../src/context/namespace.ts";
import { parseIndexPath } from "../src/context/paths.ts";
import type { Scope } from "../src/context/types.ts";
import { getDb } from "../src/storage/db.ts";
import { upsertMessage } from "../src/storage/messages.ts";
import {
  claimJob,
  countOutstandingJobs,
  enqueueJob,
  failJob,
  firstPassSnippets,
  getJob,
  getJobByDiscordMessageId,
  listQueued,
  markJobCompleted,
  markJobSendError,
  prepareComplete,
  recordJobDiscordSend,
  requeueExpiredClaims,
} from "../src/storage/jobs.ts";

const t = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;

beforeAll(() => {
  cfg = withWorkspaceConfig();
});
afterAll(() => {
  cfg.cleanup();
  t.cleanup();
});

function scope(root: string): Scope {
  const s = scopeFor(root);
  if (!s) throw new Error(`no scope for ${root}`);
  return s;
}

function enqueue(id: string, author = "u1", ns = EBOARD, channelId = SPONSORS) {
  return enqueueJob({
    discordMessageId: id,
    discordChannelId: channelId,
    discordThreadId: null,
    authorId: author,
    namespace: ns,
    content: `<@bot> ${id}`,
  });
}

describe("storage/jobs enqueue", () => {
  test("inserts a queued job", () => {
    const { job, duplicate } = enqueue("m-enq-1");
    expect(duplicate).toBe(false);
    expect(job.status).toBe("queued");
    expect(job.namespace).toBe(EBOARD);
    expect(getJob(job.id)?.content).toContain("m-enq-1");
  });

  test("duplicate discord_message_id does not insert a second row", () => {
    const first = enqueue("m-dup");
    const second = enqueue("m-dup");
    expect(second.duplicate).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(getJobByDiscordMessageId("m-dup")?.id).toBe(first.job.id);
  });

  test("two authors in the same channel both stay queued (no cancel-others)", () => {
    const a = enqueue("m-a1", "author-a");
    const b = enqueue("m-b1", "author-b");
    expect(a.job.status).toBe("queued");
    expect(b.job.status).toBe("queued");
    expect(getJob(a.job.id)?.status).toBe("queued");
    expect(getJob(b.job.id)?.status).toBe("queued");
  });

  test("an unknown workspace is refused at insert", () => {
    expect(() =>
      enqueue("m-unknown-ws", "u-unknown", "general", SPONSORS),
    ).toThrow(/unknown workspace/);
  });

  test("listQueued is workspace-subtree scoped, oldest first", () => {
    enqueue("m-lead-1", "u-lead", LEADERSHIP, LEADERSHIP_TEAM);
    enqueue("m-dev-1", "u-dev", PROGRAMS_DEV, DEV_CHAT);

    const fromEboard = listQueued(scope(EBOARD), 20);
    expect(fromEboard.every((j) => j.namespace !== LEADERSHIP)).toBe(true);
    expect(fromEboard.some((j) => j.discord_message_id === "m-dev-1")).toBe(true);
    expect(fromEboard.some((j) => j.discord_message_id === "m-enq-1")).toBe(true);

    const fromLeadership = listQueued(scope(LEADERSHIP), 20);
    expect(fromLeadership.some((j) => j.discord_message_id === "m-lead-1")).toBe(true);

    const fromDev = listQueued(scope(PROGRAMS_DEV), 20);
    expect(fromDev.every((j) => j.namespace === PROGRAMS_DEV)).toBe(true);

    const created = fromEboard.map((j) => j.created_at);
    expect([...created].sort((a, b) => a - b)).toEqual(created);
  });

  test("defaults scope + channel_ids from the workspace's place in the tree", () => {
    const { job } = enqueue("m-scope-eboard");
    expect(job.scope).toBe("channel");
    expect(job.channel_ids).toEqual([SPONSORS]);
    const lead = enqueue("m-scope-lead", "u-scope-lead", LEADERSHIP, LEADERSHIP_TEAM);
    expect(lead.job.scope).toBe("workspace");
    expect(lead.job.channel_ids).toEqual([]);
  });
});

describe("storage/jobs unknown-workspace rows", () => {
  test("a row stored under the legacy 'general' namespace is invisible everywhere", () => {
    const id = "legacy-general-job";
    getDb()
      .query(
        `INSERT INTO jobs (
           id, discord_message_id, discord_channel_id, discord_thread_id,
           author_id, namespace, scope, channel_ids, content, status, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, ?, 'general', 'channel', ?, ?, 'queued', ?, ?)`,
      )
      .run(id, "m-legacy-general", SPONSORS, "u-legacy", JSON.stringify([SPONSORS]), "legacy", 1, 1);

    expect(getJob(id)).toBeNull();
    expect(getJobByDiscordMessageId("m-legacy-general")).toBeNull();
    for (const root of [LEADERSHIP, EBOARD, PROGRAMS_DEV]) {
      expect(listQueued(scope(root), 20).some((j) => j.id === id)).toBe(false);
    }
  });

  test("a legacy 'leadership' scope string maps to workspace scope", () => {
    const id = "legacy-scope-job";
    getDb()
      .query(
        `INSERT INTO jobs (
           id, discord_message_id, discord_channel_id, discord_thread_id,
           author_id, namespace, scope, channel_ids, content, status, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, ?, 'leadership', 'leadership', '[]', ?, 'queued', ?, ?)`,
      )
      .run(id, "m-legacy-scope", LEADERSHIP_TEAM, "u-legacy", "legacy scope", 2, 2);

    expect(getJob(id)?.scope).toBe("workspace");
    expect(getJob(id)?.channel_ids).toEqual([]);
  });
});

describe("storage/jobs claim / complete / fail", () => {
  test("CAS: second claim loses", () => {
    const { job } = enqueue("m-cas");
    const one = claimJob(job.id, "w1");
    const two = claimJob(job.id, "w2");
    expect(one?.status).toBe("claimed");
    expect(one?.claimed_by).toBe("w1");
    expect(two).toBeNull();
    expect(getJob(job.id)?.claimed_by).toBe("w1");
  });

  test("complete with wrong claimed_by fails", () => {
    const { job } = enqueue("m-wrong-worker");
    claimJob(job.id, "w1");
    const prep = prepareComplete(job.id, "w2", { reply: "hi" });
    expect(prep.ok).toBe(false);
    if (!prep.ok) expect(prep.reason).toBe("claimed-by-mismatch");
  });

  test("idempotent complete returns stored result and does not need a second send", () => {
    const { job } = enqueue("m-idemp");
    claimJob(job.id, "w1");
    const prep1 = prepareComplete(job.id, "w1", { reply: "answer", completion_key: "k1" });
    expect(prep1.ok).toBe(true);
    if (prep1.ok) expect(prep1.alreadyCompleted).toBe(false);
    markJobCompleted(job.id, "discord-reply-99");
    const prep2 = prepareComplete(job.id, "w1", { reply: "answer again", completion_key: "k1" });
    expect(prep2.ok).toBe(true);
    if (prep2.ok) {
      expect(prep2.alreadyCompleted).toBe(true);
      expect(prep2.job.result_discord_message_id).toBe("discord-reply-99");
      expect(prep2.job.reply_text).toBe("answer");
    }
  });

  test("send error leaves status claimed", () => {
    const { job } = enqueue("m-send-err");
    claimJob(job.id, "w1");
    prepareComplete(job.id, "w1", { reply: "x", completion_key: "send-err" });
    const after = markJobSendError(job.id, "discord 5xx");
    expect(after?.status).toBe("claimed");
    expect(after?.error).toContain("5xx");
  });

  test("overlapping prepareComplete: one first-attempt, one in-progress", () => {
    const { job } = enqueue("m-complete-cas");
    claimJob(job.id, "w1");
    const first = prepareComplete(job.id, "w1", { reply: "one", completion_key: "ck-overlap" });
    const second = prepareComplete(job.id, "w1", { reply: "two", completion_key: "ck-overlap" });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.alreadyCompleted).toBe(false);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("in-progress");
    expect(getJob(job.id)?.reply_text).toBe("one");
  });

  test("same completion_key can retry after Discord send error", () => {
    const { job } = enqueue("m-complete-retry");
    claimJob(job.id, "w1");
    const first = prepareComplete(job.id, "w1", { reply: "try-1", completion_key: "ck-retry" });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.alreadyCompleted).toBe(false);
    markJobSendError(job.id, "discord 5xx");
    const retry = prepareComplete(job.id, "w1", { reply: "try-2", completion_key: "ck-retry" });
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.alreadyCompleted).toBe(false);
      expect(retry.job.reply_text).toBe("try-2");
      expect(retry.job.error).toBeNull();
    }
  });

  test("fail requires claimed_by match", () => {
    const { job } = enqueue("m-fail");
    claimJob(job.id, "w1");
    expect(failJob(job.id, "w2", "nope")).toBeNull();
    expect(failJob(job.id, "w1", "boom")?.status).toBe("failed");
  });
});

describe("storage/jobs lease sweeper", () => {
  test("requeues expired claimed jobs with no send recorded", () => {
    const { job } = enqueue("m-lease-ok");
    const t0 = 1_000_000;
    claimJob(job.id, "w1", t0);
    const n = requeueExpiredClaims(t0 + 700_000, 600_000);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(getJob(job.id)?.status).toBe("queued");
    expect(getJob(job.id)?.claimed_by).toBeNull();
  });

  test("does not requeue if completion_key is set (send in flight)", () => {
    const { job } = enqueue("m-lease-key");
    const t0 = 2_000_000;
    claimJob(job.id, "w1", t0);
    prepareComplete(job.id, "w1", { reply: "pending", completion_key: "inflight" }, t0);
    requeueExpiredClaims(t0 + 1_000, 600_000);
    expect(getJob(job.id)?.status).toBe("claimed");
    expect(getJob(job.id)?.completion_key).toBe("inflight");
    expect(getJob(job.id)?.error).toBeNull();
    const retry = prepareComplete(job.id, "w1", { reply: "pending-2", completion_key: "inflight" }, t0 + 1_000);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.reason).toBe("in-progress");
  });

  test("does not requeue if result_discord_message_id is set", () => {
    const { job } = enqueue("m-lease-sent");
    const t0 = 3_000_000;
    claimJob(job.id, "w1", t0);
    prepareComplete(job.id, "w1", { reply: "done", completion_key: "sent" }, t0);
    markJobCompleted(job.id, "mid-1", t0);
    expect(getJob(job.id)?.status).toBe("completed");
    requeueExpiredClaims(t0 + 700_000, 600_000);
    expect(getJob(job.id)?.status).toBe("completed");
  });

  test("does not requeue a claimed job after a partial Discord send was recorded", () => {
    const { job } = enqueue("m-lease-partial");
    const t0 = 4_000_000;
    claimJob(job.id, "w1", t0);
    recordJobDiscordSend(job.id, "first-chunk", t0);
    expect(getJob(job.id)?.status).toBe("claimed");
    expect(getJob(job.id)?.result_discord_message_id).toBe("first-chunk");
    requeueExpiredClaims(t0 + 700_000, 600_000);
    expect(getJob(job.id)?.status).toBe("claimed");
    expect(getJob(job.id)?.result_discord_message_id).toBe("first-chunk");
  });

  test("after lease expiry with completion_key and no discord send, complete can retry", () => {
    const author = "cap-crash-author";
    const { job } = enqueue("m-lease-crash", author);
    const t0 = 5_000_000;
    claimJob(job.id, "w1", t0);
    const first = prepareComplete(job.id, "w1", { reply: "pending-crash", completion_key: "crash-key" }, t0);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.alreadyCompleted).toBe(false);
    expect(getJob(job.id)?.error).toBeNull();
    expect(countOutstandingJobs(author)).toBe(1);

    const n = requeueExpiredClaims(t0 + 700_000, 600_000);
    expect(n).toBe(0);
    expect(getJob(job.id)?.status).toBe("claimed");
    expect(getJob(job.id)?.claimed_by).toBe("w1");
    expect(getJob(job.id)?.completion_key).toBe("crash-key");
    expect(getJob(job.id)?.result_discord_message_id).toBeNull();
    expect(getJob(job.id)?.error).toBe("lease-expired-before-send");
    expect(countOutstandingJobs(author)).toBe(1);

    const retry = prepareComplete(
      job.id,
      "w1",
      { reply: "retry-after-crash", completion_key: "crash-key" },
      t0 + 700_000,
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.alreadyCompleted).toBe(false);
      expect(retry.job.reply_text).toBe("retry-after-crash");
      expect(retry.job.error).toBeNull();
    }
  });

  test("post-expiry retry in flight is not re-armed by a later sweeper tick", () => {
    const { job } = enqueue("m-lease-rearm");
    const t0 = 6_000_000;
    claimJob(job.id, "w1", t0);
    prepareComplete(job.id, "w1", { reply: "pending-rearm", completion_key: "rearm-key" }, t0);
    requeueExpiredClaims(t0 + 700_000, 600_000);
    expect(getJob(job.id)?.error).toBe("lease-expired-before-send");

    const retry = prepareComplete(
      job.id,
      "w1",
      { reply: "retry-send", completion_key: "rearm-key" },
      t0 + 700_000,
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.alreadyCompleted).toBe(false);
    expect(getJob(job.id)?.error).toBeNull();
    expect(getJob(job.id)?.result_discord_message_id).toBeNull();

    const second = prepareComplete(
      job.id,
      "w1",
      { reply: "overlap", completion_key: "rearm-key" },
      t0 + 700_000,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("in-progress");

    const n = requeueExpiredClaims(t0 + 730_000, 600_000);
    expect(n).toBe(0);
    expect(getJob(job.id)?.error).toBeNull();
    expect(getJob(job.id)?.status).toBe("claimed");
    expect(getJob(job.id)?.claimed_by).toBe("w1");
    expect(getJob(job.id)?.completion_key).toBe("rearm-key");
    expect(getJob(job.id)?.result_discord_message_id).toBeNull();

    const third = prepareComplete(
      job.id,
      "w1",
      { reply: "third-should-409", completion_key: "rearm-key" },
      t0 + 730_000,
    );
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toBe("in-progress");
  });
});

describe("storage/jobs outstanding count", () => {
  test("counts queued+claimed only", () => {
    const author = "cap-author";
    enqueue("m-out-1", author);
    enqueue("m-out-2", author);
    expect(countOutstandingJobs(author)).toBe(2);
    const j = getJobByDiscordMessageId("m-out-1");
    if (j) {
      claimJob(j.id, "w1");
      failJob(j.id, "w1", "x");
    }
    expect(countOutstandingJobs(author)).toBe(1);
  });
});

describe("firstPassSnippets", () => {
  beforeAll(() => {
    upsertMessage({
      id: "fps-sponsors",
      channelId: SPONSORS,
      authorId: "u2",
      authorName: "bob",
      content: "Acme wants to sponsor",
      createdAt: 500,
    });
    upsertMessage({
      id: "fps-general",
      channelId: GENERAL_CHAT,
      authorId: "u2",
      authorName: "bob",
      content: "general chatter",
      createdAt: 501,
    });
    upsertMessage({
      id: "fps-dev-thread",
      channelId: "9999",
      parentChannelId: DEV_CHAT,
      threadId: "9999",
      threadName: "Deploy plan",
      authorId: "u2",
      authorName: "bob",
      content: "dev thread notes",
      createdAt: 502,
    });
    upsertMessage({
      id: "fps-leadership",
      channelId: LEADERSHIP_TEAM,
      authorId: "u2",
      authorName: "bob",
      content: "leadership budget confidential",
      createdAt: 503,
    });
  });

  test("channel scope stays inside channel_ids and paths parse", () => {
    const snippets = firstPassSnippets({
      namespace: EBOARD,
      scope: "channel",
      channel_ids: [SPONSORS],
      discord_channel_id: SPONSORS,
      discord_thread_id: null,
    });
    expect(snippets.map((s) => s.id)).toEqual(["fps-sponsors"]);
    for (const s of snippets) {
      expect(s.path).toBeDefined();
      expect(parseIndexPath(s.path!)?.kind).toBe("message");
    }
  });

  test("workspace scope spans the subtree but never a parent workspace", () => {
    const snippets = firstPassSnippets(
      {
        namespace: EBOARD,
        scope: "workspace",
        channel_ids: [],
        discord_channel_id: SPONSORS,
        discord_thread_id: null,
      },
      12,
    );
    const ids = snippets.map((s) => s.id);
    expect(ids).toContain("fps-sponsors");
    expect(ids).toContain("fps-general");
    expect(ids).toContain("fps-dev-thread");
    expect(ids).not.toContain("fps-leadership");
    for (const s of snippets) {
      expect(s.path).toBeDefined();
      const parsed = parseIndexPath(s.path!);
      expect(parsed).not.toBeNull();
      expect(parsed?.kind).toBe("message");
    }
  });

  test("a root workspace job reaches every descendant", () => {
    const snippets = firstPassSnippets({
      namespace: LEADERSHIP,
      scope: "workspace",
      channel_ids: [],
      discord_channel_id: LEADERSHIP_TEAM,
      discord_thread_id: null,
    });
    const ids = snippets.map((s) => s.id);
    expect(ids).toContain("fps-leadership");
    expect(ids).toContain("fps-sponsors");
  });
});

describe("firstPassSnippets FTS relevance pass", () => {
  const RECENT_COUNT = 20;
  const OUT_OF_SCOPE_COUNT = 250;
  // Snippet-only content words, so nothing else in this file's DB matches them.
  const KEYWORD = "zephyrite";
  const job = (scope: "channel" | "workspace", content: string, channelIds: string[] = []) => ({
    namespace: EBOARD,
    scope,
    channel_ids: channelIds,
    discord_channel_id: SPONSORS,
    discord_thread_id: null,
    content,
  });

  // Every row this describe seeds uses an `fts-` id so afterAll can remove exactly
  // those and leave the shared DB as the earlier describes expect it.
  const purgeSeeded = () => {
    getDb().run("DELETE FROM messages WHERE id LIKE 'fts-%'");
  };

  beforeAll(() => {
    purgeSeeded();
    // Old, relevant (sponsors, in eboard).
    upsertMessage({
      id: "fts-old-hit",
      channelId: SPONSORS,
      authorId: "u2",
      authorName: "bob",
      content: `the ${KEYWORD} contract was signed last spring`,
      createdAt: 10,
    });
    // Old, relevant, but in a different eboard channel (outside a sponsors-only job).
    upsertMessage({
      id: "fts-old-hit-general",
      channelId: GENERAL_CHAT,
      authorId: "u2",
      authorName: "bob",
      content: `${KEYWORD} kickoff notes`,
      createdAt: 11,
    });
    // Old, relevant, but outside the eboard subtree entirely.
    upsertMessage({
      id: "fts-old-hit-leadership",
      channelId: LEADERSHIP_TEAM,
      authorId: "u2",
      authorName: "bob",
      content: `${KEYWORD} executive summary`,
      createdAt: 12,
    });
    // Newest message: relevant AND recent (dedup case).
    upsertMessage({
      id: "fts-recent-hit",
      channelId: SPONSORS,
      authorId: "u2",
      authorName: "bob",
      content: `${KEYWORD} renewal is due`,
      createdAt: 100_000,
    });
    // Plenty of newer unrelated noise so recency alone would never surface the old hit.
    for (let i = 0; i < RECENT_COUNT; i++) {
      upsertMessage({
        id: `fts-noise-${i}`,
        channelId: SPONSORS,
        authorId: "u2",
        authorName: "bob",
        content: `unrelated chatter number ${i}`,
        createdAt: 50_000 + i,
      });
    }
    // Many better-ranked matches outside the eboard subtree. If the FTS query
    // ranked the whole table before scoping, these would crowd the single
    // in-scope hit out of the candidate window.
    for (let i = 0; i < OUT_OF_SCOPE_COUNT; i++) {
      upsertMessage({
        id: `fts-flood-${i}`,
        channelId: LEADERSHIP_TEAM,
        authorId: "u2",
        authorName: "bob",
        content: `${KEYWORD} ${KEYWORD} ${KEYWORD} ${KEYWORD} flood ${i}`,
        createdAt: 20_000 + i,
      });
    }
  });

  afterAll(() => {
    purgeSeeded();
  });

  test("an old matching message ranks ahead of newer unrelated ones", () => {
    const snippets = firstPassSnippets(job("channel", `<@111> the ${KEYWORD} contract`, [SPONSORS]));
    const ids = snippets.map((s) => s.id);
    expect(ids).toContain("fts-old-hit");
    const hitIdx = ids.indexOf("fts-old-hit");
    const noiseIdx = ids.findIndex((id) => id?.startsWith("fts-noise-"));
    expect(noiseIdx).toBeGreaterThan(hitIdx);
    expect(snippets[hitIdx]?.source).toBe("fts");
    expect(snippets.find((s) => s.id?.startsWith("fts-noise-"))?.source).toBe("recent");
  });

  test("a matching message outside the job's channels is excluded for a channel job", () => {
    const snippets = firstPassSnippets(job("channel", `${KEYWORD}`, [SPONSORS]));
    const ids = snippets.map((s) => s.id);
    expect(ids).toContain("fts-old-hit");
    expect(ids).not.toContain("fts-old-hit-general");
    expect(ids).not.toContain("fts-old-hit-leadership");
  });

  test("scoping happens before the candidate limit, not only after it", () => {
    // 250 better-ranked out-of-scope rows exceed the FTS candidate window (200);
    // the lone old in-scope hit must still come back for a sponsors-only job.
    const snippets = firstPassSnippets(job("channel", `${KEYWORD} contract`, [SPONSORS]));
    const ids = snippets.map((s) => s.id);
    expect(ids).toContain("fts-old-hit");
    expect(snippets.find((s) => s.id === "fts-old-hit")?.source).toBe("fts");
    expect(ids.some((id) => id?.startsWith("fts-flood-"))).toBe(false);
  });

  test("a matching message outside the workspace subtree is excluded for a workspace job", () => {
    const snippets = firstPassSnippets(job("workspace", `${KEYWORD}`));
    const ids = snippets.map((s) => s.id);
    expect(ids).toContain("fts-old-hit");
    expect(ids).toContain("fts-old-hit-general");
    expect(ids).not.toContain("fts-old-hit-leadership");
  });

  test("a message that is both an FTS hit and recent appears once", () => {
    const snippets = firstPassSnippets(job("channel", `${KEYWORD} renewal`, [SPONSORS]));
    const ids = snippets.map((s) => s.id);
    expect(ids.filter((id) => id === "fts-recent-hit")).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(snippets.find((s) => s.id === "fts-recent-hit")?.source).toBe("fts");
  });

  test("punctuation-only content falls back to recency without throwing", () => {
    const snippets = firstPassSnippets(job("channel", "<@111> ?!?", [SPONSORS]));
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets.every((s) => s.source === "recent")).toBe(true);
    expect(snippets[0]?.id).toBe("fts-recent-hit");
  });

  test("cap of 12 still holds with FTS hits", () => {
    expect(firstPassSnippets(job("channel", `${KEYWORD} chatter`, [SPONSORS]), 50)).toHaveLength(12);
    expect(firstPassSnippets(job("channel", `${KEYWORD} chatter`, [SPONSORS]))).toHaveLength(12);
  });
});
