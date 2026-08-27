import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import {
  claimJob,
  countOutstandingJobs,
  enqueueJob,
  failJob,
  getJob,
  getJobByDiscordMessageId,
  listQueued,
  markJobCompleted,
  markJobSendError,
  prepareComplete,
  requeueExpiredClaims,
} from "../src/storage/jobs.ts";

const t = withTempDb();
beforeAll(() => {});
afterAll(() => t.cleanup());

function enqueue(id: string, author = "u1", ns: "general" | "leadership" = "general") {
  return enqueueJob({
    discordMessageId: id,
    discordChannelId: "c1",
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
    expect(job.namespace).toBe("general");
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

  test("listQueued is namespace-scoped, oldest first", () => {
    enqueue("m-lead-1", "u-lead", "leadership");
    const general = listQueued("general", 20);
    const leadership = listQueued("leadership", 20);
    expect(general.every((j) => j.namespace === "general")).toBe(true);
    expect(leadership.every((j) => j.namespace === "leadership")).toBe(true);
    expect(leadership.some((j) => j.discord_message_id === "m-lead-1")).toBe(true);
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
    const n = requeueExpiredClaims(t0 + 700_000, 600_000);
    expect(getJob(job.id)?.status).toBe("claimed");
    expect(getJob(job.id)?.completion_key).toBe("inflight");
    void n;
  });

  test("does not requeue if result_discord_message_id is set", () => {
    const { job } = enqueue("m-lease-sent");
    const t0 = 3_000_000;
    claimJob(job.id, "w1", t0);
    prepareComplete(job.id, "w1", { reply: "done", completion_key: "sent" }, t0);
    markJobCompleted(job.id, "mid-1", t0);
    // Force claimed with a result id shouldn't happen, but sweeper SQL also guards claimed+result id.
    expect(getJob(job.id)?.status).toBe("completed");
    requeueExpiredClaims(t0 + 700_000, 600_000);
    expect(getJob(job.id)?.status).toBe("completed");
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
