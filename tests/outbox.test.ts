import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../src/storage/db.ts";
import {
  getOutboxEvent,
  insertOutboxEvent,
  listPendingOutbox,
  markOutboxDispatched,
  markOutboxFailed,
  recordOutboxDispatchFailure,
  OUTBOX_MAX_ATTEMPTS,
} from "../src/storage/outbox.ts";
import {
  activateTask,
  addTaskAssignments,
  createTaskDraft,
  getTask,
  getTaskAssignments,
  updateTask,
} from "../src/storage/coordinator-tasks.ts";
import { createScheduledMeeting } from "../src/storage/coordinator-meetings.ts";
import { publishOutboxEvent, recoverPendingOutbox } from "../src/coordinator/publisher.ts";
import { withTempDb } from "./helpers.ts";
import { SPONSORS, withWorkspaceConfig } from "./jobs-fixture.ts";

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

function draftWithAssignee(dueAt?: number) {
  const task = createTaskDraft({
    createdByUserId: "creator-1",
    title: "Write sponsor email",
    channelId: "1001",
  });
  addTaskAssignments({
    taskId: task.id,
    creatorUserId: "creator-1",
    assignees: [{ userId: "assignee-1", displayName: "Alex" }],
  });
  if (dueAt !== undefined) {
    updateTask({ taskId: task.id, creatorUserId: "creator-1", dueAt });
  }
  return task;
}

