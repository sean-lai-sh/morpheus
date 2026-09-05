import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getDb } from "../src/storage/db.ts";
import {
  activateTask,
  addTaskAssignments,
  completeTaskAssignment,
  createTaskDraft,
  enqueueNextRecurringReminder,
  getAssignment,
  getTask,
  latestDeliveryForAssignment,
  listTasksCreatedBy,
  listTasksForPerson,
  loadTaskReminder,
  recordTaskReminderDelivery,
  setPersonTaskReminderPreference,
  setTaskAssignmentReminderOverride,
  updateTask,
} from "../src/storage/coordinator-tasks.ts";
import { getOutboxEvent, listPendingOutbox } from "../src/storage/outbox.ts";
import { publishOutboxEvent } from "../src/coordinator/publisher.ts";
import { withTempDb } from "./helpers.ts";

const db = withTempDb();
beforeAll(() => {
  getDb();
});
afterAll(() => db.cleanup());

function openDatedTask(opts: { creator?: string; assignee?: string; dueAt: number; title?: string }) {
  const creator = opts.creator ?? "creator-1";
  const assignee = opts.assignee ?? "assignee-1";
  const task = createTaskDraft({ createdByUserId: creator, title: opts.title ?? "File receipts", channelId: "1001" });
  addTaskAssignments({
    taskId: task.id,
    creatorUserId: creator,
    assignees: [{ userId: assignee, displayName: "Alex" }],
  });
  updateTask({ taskId: task.id, creatorUserId: creator, dueAt: opts.dueAt });
  return activateTask({ taskId: task.id, creatorUserId: creator });
}

