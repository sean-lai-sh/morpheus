import {
  dualReminderSlots,
  effectiveTaskReminderPolicy,
  isRecurringTaskReminder,
  nextDualReminderSlot,
  nextTaskReminderAt,
  type DualReminderSlot,
  type TaskReminderPolicy,
} from "../coordinator/reminders.ts";
import { getDb } from "./db.ts";
import { insertOutboxEvent, type OutboxEvent } from "./outbox.ts";

export type TaskStatus = "draft" | "open" | "completed" | "cancelled";
export type AssignmentStatus = "open" | "completed";
export type DeliveryStatus = "sent" | "failed" | "skipped";

export interface TaskRow {
  id: string;
  createdByUserId: string;
  title: string;
  description: string | null;
  dueAt: number | null;
  timeZone: string;
  status: TaskStatus;
  revision: number;
  channelId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskAssignmentRow {
  id: string;
  taskId: string;
  userId: string;
  displayName: string | null;
  status: AssignmentStatus;
  reminderPolicyOverride: TaskReminderPolicy | null;
  reminderRevision: number;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReminderDeliveryRow {
  assignmentId: string;
  reminderRevision: number;
  scheduledFor: number;
  status: DeliveryStatus;
  error: string | null;
  createdAt: number;
}

export interface AssigneeInput {
  userId: string;
  displayName?: string | null;
}

interface TaskDbRow {
  id: string;
  created_by_user_id: string;
  title: string;
  description: string | null;
  due_at: number | null;
  time_zone: string;
  status: string;
  revision: number;
  channel_id: string | null;
  created_at: number;
  updated_at: number;
}

interface AssignmentDbRow {
  id: string;
  task_id: string;
  user_id: string;
  display_name: string | null;
  status: string;
  reminder_policy_override: string | null;
  reminder_revision: number;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

function mapTask(row: TaskDbRow): TaskRow {
  return {
    id: row.id,
    createdByUserId: row.created_by_user_id,
    title: row.title,
    description: row.description,
    dueAt: row.due_at,
    timeZone: row.time_zone,
    status: row.status as TaskStatus,
    revision: row.revision,
    channelId: row.channel_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAssignment(row: AssignmentDbRow): TaskAssignmentRow {
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    displayName: row.display_name,
    status: row.status as AssignmentStatus,
    reminderPolicyOverride: row.reminder_policy_override as TaskReminderPolicy | null,
    reminderRevision: row.reminder_revision,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createTaskDraft(input: {
  createdByUserId: string;
  title: string;
  description?: string | null;
  timeZone?: string;
  channelId?: string | null;
  now?: number;
}): TaskRow {
  const now = input.now ?? Date.now();
  const title = input.title.trim();
  if (!title) throw new Error("Task title is required.");
  const id = crypto.randomUUID();
  getDb()
    .query(
      `INSERT INTO tasks (
         id, created_by_user_id, title, description, due_at, time_zone,
         status, revision, channel_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, ?, 'draft', 1, ?, ?, ?)`,
    )
    .run(
      id,
      input.createdByUserId,
      title.slice(0, 100),
      input.description?.trim() || null,
      input.timeZone ?? "America/New_York",
      input.channelId ?? null,
      now,
      now,
    );
  const task = getTask(id);
  if (!task) throw new Error("createTaskDraft: insert succeeded but row missing");
  return task;
}

export function getTask(id: string): TaskRow | null {
  const row = getDb().query<TaskDbRow, [string]>(`SELECT * FROM tasks WHERE id = ?`).get(id);
  return row ? mapTask(row) : null;
}

export function getTaskForCreator(taskId: string, creatorUserId: string): TaskRow | null {
  const task = getTask(taskId);
  if (!task || task.createdByUserId !== creatorUserId) return null;
  return task;
}

export function getAssignment(id: string): TaskAssignmentRow | null {
  const row = getDb()
    .query<AssignmentDbRow, [string]>(`SELECT * FROM task_assignments WHERE id = ?`)
    .get(id);
  return row ? mapAssignment(row) : null;
}

export function getTaskAssignments(taskId: string): TaskAssignmentRow[] {
  return getDb()
    .query<AssignmentDbRow, [string]>(
      `SELECT * FROM task_assignments WHERE task_id = ? ORDER BY created_at ASC`,
    )
    .all(taskId)
    .map(mapAssignment);
}

export function getPersonReminderPreference(userId: string): TaskReminderPolicy {
  const row = getDb()
    .query<{ default_policy: string }, [string]>(
      `SELECT default_policy FROM person_task_reminder_preferences WHERE user_id = ?`,
    )
    .get(userId);
  return (row?.default_policy as TaskReminderPolicy | undefined) ?? "daily_until_done";
}

function requireEditableTask(taskId: string, creatorUserId: string): TaskDbRow {
  const row = getDb()
    .query<TaskDbRow, [string, string]>(
      `SELECT * FROM tasks WHERE id = ? AND created_by_user_id = ?`,
    )
    .get(taskId, creatorUserId);
  if (!row || row.status === "completed" || row.status === "cancelled") {
    throw new Error("Only the task creator can edit an active task.");
  }
  return row;
}

function emitAssignmentReminder(
  assignment: TaskAssignmentRow,
  task: Pick<TaskRow, "dueAt" | "status">,
  now: number = Date.now(),
): OutboxEvent | null {
  if (task.status !== "open" || task.dueAt == null) return null;
  const policy = effectiveTaskReminderPolicy(
    assignment.reminderPolicyOverride ?? undefined,
    getPersonReminderPreference(assignment.userId),
  );
  const payload: OutboxEvent["payload"] = {
    assignmentId: assignment.id,
    reminderVersion: assignment.reminderRevision,
  };
  if (policy === "one_day_and_five_hours") {
    const next = nextDualReminderSlot(new Date(task.dueAt), new Date(now));
    if (!next) return null;
    payload.slot = next.slot;
    payload.scheduledFor = next.at.getTime();
  }
  return insertOutboxEvent({
    type: "task.assignment_reminder_requested",
    aggregateId: assignment.id,
    expectedVersion: assignment.reminderRevision,
    payload,
  });
}

function bumpAssignmentRevision(assignmentId: string, now: number): TaskAssignmentRow {
  const row = getDb()
    .query<AssignmentDbRow, [number, string]>(
      `UPDATE task_assignments
       SET reminder_revision = reminder_revision + 1, updated_at = ?
       WHERE id = ?
       RETURNING *`,
    )
    .get(now, assignmentId);
  if (!row) throw new Error("Unable to bump assignment reminder revision.");
  return mapAssignment(row);
}

export function addTaskAssignments(input: {
  taskId: string;
  creatorUserId: string;
  assignees: AssigneeInput[];
  reminderPolicyOverride?: TaskReminderPolicy | null;
  now?: number;
}): { assignments: TaskAssignmentRow[]; outboxEvents: OutboxEvent[] } {
  if (input.assignees.length === 0) return { assignments: [], outboxEvents: [] };
  const now = input.now ?? Date.now();
  return getDb().transaction(() => {
    const task = mapTask(requireEditableTask(input.taskId, input.creatorUserId));
    const unique = [...new Map(input.assignees.map((a) => [a.userId, a])).values()];
    const inserted: TaskAssignmentRow[] = [];
    for (const assignee of unique) {
      const id = crypto.randomUUID();
      try {
        getDb()
          .query(
            `INSERT INTO task_assignments (
               id, task_id, user_id, display_name, status, reminder_policy_override,
               reminder_revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'open', ?, 1, ?, ?)`,
          )
          .run(
            id,
            task.id,
            assignee.userId,
            assignee.displayName ?? null,
            input.reminderPolicyOverride ?? null,
            now,
            now,
          );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/UNIQUE constraint failed/i.test(msg)) continue;
        throw err;
      }
      const row = getAssignment(id);
      if (row) inserted.push(row);
    }
    const outboxEvents: OutboxEvent[] = [];
    if (task.status === "open" && task.dueAt != null) {
      for (const assignment of inserted) {
        const event = emitAssignmentReminder(assignment, task, now);
        if (event) outboxEvents.push(event);
      }
    }
    return { assignments: inserted, outboxEvents };
  })();
}

export function updateTask(input: {
  taskId: string;
  creatorUserId: string;
  title?: string;
  description?: string | null;
  dueAt?: number | null;
  now?: number;
}): { task: TaskRow; outboxEvents: OutboxEvent[] } {
  const now = input.now ?? Date.now();
  return getDb().transaction(() => {
    const existing = requireEditableTask(input.taskId, input.creatorUserId);
    const title = input.title !== undefined ? input.title.trim().slice(0, 100) : existing.title;
    if (!title) throw new Error("Task title is required.");
    const description =
      input.description !== undefined ? input.description?.trim() || null : existing.description;
    const dueAt = input.dueAt !== undefined ? input.dueAt : existing.due_at;
    const row = getDb()
      .query<TaskDbRow, [string, string | null, number | null, number, string]>(
        `UPDATE tasks
         SET title = ?, description = ?, due_at = ?, revision = revision + 1, updated_at = ?
         WHERE id = ?
         RETURNING *`,
      )
      .get(title, description, dueAt, now, existing.id);
    if (!row) throw new Error("Unable to update task.");
    const task = mapTask(row);
    const outboxEvents: OutboxEvent[] = [];
    if (task.status === "open") {
      for (const current of getTaskAssignments(task.id).filter((a) => a.status === "open")) {
        const bumped = bumpAssignmentRevision(current.id, now);
        const event = emitAssignmentReminder(bumped, task, now);
        if (event) outboxEvents.push(event);
      }
    }
    return { task, outboxEvents };
  })();
}

export function activateTask(input: {
  taskId: string;
  creatorUserId: string;
  now?: number;
}): { task: TaskRow; outboxEvents: OutboxEvent[] } {
  const now = input.now ?? Date.now();
  return getDb().transaction(() => {
    const existing = getDb()
      .query<TaskDbRow, [string, string]>(
        `SELECT * FROM tasks WHERE id = ? AND created_by_user_id = ? AND status = 'draft'`,
      )
      .get(input.taskId, input.creatorUserId);
    if (!existing) throw new Error("Only the task creator can activate this draft.");
    const assignments = getTaskAssignments(existing.id);
    if (assignments.length === 0) throw new Error("Add at least one assignee before creating this task.");
    const row = getDb()
      .query<TaskDbRow, [number, string]>(
        `UPDATE tasks
         SET status = 'open', revision = revision + 1, updated_at = ?
         WHERE id = ?
         RETURNING *`,
      )
      .get(now, existing.id);
    if (!row) throw new Error("Unable to activate task.");
    const task = mapTask(row);
    const outboxEvents: OutboxEvent[] = [];
    if (task.dueAt != null) {
      for (const assignment of assignments) {
        const event = emitAssignmentReminder(assignment, task, now);
        if (event) outboxEvents.push(event);
      }
    }
    return { task, outboxEvents };
  })();
}

export function completeTaskAssignment(input: {
  assignmentId: string;
  userId: string;
  now?: number;
}): TaskAssignmentRow {
  const now = input.now ?? Date.now();
  return getDb().transaction(() => {
    const row = getDb()
      .query<AssignmentDbRow, [number, number, string, string]>(
        `UPDATE task_assignments
         SET status = 'completed', completed_at = ?, reminder_revision = reminder_revision + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'open'
         RETURNING *`,
      )
      .get(now, now, input.assignmentId, input.userId);
    if (!row) throw new Error("Only the assignee can mark this task done.");
    const remaining =
      getDb()
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM task_assignments WHERE task_id = ? AND status = 'open'`,
        )
        .get(row.task_id)?.n ?? 0;
    if (remaining === 0) {
      getDb()
        .query(
          `UPDATE tasks SET status = 'completed', revision = revision + 1, updated_at = ?
           WHERE id = ? AND status = 'open'`,
        )
        .run(now, row.task_id);
    }
    return mapAssignment(row);
  })();
}

export function cancelTask(input: { taskId: string; creatorUserId: string; now?: number }): TaskRow {
  const now = input.now ?? Date.now();
  const row = getDb()
    .query<TaskDbRow, [number, string, string]>(
      `UPDATE tasks
       SET status = 'cancelled', revision = revision + 1, updated_at = ?
       WHERE id = ? AND created_by_user_id = ? AND status IN ('draft', 'open')
       RETURNING *`,
    )
    .get(now, input.taskId, input.creatorUserId);
  if (!row) throw new Error("Only the task creator can cancel an active task.");
  return mapTask(row);
}

export function setPersonTaskReminderPreference(input: {
  userId: string;
  defaultPolicy: TaskReminderPolicy;
  now?: number;
}): OutboxEvent[] {
  const now = input.now ?? Date.now();
  return getDb().transaction(() => {
    getDb()
      .query(
        `INSERT INTO person_task_reminder_preferences (user_id, default_policy, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET default_policy = excluded.default_policy, updated_at = excluded.updated_at`,
      )
      .run(input.userId, input.defaultPolicy, now);
    const rows = getDb()
      .query<AssignmentDbRow & { task_due_at: number | null; task_status: string }, [string]>(
        `SELECT a.*, t.due_at AS task_due_at, t.status AS task_status
         FROM task_assignments a
         JOIN tasks t ON t.id = a.task_id
         WHERE a.user_id = ?
           AND a.reminder_policy_override IS NULL
           AND a.status = 'open'
           AND t.status = 'open'`,
      )
      .all(input.userId);
    const outboxEvents: OutboxEvent[] = [];
    for (const row of rows) {
      const bumped = bumpAssignmentRevision(row.id, now);
      const event = emitAssignmentReminder(bumped, {
        dueAt: row.task_due_at,
        status: row.task_status as TaskStatus,
      }, now);
      if (event) outboxEvents.push(event);
    }
    return outboxEvents;
  })();
}

export function setTaskAssignmentReminderOverride(input: {
  assignmentId: string;
  userId: string;
  policy?: TaskReminderPolicy;
  now?: number;
}): { assignment: TaskAssignmentRow; outboxEvents: OutboxEvent[] } {
  const now = input.now ?? Date.now();
  return getDb().transaction(() => {
    const row = getDb()
      .query<AssignmentDbRow, [string | null, number, string, string]>(
        `UPDATE task_assignments
         SET reminder_policy_override = ?, reminder_revision = reminder_revision + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'open'
         RETURNING *`,
      )
      .get(input.policy ?? null, now, input.assignmentId, input.userId);
    if (!row) throw new Error("Only the assignee can change this reminder.");
    const assignment = mapAssignment(row);
    const task = getTask(assignment.taskId);
    const outboxEvents: OutboxEvent[] = [];
    if (task?.status === "open" && task.dueAt != null) {
      const event = emitAssignmentReminder(assignment, task, now);
      if (event) outboxEvents.push(event);
    }
    return { assignment, outboxEvents };
  })();
}

export function loadTaskReminder(assignmentId: string): {
  task: TaskRow;
  assignment: TaskAssignmentRow;
  defaultPolicy: TaskReminderPolicy;
} | null {
  const assignment = getAssignment(assignmentId);
  if (!assignment) return null;
  const task = getTask(assignment.taskId);
  if (!task) return null;
  return {
    task,
    assignment,
    defaultPolicy: getPersonReminderPreference(assignment.userId),
  };
}

export function canSendTaskReminder(
  loaded: ReturnType<typeof loadTaskReminder>,
  reminderVersion: number,
): loaded is NonNullable<ReturnType<typeof loadTaskReminder>> {
  return Boolean(
    loaded &&
      loaded.task.status === "open" &&
      loaded.assignment.status === "open" &&
      loaded.assignment.reminderRevision === reminderVersion,
  );
}

export function recordTaskReminderDelivery(input: {
  assignmentId: string;
  reminderRevision: number;
  scheduledFor: number;
  status: DeliveryStatus;
  error?: string;
  now?: number;
}): void {
  const now = input.now ?? Date.now();
  getDb()
    .query(
      `INSERT INTO task_reminder_deliveries (
         id, assignment_id, reminder_revision, scheduled_for, status, error, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(assignment_id, reminder_revision, scheduled_for) DO UPDATE SET
         status = excluded.status,
         error = excluded.error`,
    )
    .run(
      crypto.randomUUID(),
      input.assignmentId,
      input.reminderRevision,
      input.scheduledFor,
      input.status,
      input.error ?? null,
      now,
    );
}

export function latestDeliveryForAssignment(assignmentId: string): ReminderDeliveryRow | null {
  const row = getDb()
    .query<
      {
        assignment_id: string;
        reminder_revision: number;
        scheduled_for: number;
        status: DeliveryStatus;
        error: string | null;
        created_at: number;
      },
      [string]
    >(
      `SELECT assignment_id, reminder_revision, scheduled_for, status, error, created_at
       FROM task_reminder_deliveries
       WHERE assignment_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(assignmentId);
  if (!row) return null;
  return {
    assignmentId: row.assignment_id,
    reminderRevision: row.reminder_revision,
    scheduledFor: row.scheduled_for,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
  };
}

export interface PersonTaskEntry {
  task: TaskRow;
  assignment: TaskAssignmentRow;
  creatorName: string;
  latestDelivery: ReminderDeliveryRow | null;
}

export function listTasksForPerson(input: {
  userId: string;
  includeCompleted?: boolean;
}): PersonTaskEntry[] {
  const assignments = getDb()
    .query<AssignmentDbRow, [string]>(
      input.includeCompleted
        ? `SELECT * FROM task_assignments WHERE user_id = ? ORDER BY created_at ASC`
        : `SELECT * FROM task_assignments WHERE user_id = ? AND status = 'open' ORDER BY created_at ASC`,
    )
    .all(input.userId)
    .map(mapAssignment);
  const entries: PersonTaskEntry[] = [];
  for (const assignment of assignments) {
    const task = getTask(assignment.taskId);
    if (!task) continue;
    const creator = getDb()
      .query<{ creator_name: string | null }, [string, string]>(
        `SELECT COALESCE(display_name, global_name, username, ?) AS creator_name FROM users WHERE user_id = ?`,
      )
      .get(task.createdByUserId, task.createdByUserId);
    entries.push({
      task,
      assignment,
      creatorName: creator?.creator_name ?? task.createdByUserId,
      latestDelivery: latestDeliveryForAssignment(assignment.id),
    });
  }
  entries.sort((a, b) => (a.task.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.task.dueAt ?? Number.MAX_SAFE_INTEGER));
  return entries;
}

export interface CreatedTaskEntry {
  task: TaskRow;
  assignments: Array<TaskAssignmentRow & { latestDelivery: ReminderDeliveryRow | null }>;
}

export function listTasksCreatedBy(input: {
  userId: string;
  includeCompleted?: boolean;
}): CreatedTaskEntry[] {
  const rows = getDb()
    .query<TaskDbRow, [string]>(
      input.includeCompleted
        ? `SELECT * FROM tasks WHERE created_by_user_id = ? AND status IN ('draft', 'open', 'completed')
           ORDER BY due_at, created_at`
        : `SELECT * FROM tasks WHERE created_by_user_id = ? AND status IN ('draft', 'open')
           ORDER BY due_at, created_at`,
    )
    .all(input.userId);
  return rows.map((row) => {
    const task = mapTask(row);
    return {
      task,
      assignments: getTaskAssignments(task.id).map((assignment) => ({
        ...assignment,
        latestDelivery: latestDeliveryForAssignment(assignment.id),
      })),
    };
  });
}

/**
 * After a successful send, enqueue the next daily occurrence with a bumped
 * reminder_revision so (type, aggregate, version) stays unique.
 */
export function enqueueNextRecurringReminder(input: {
  assignmentId: string;
  scheduledFor: number;
  now?: number;
}): OutboxEvent | null {
  const now = input.now ?? Date.now();
  return getDb().transaction(() => {
    const loaded = loadTaskReminder(input.assignmentId);
    if (!loaded || loaded.task.status !== "open" || loaded.assignment.status !== "open") return null;
    const policy = effectiveTaskReminderPolicy(
      loaded.assignment.reminderPolicyOverride ?? undefined,
      loaded.defaultPolicy,
    );
    if (!isRecurringTaskReminder(policy) || loaded.task.dueAt == null) return null;
    const next = nextTaskReminderAt({
      policy,
      dueAt: new Date(loaded.task.dueAt),
      after: new Date(input.scheduledFor),
      now: new Date(now),
    });
    if (!next) return null;
    const bumped = bumpAssignmentRevision(loaded.assignment.id, now);
    return insertOutboxEvent({
      type: "task.assignment_reminder_requested",
      aggregateId: bumped.id,
      expectedVersion: bumped.reminderRevision,
      payload: {
        assignmentId: bumped.id,
        reminderVersion: bumped.reminderRevision,
        scheduledFor: next.getTime(),
      },
    });
  })();
}

/** After the T-1d channel+DM lands, queue the T-5h slot with a bumped revision. */
export function enqueueNextDualReminder(input: {
  assignmentId: string;
  sentSlot: DualReminderSlot;
  now?: number;
}): OutboxEvent | null {
  if (input.sentSlot !== "one_day") return null;
  const now = input.now ?? Date.now();
  return getDb().transaction(() => {
    const loaded = loadTaskReminder(input.assignmentId);
    if (!loaded || loaded.task.status !== "open" || loaded.assignment.status !== "open") return null;
    const policy = effectiveTaskReminderPolicy(
      loaded.assignment.reminderPolicyOverride ?? undefined,
      loaded.defaultPolicy,
    );
    if (policy !== "one_day_and_five_hours" || loaded.task.dueAt == null) return null;
    const fiveHours = dualReminderSlots(new Date(loaded.task.dueAt), new Date(now)).find(
      (slot) => slot.slot === "five_hours",
    );
    if (!fiveHours) return null;
    const bumped = bumpAssignmentRevision(loaded.assignment.id, now);
    return insertOutboxEvent({
      type: "task.assignment_reminder_requested",
      aggregateId: bumped.id,
      expectedVersion: bumped.reminderRevision,
      payload: {
        assignmentId: bumped.id,
        reminderVersion: bumped.reminderRevision,
        slot: fiveHours.slot,
        scheduledFor: fiveHours.at.getTime(),
      },
    });
  })();
}
