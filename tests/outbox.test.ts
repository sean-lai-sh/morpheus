import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getDb } from "../src/storage/db.ts";
import {
  getOutboxEvent,
  insertOutboxEvent,
  listPendingOutbox,
  markOutboxDispatched,
  recordOutboxDispatchFailure,
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
