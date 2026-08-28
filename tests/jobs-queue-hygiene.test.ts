import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import { DEV_CHAT, EBOARD, SPONSORS, withWorkspaceConfig } from "./jobs-fixture.ts";
import {
  cancelStaleQueuedJobs,
  claimJob,
  countOutstandingJobs,
  enqueueJob,
  getJob,
  requeueExpiredClaims,
} from "../src/storage/jobs.ts";
import { coordinatorJobMessageId } from "../src/coordinator/calendar-job.ts";

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

  test("does not cancel a job the lease sweeper just requeued", () => {
    // Both sweepers run back-to-back in the same 30s tick (src/crawler/live.ts).
    // requeueExpiredClaims moves claimed -> queued WITHOUT touching created_at, so
    // on age alone this row looks ancient and would be cancelled one statement
    // later — with an error claiming no worker ever took it, which is false.
    const now = Date.now();
    const requeued = queue("hyg-requeued", DEV_CHAT, "author-requeued", now - 5 * HOUR);
    expect(claimJob(requeued.id, "grok-eboard", now - 4 * HOUR)?.status).toBe("claimed");

    // Lease expired long ago → back to queued, updated_at = now, claimed_by cleared.
    expect(requeueExpiredClaims(now, HOUR)).toBe(1);
    expect(getJob(requeued.id)?.status).toBe("queued");

    // Same tick, immediately after: the retry must survive to be dispatched again.
    expect(cancelStaleQueuedJobs(now, HOUR)).toBe(0);
    const after = getJob(requeued.id);
    expect(after?.status).toBe("queued");
    expect(after?.error).toBeNull();
    // Still outstanding — the author's slot stays held while the retry is pending.
    expect(countOutstandingJobs("author-requeued", DEV_CHAT)).toBe(1);
  });

  test("skips coordinator outbox jobs while still cancelling ordinary ones", () => {
    // Coordinator/Calendar jobs belong to the outbox retry sweeper in
    // src/coordinator/publisher.ts. Cancelling one here, with its outbox row
    // already marked dispatched, silently drops a Calendar handoff.
    const now = Date.now();
    const coord = queue(
      coordinatorJobMessageId("outbox-hyg-1"),
      SPONSORS,
      "author-coord",
      now - 3 * HOUR,
    );
    const ordinary = queue("hyg-ordinary-old", SPONSORS, "author-ordinary", now - 3 * HOUR);

    // Exactly one row swept — proves the skip is selective, not the sweeper failing.
    expect(cancelStaleQueuedJobs(now, HOUR)).toBe(1);
    expect(getJob(coord.id)?.status).toBe("queued");
    expect(getJob(coord.id)?.error).toBeNull();
    expect(getJob(ordinary.id)?.status).toBe("cancelled");
    expect(getJob(ordinary.id)?.error).toContain("stale");
    // The outbox job keeps its slot; the ordinary one gives its slot back.
    expect(countOutstandingJobs("author-coord", SPONSORS)).toBe(1);
    expect(countOutstandingJobs("author-ordinary", SPONSORS)).toBe(0);
  });
});
