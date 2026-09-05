import type { Guild } from "discord.js";
import {
  audienceSelectionsFromMentions,
  expandAudience,
  type ResolvedAssignee,
} from "./audience.ts";
import { MISSING_DUE_REPLY } from "./todo-intent.ts";
import {
  activateTask,
  addTaskAssignments,
  completeTaskAssignment,
  createTaskDraft,
  getTaskAssignments,
  listTasksCreatedBy,
  listTasksForPerson,
  updateTask,
  type TaskAssignmentRow,
  type TaskRow,
} from "../storage/coordinator-tasks.ts";
import type { OutboxEvent } from "../storage/outbox.ts";

export const NL_TODO_REMINDER_POLICY = "one_day_and_five_hours" as const;

/**
 * A role mention expands to every member of that role, and each assignee costs
 * a public channel ping plus a DM on two slots. The NL path is reachable from
 * an ordinary message with no per-author cap, so bound the blast radius here:
 * @Eboard-sized groups sail through, a stray @Members does not.
 */
export const MAX_NL_TODO_ASSIGNEES = 25;

/** Thrown for messages that are safe to echo back to Discord verbatim. */
export class TodoUserError extends Error {}

export interface VisibleTodo {
  task: TaskRow;
  assignment: TaskAssignmentRow | null;
  relation: "assigned" | "created";
}

export function formatTodoDue(dueAt: number | null, timeZone: string): string {
  if (dueAt == null) return "No due date";
  return new Date(dueAt).toLocaleString("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export async function resolveNlAssignees(input: {
  speakerUserId: string;
  speakerDisplayName?: string;
  mentionedUsers: Array<{ id: string; displayName?: string }>;
  mentionedRoleIds: string[];
  guild?: Guild | null;
}): Promise<ResolvedAssignee[]> {
  const others = input.mentionedUsers.filter((user) => user.id !== input.speakerUserId);
  if (others.length === 0 && input.mentionedRoleIds.length === 0) {
    return [
      {
        userId: input.speakerUserId,
        displayName: input.speakerDisplayName?.trim() || input.speakerUserId,
      },
    ];
  }
  return expandAudience({
    selections: audienceSelectionsFromMentions({
      users: others,
      roleIds: input.mentionedRoleIds,
    }),
    guild: input.guild,
  });
}

export function createAndActivateTodo(input: {
  createdByUserId: string;
  title: string;
  dueAt: number;
  channelId: string;
  assignees: ResolvedAssignee[];
  timeZone?: string;
  now?: number;
}): { task: TaskRow; assignments: TaskAssignmentRow[]; outboxEvents: OutboxEvent[] } {
  if (!Number.isFinite(input.dueAt)) throw new TodoUserError(MISSING_DUE_REPLY);
  if (input.assignees.length === 0) {
    throw new TodoUserError("Add at least one assignee before creating this task.");
  }
  if (input.assignees.length > MAX_NL_TODO_ASSIGNEES) {
    throw new TodoUserError(
      `That would assign ${input.assignees.length} people. Mention up to ${MAX_NL_TODO_ASSIGNEES}, or use \`/task\` for a larger group.`,
    );
  }
  const draft = createTaskDraft({
    createdByUserId: input.createdByUserId,
    title: input.title,
    timeZone: input.timeZone,
    channelId: input.channelId,
    now: input.now,
  });
  addTaskAssignments({
    taskId: draft.id,
    creatorUserId: input.createdByUserId,
    assignees: input.assignees.map((assignee) => ({
      userId: assignee.userId,
      displayName: assignee.displayName,
    })),
    reminderPolicyOverride: NL_TODO_REMINDER_POLICY,
    now: input.now,
  });
  updateTask({
    taskId: draft.id,
    creatorUserId: input.createdByUserId,
    dueAt: input.dueAt,
    now: input.now,
  });
  const activated = activateTask({
    taskId: draft.id,
    creatorUserId: input.createdByUserId,
    now: input.now,
  });
  return {
    task: activated.task,
    assignments: getTaskAssignments(activated.task.id),
    outboxEvents: activated.outboxEvents,
  };
}

export function listVisibleTodos(userId: string): VisibleTodo[] {
  const byTask = new Map<string, VisibleTodo>();
  for (const entry of listTasksForPerson({ userId })) {
    if (entry.task.status !== "open") continue;
    byTask.set(entry.task.id, { task: entry.task, assignment: entry.assignment, relation: "assigned" });
  }
  for (const entry of listTasksCreatedBy({ userId })) {
    if (byTask.has(entry.task.id)) continue;
    byTask.set(entry.task.id, { task: entry.task, assignment: null, relation: "created" });
  }
  return [...byTask.values()].sort(
    (a, b) => (a.task.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.task.dueAt ?? Number.MAX_SAFE_INTEGER),
  );
}

export function formatVisibleTodoList(userId: string): string {
  const items = listVisibleTodos(userId);
  if (items.length === 0) return "You have no open todos assigned to you or created by you.";
  return items
    .map((item) => {
      const due = formatTodoDue(item.task.dueAt, item.task.timeZone);
      const tag = item.relation === "assigned" ? "assigned" : "created";
      return `• ${item.task.title} — due ${due} (${tag})`;
    })
    .join("\n");
}

export function completeVisibleTodo(
  userId: string,
  titleFragment?: string,
): { ok: true; task: TaskRow } | { ok: false; reason: "none" | "ambiguous"; detail: string } {
  const assigned = listTasksForPerson({ userId }).filter(
    (entry) => entry.assignment.status === "open" && entry.task.status === "open",
  );
  const needle = titleFragment?.trim().toLowerCase();
  const matches = needle
    ? assigned.filter((entry) => entry.task.title.toLowerCase().includes(needle))
    : assigned;
  if (matches.length === 0) {
    return {
      ok: false,
      reason: "none",
      detail: needle
        ? `I couldn't find an open todo of yours matching “${titleFragment}”.`
        : "You have no open todos to mark done.",
    };
  }
  // A bare "done" never picks for you -- closing the wrong todo is silent and
  // hard to notice -- so a targetless request always asks, even at one match.
  if (matches.length > 1 || !needle) {
    const lines = matches
      .map((entry) => `• ${entry.task.title} — due ${formatTodoDue(entry.task.dueAt, entry.task.timeZone)}`)
      .join("\n");
    return {
      ok: false,
      reason: "ambiguous",
      detail: `Which one? Reply \`mark <title> done\`:\n${lines}`,
    };
  }
  const entry = matches[0]!;
  completeTaskAssignment({ assignmentId: entry.assignment.id, userId });
  return { ok: true, task: entry.task };
}