describe("task reminder dispatch", () => {
  test("none policy never DMs", async () => {
    const dueAt = Date.now() + 60 * 60_000;
    setPersonTaskReminderPreference({ userId: "assignee-none", defaultPolicy: "none" });
    const { outboxEvents } = openDatedTask({ dueAt, assignee: "assignee-none" });
    expect(outboxEvents).toHaveLength(1);
    const sent: string[] = [];
    const outcome = await publishOutboxEvent(outboxEvents[0]!, {
      now: Date.now(),
      sendDm: async ({ userId }) => {
        sent.push(userId);
      },
    });
    expect(outcome.status).toBe("accepted");
    expect(sent).toEqual([]);
  });

  test("missed reminder becomes an immediate notify", async () => {
    const now = Date.parse("2026-09-10T16:30:00Z");
    const dueAt = Date.parse("2026-09-10T17:00:00Z");
    const { outboxEvents } = openDatedTask({ dueAt });
    const sent: number[] = [];
    const outcome = await publishOutboxEvent(outboxEvents[0]!, {
      now,
      sendDm: async () => {
        sent.push(Date.now());
      },
    });
    expect(outcome.status).toBe("accepted");
    expect(sent).toHaveLength(1);
    const delivery = latestDeliveryForAssignment(outboxEvents[0]!.aggregateId);
    expect(delivery?.status).toBe("sent");
  });

  test("future reminder stays pending until due", async () => {
    const now = Date.parse("2026-09-01T12:00:00Z");
    const dueAt = Date.parse("2026-09-10T17:00:00Z");
    const { outboxEvents } = openDatedTask({ dueAt, assignee: "assignee-future" });
    const sent: string[] = [];
    const outcome = await publishOutboxEvent(outboxEvents[0]!, {
      now,
      sendDm: async ({ userId }) => {
        sent.push(userId);
      },
    });
    expect(outcome.status).toBe("deferred");
    expect(sent).toEqual([]);
    expect(getOutboxEvent(outboxEvents[0]!.id)?.status).toBe("pending");
  });

  test("recurring daily_until_done enqueues the next occurrence with a bumped revision", () => {
    const dueAt = Date.parse("2026-09-10T17:00:00Z");
    const scheduledFor = Date.parse("2026-09-09T17:00:00Z");
    const { outboxEvents } = openDatedTask({ dueAt, assignee: "assignee-recur", title: "Daily follow-up" });
    const assignmentId = outboxEvents[0]!.aggregateId;
    const before = getAssignment(assignmentId)!;
    const next = enqueueNextRecurringReminder({
      assignmentId,
      scheduledFor,
      now: scheduledFor,
    });
    expect(next).not.toBeNull();
    expect(next?.expectedVersion).toBe(before.reminderRevision + 1);
    expect(next?.payload.scheduledFor).toBe(Date.parse("2026-09-10T17:00:00Z"));
    expect(getAssignment(assignmentId)?.reminderRevision).toBe(before.reminderRevision + 1);
  });

  test("delivery failures are visible to assignee and creator", () => {
    const dueAt = Date.now() + 60_000;
    const { task, outboxEvents } = openDatedTask({ dueAt, assignee: "assignee-fail", title: "Broken DM" });
    recordTaskReminderDelivery({
      assignmentId: outboxEvents[0]!.aggregateId,
      reminderRevision: 1,
      scheduledFor: Date.now(),
      status: "failed",
      error: "Cannot send messages to this user",
    });
    const assigned = listTasksForPerson({ userId: "assignee-fail" });
    const created = listTasksCreatedBy({ userId: "creator-1" }).filter((entry) => entry.task.id === task.id);
    expect(assigned[0]?.latestDelivery?.status).toBe("failed");
    expect(created[0]?.assignments[0]?.latestDelivery?.status).toBe("failed");
  });

  test("complete assignment stops further reminder versions from sending", async () => {
    const dueAt = Date.now() + 60_000;
    const { outboxEvents } = openDatedTask({ dueAt, assignee: "assignee-done" });
    completeTaskAssignment({ assignmentId: outboxEvents[0]!.aggregateId, userId: "assignee-done" });
    const sent: string[] = [];
    const outcome = await publishOutboxEvent(outboxEvents[0]!, {
      sendDm: async ({ userId }) => {
        sent.push(userId);
      },
    });
    expect(outcome.status).toBe("accepted");
    expect(sent).toEqual([]);
    expect(getTask(loadTaskReminder(outboxEvents[0]!.aggregateId)!.task.id)?.status).toBe("completed");
  });

  test("per-assignment override beats the personal default", () => {
    const dueAt = Date.now() + 2 * 24 * 60 * 60_000;
    const { outboxEvents } = openDatedTask({ dueAt, assignee: "assignee-override" });
    setPersonTaskReminderPreference({ userId: "assignee-override", defaultPolicy: "daily_until_done" });
    const result = setTaskAssignmentReminderOverride({
      assignmentId: outboxEvents[0]!.aggregateId,
      userId: "assignee-override",
      policy: "none",
    });
    expect(result.assignment.reminderPolicyOverride).toBe("none");
    const loaded = loadTaskReminder(result.assignment.id);
    expect(loaded?.assignment.reminderPolicyOverride).toBe("none");
    expect(loaded?.assignment.channelReminder).toBe(false);
  });

  test("slash settings refuse the NL-only dual policy", () => {
    const dueAt = Date.now() + 2 * 24 * 60 * 60_000;
    const { outboxEvents } = openDatedTask({ dueAt, assignee: "assignee-nl-only" });
    expect(() =>
      setTaskAssignmentReminderOverride({
        assignmentId: outboxEvents[0]!.aggregateId,
        userId: "assignee-nl-only",
        policy: "one_day_and_five_hours",
      }),
    ).toThrow("not available");
    expect(() =>
      setPersonTaskReminderPreference({
        userId: "assignee-nl-only",
        defaultPolicy: "one_day_and_five_hours",
      }),
    ).toThrow("not available");
    expect(getAssignment(outboxEvents[0]!.aggregateId)?.reminderPolicyOverride).toBeNull();
  });
});

describe("task list pending reminders", () => {
  test("listPendingOutbox returns only pending rows", () => {
    const pending = listPendingOutbox(50);
    expect(pending.every((event) => event.status === "pending")).toBe(true);
  });
});