describe("outbox uniqueness and transactional write", () => {
  test("unique (type, aggregate_id, expected_version) is idempotent", () => {
    const first = insertOutboxEvent({
      type: "task.assignment_reminder_requested",
      aggregateId: "assignment-unique",
      expectedVersion: 1,
      payload: { assignmentId: "assignment-unique", reminderVersion: 1 },
    });
    const second = insertOutboxEvent({
      type: "task.assignment_reminder_requested",
      aggregateId: "assignment-unique",
      expectedVersion: 1,
      payload: { assignmentId: "assignment-unique", reminderVersion: 1 },
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("task activate writes the outbox row in the same transaction as the mutation", () => {
    const dueAt = Date.now() + 2 * 24 * 60 * 60_000;
    const task = draftWithAssignee(dueAt);
    expect(() => {
      getDb().transaction(() => {
        activateTask({ taskId: task.id, creatorUserId: "creator-1" });
        throw new Error("rollback");
      })();
    }).toThrow("rollback");
    expect(getTask(task.id)?.status).toBe("draft");
    const assignmentId = getTaskAssignments(task.id)[0]?.id;
    expect(assignmentId).toBeDefined();
    expect(
      getDb()
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM outbox_events WHERE type = 'task.assignment_reminder_requested' AND aggregate_id = ?`,
        )
        .get(assignmentId!)?.n,
    ).toBe(0);
  });

  test("successful activate leaves one pending reminder outbox", () => {
    const dueAt = Date.now() + 2 * 24 * 60 * 60_000;
    const task = draftWithAssignee(dueAt);
    const result = activateTask({ taskId: task.id, creatorUserId: "creator-1" });
    expect(result.task.status).toBe("open");
    expect(result.outboxEvents).toHaveLength(1);
    expect(result.outboxEvents[0]?.type).toBe("task.assignment_reminder_requested");
    expect(getOutboxEvent(result.outboxEvents[0]!.id)?.status).toBe("pending");
  });

  test("undated activate writes no reminder outbox", () => {
    const task = draftWithAssignee();
    const result = activateTask({ taskId: task.id, creatorUserId: "creator-1" });
    expect(result.task.status).toBe("open");
    expect(result.outboxEvents).toHaveLength(0);
  });
});

function scheduledMeeting(title: string) {
  return createScheduledMeeting({
    createdByUserId: "creator-1",
    title,
    startsAt: Date.now() + 3_600_000,
    durationMinutes: 30,
    channelId: SPONSORS,
    participants: [{ userId: "u-1", displayName: "Sam" }],
  });
}

describe("outbox publisher accepted vs deferred + sweeper", () => {
  test("accepted handoff marks dispatched", async () => {
    const { outboxEvents } = scheduledMeeting("Publish accepted");
    const event = outboxEvents[0]!;
    const outcome = await publishOutboxEvent(event, {
      dispatchCalendar: async () => true,
      enqueueCalendar: () => ({ duplicate: false }),
    });
    expect(outcome.status).toBe("accepted");
    expect(getOutboxEvent(event.id)?.status).toBe("dispatched");
  });

  test("timeout or error leaves the row pending (deferred)", async () => {
    const { outboxEvents } = scheduledMeeting("Publish deferred");
    const event = outboxEvents[0]!;
    const outcome = await publishOutboxEvent(event, {
      dispatchCalendar: async () => {
        throw new Error("handoff unavailable");
      },
      enqueueCalendar: () => ({ duplicate: false }),
    });
    expect(outcome.status).toBe("deferred");
    const row = getOutboxEvent(event.id);
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toContain("handoff unavailable");
  });

  test("sweeper recovers pending rows", async () => {
    const { outboxEvents } = scheduledMeeting("Publish recover");
    const event = outboxEvents[0]!;
    recordOutboxDispatchFailure(event.id, "first try failed");
    expect(listPendingOutbox()).toEqual(expect.arrayContaining([expect.objectContaining({ id: event.id })]));
    const outcomes = await recoverPendingOutbox(50, {
      dispatchCalendar: async () => true,
      enqueueCalendar: () => ({ duplicate: false }),
    });
    expect(outcomes.some((o) => o.outboxId === event.id && o.status === "accepted")).toBe(true);
    expect(getOutboxEvent(event.id)?.status).toBe("dispatched");
  });

  test("markOutboxDispatched is a pending → dispatched CAS", () => {
    const event = insertOutboxEvent({
      type: "meeting.calendar_cancel_requested",
      aggregateId: "meeting-cas",
      expectedVersion: 2,
      payload: { meetingId: "meeting-cas", version: 2 },
    });
    expect(markOutboxDispatched(event!.id)).toBe(true);
    expect(markOutboxDispatched(event!.id)).toBe(false);
  });
});

describe("outbox retry cap dead-letters exhausted rows", () => {
  beforeEach(() => {
    // The cap tests assert on the whole pending window (limit clamps at 50),
    // so start from an empty outbox rather than whatever earlier suites left.
    getDb().exec(`DELETE FROM outbox_events`);
  });

  function pendingRow(aggregateId: string, createdAt: number) {
    const event = insertOutboxEvent(
      {
        type: "meeting.calendar_cancel_requested",
        aggregateId,
        expectedVersion: 1,
        payload: { meetingId: aggregateId, version: 1 },
      },
      createdAt,
    );
    expect(event).not.toBeNull();
    return event!;
  }

  test("retries below the cap stay pending and keep being swept", () => {
    const event = pendingRow("cap-under", 1_000);
    for (let attempt = 1; attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      const result = recordOutboxDispatchFailure(event.id, `boom ${attempt}`);
      expect(result.updated).toBe(true);
      expect(result.attempts).toBe(attempt);
      expect(result.deadLettered).toBe(false);
      const row = getOutboxEvent(event.id);
      expect(row?.status).toBe("pending");
      expect(row?.lastError).toBe(`boom ${attempt}`);
      expect(listPendingOutbox().map((e) => e.id)).toContain(event.id);
    }
  });

  test("the failure that reaches the cap flips the row to failed and drops it from the pending window", () => {
    const event = pendingRow("cap-exhaust", 1_000);
    for (let attempt = 1; attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      recordOutboxDispatchFailure(event.id, "handoff unavailable");
    }
    const last = recordOutboxDispatchFailure(event.id, "handoff unavailable");
    expect(last.updated).toBe(true);
    expect(last.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(last.deadLettered).toBe(true);

    const row = getOutboxEvent(event.id);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    // last_error survives and says this was exhaustion, not a hard refusal.
    expect(row?.lastError).toContain("exhausted after");
    expect(row?.lastError).toContain("handoff unavailable");
    expect(row!.lastError!.length).toBeLessThanOrEqual(500);
    expect(listPendingOutbox().map((e) => e.id)).not.toContain(event.id);

    // Terminal: further failures are a no-op CAS miss.
    const after = recordOutboxDispatchFailure(event.id, "again");
    expect(after).toEqual({ updated: false, attempts: 0, deadLettered: false });
    expect(getOutboxEvent(event.id)?.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
  });

  test("last_error is truncated to 500 chars on the exhausting failure", () => {
    const event = pendingRow("cap-truncate", 1_000);
    for (let attempt = 1; attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      recordOutboxDispatchFailure(event.id, "x");
    }
    recordOutboxDispatchFailure(event.id, "y".repeat(2_000));
    expect(getOutboxEvent(event.id)?.lastError?.length).toBe(500);
  });

  test("exhausted rows no longer starve newer events at the head of the queue", () => {
    // listPendingOutbox reads at most 50 rows, oldest first. Fill that whole
    // window with permanently-failing rows, then queue one good newer event.
    const dead: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const row = pendingRow(`starve-dead-${i}`, 1_000 + i);
      dead.push(row.id);
    }
    const fresh = pendingRow("starve-fresh", 9_000);

    // Before exhaustion the newer row is invisible: the window is all dead rows.
    expect(listPendingOutbox().map((e) => e.id)).not.toContain(fresh.id);

    for (let attempt = 0; attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      for (const id of dead) recordOutboxDispatchFailure(id, "unknown-namespace");
    }

    const pending = listPendingOutbox();
    expect(pending.map((e) => e.id)).toEqual([fresh.id]);
    for (const id of dead) expect(getOutboxEvent(id)?.status).toBe("failed");
  });

  test("markOutboxFailed still terminates a hard refusal immediately", () => {
    const event = pendingRow("cap-hard-refusal", 1_000);
    recordOutboxDispatchFailure(event.id, "transient");
    expect(getOutboxEvent(event.id)?.status).toBe("pending");

    expect(markOutboxFailed(event.id, "refused-email-in-payload")).toBe(true);
    const row = getOutboxEvent(event.id);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(2);
    expect(row?.lastError).toBe("refused-email-in-payload");
    expect(row?.lastError).not.toContain("exhausted");
    expect(listPendingOutbox().map((e) => e.id)).not.toContain(event.id);
    expect(markOutboxFailed(event.id, "again")).toBe(false);
  });
});
