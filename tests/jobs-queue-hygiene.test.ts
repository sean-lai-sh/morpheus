import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import { DEV_CHAT, EBOARD, SPONSORS, withWorkspaceConfig } from "./jobs-fixture.ts";
import {
  cancelStaleQueuedJobs,
  claimJob,
  countOutstandingJobs,
  enqueueJob,
  getJob,
} from "../src/storage/jobs.ts";

const db = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;
beforeAll(() => {
  cfg = withWorkspaceConfig();
});
afterAll(() => {
  cfg.cleanup();
  db.cleanup?.();
});

function queue(id: string, channelId: string, authorId = "author-hyg", now = Date.now()) {
  return enqueueJob(
    {
      discordMessageId: id,
      discordChannelId: channelId,
      discordThreadId: null,
      authorId,
      namespace: EBOARD,
      scope: "channel",
      channelIds: [channelId],
      content: "hi",
    },
    now,
  ).job;
}

describe("cancelStaleQueuedJobs", () => {
  const HOUR = 3_600_000;

  test("cancels a never-claimed job past the cutoff and frees its slot", () => {
    const now = Date.now();
    const old = queue("hyg-stale", DEV_CHAT, "author-stale", now - 2 * HOUR);
    expect(countOutstandingJobs("author-stale", DEV_CHAT)).toBe(1);

    expect(cancelStaleQueuedJobs(now, HOUR)).toBe(1);
    expect(getJob(old.id)?.status).toBe("cancelled");
    expect(getJob(old.id)?.error).toContain("stale");
    // Slot released — this is what unblocks the author.
    expect(countOutstandingJobs("author-stale", DEV_CHAT)).toBe(0);
  });

  test("leaves a fresh queued job alone", () => {
    const now = Date.now();
    const fresh = queue("hyg-fresh", DEV_CHAT, "author-fresh", now - 60_000);
    expect(cancelStaleQueuedJobs(now, HOUR)).toBe(0);
    expect(getJob(fresh.id)?.status).toBe("queued");
  });

  test("never touches a job a worker is actively holding", () => {
    const now = Date.now();
    const held = queue("hyg-claimed", SPONSORS, "author-held", now - 5 * HOUR);
    claimJob(held.id, "grok-eboard", now);
    expect(getJob(held.id)?.status).toBe("claimed");

    // Old enough by age, but claimed → the lease sweeper owns it, not this one.
    expect(cancelStaleQueuedJobs(now, HOUR)).toBe(0);
    expect(getJob(held.id)?.status).toBe("claimed");
  });

  test("is idempotent — a second sweep cancels nothing new", () => {
    const now = Date.now();
    queue("hyg-idem", DEV_CHAT, "author-idem", now - 3 * HOUR);
    expect(cancelStaleQueuedJobs(now, HOUR)).toBe(1);
    expect(cancelStaleQueuedJobs(now, HOUR)).toBe(0);
  });
});
