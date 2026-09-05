import { authorizeV1 } from "./auth.ts";
import { peekClient } from "../bot/client.ts";
import { extractTodoMentions } from "../coordinator/todo-intent.ts";
import { createAndActivateTodo, listVisibleTodos } from "../coordinator/todo-nl.ts";
import { publishOutboxEvents } from "../coordinator/publisher.ts";
import { getJob, type JobRow } from "../storage/jobs.ts";
import { completeTaskAssignment, getTask, getTaskAssignments } from "../storage/coordinator-tasks.ts";
import type { Scope } from "../context/types.ts";

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (!text.trim()) return {};
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function jobIdFrom(req: Request, url: URL, body: Record<string, unknown> | null): string | null {
  const header = req.headers.get("x-morpheus-job")?.trim();
  if (header) return header;
  const query = url.searchParams.get("job_id")?.trim();
  if (query) return query;
  const fromBody = typeof body?.job_id === "string" ? body.job_id.trim() : "";
  return fromBody || null;
}

function actorFromClaimedJob(
  jobId: string,
  scope: Scope,
  workerId: string,
): { ok: true; job: JobRow } | { ok: false; status: number; error: string } {
  const job = getJob(jobId);
  if (!job) return { ok: false, status: 404, error: "job not found" };
  if (!scope.visible.has(job.namespace)) return { ok: false, status: 403, error: "workspace mismatch" };
  if (job.status !== "claimed") return { ok: false, status: 403, error: "job not claimed" };
  if (!job.claimed_by || job.claimed_by !== workerId) {
    return { ok: false, status: 403, error: "claimed_by mismatch" };
  }
  return { ok: true, job };
}

function allowedAssigneeIds(job: JobRow, requested: string[]): string[] {
  // Pass the real bot id so the bot's own snowflake is not a legal assignee.
  const mentions = extractTodoMentions(job.content, peekClient()?.user?.id ?? "");
  const allowed = new Set<string>([job.author_id, ...mentions.userIds]);
  const unique = [...new Set(requested.filter((id) => /^\d+$/.test(id) || id === job.author_id))];
  return unique.filter((id) => allowed.has(id));
}

function serializeVisible(userId: string) {
  return listVisibleTodos(userId).map((item) => ({
    id: item.task.id,
    title: item.task.title,
    due_at: item.task.dueAt,
    time_zone: item.task.timeZone,
    status: item.task.status,
    relation: item.relation,
    assignment_id: item.assignment?.id ?? null,
    assignment_status: item.assignment?.status ?? null,
  }));
}

export async function handleTasksRequest(req: Request, url: URL): Promise<Response> {
  const auth = authorizeV1(req);
  if (!auth.ok) return json(auth.status, { error: auth.error });
  const workerId = `grok-${auth.scope.root}`;
  const method = req.method.toUpperCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] !== "v1" || parts[1] !== "tasks") return json(404, { error: "not found" });

  const body = method === "GET" ? {} : await readJson(req);
  if (body === null) return json(400, { error: "invalid json" });
  if (typeof body.user_id === "string") {
    // Actor is the claimed job's author. A spoofed user_id is never honored.
    delete body.user_id;
  }

  const jobId = jobIdFrom(req, url, body);
  if (!jobId) return json(403, { error: "claimed job required" });
  const actor = actorFromClaimedJob(jobId, auth.scope, workerId);
  if (!actor.ok) return json(actor.status, { error: actor.error });
  const authorId = actor.job.author_id;

  if (method === "GET" && parts.length === 2) {
    return json(200, { tasks: serializeVisible(authorId) });
  }

  if (method === "POST" && parts.length === 2) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const dueAt = typeof body.due_at === "number" ? body.due_at : Number.NaN;
    if (!title) return json(400, { error: "title is required" });
    if (!Number.isFinite(dueAt)) return json(400, { error: "due_at is required" });
    const requested = Array.isArray(body.assignee_ids)
      ? body.assignee_ids.filter((id): id is string => typeof id === "string")
      : [];
    // Silently falling back to the author would hide a worker asking for
    // someone who was never mentioned; say no instead.
    const filtered = requested.length > 0 ? allowedAssigneeIds(actor.job, requested) : [];
    if (requested.length > 0 && filtered.length === 0) {
      return json(403, { error: "assignee_ids must be the author or a user mentioned in the trigger" });
    }
    const assigneeIds = filtered.length > 0 ? filtered : [authorId];
    const created = createAndActivateTodo({
      createdByUserId: authorId,
      title,
      dueAt,
      channelId: actor.job.discord_channel_id,
      assignees: assigneeIds.map((id) => ({ userId: id, displayName: id })),
    });
    await publishOutboxEvents(created.outboxEvents);
    return json(200, {
      task: {
        id: created.task.id,
        title: created.task.title,
        due_at: created.task.dueAt,
        status: created.task.status,
      },
      assignments: created.assignments.map((row) => ({ user_id: row.userId, id: row.id })),
    });
  }

  if (method === "POST" && parts.length === 4 && parts[3] === "complete") {
    const taskId = parts[2] ?? "";
    const task = getTask(taskId);
    if (!task) return json(404, { error: "not found" });
    const visible = listVisibleTodos(authorId).some((item) => item.task.id === taskId);
    if (!visible) return json(404, { error: "not found" });
    const assignment = getTaskAssignments(taskId).find((row) => row.userId === authorId && row.status === "open");
    if (!assignment) return json(403, { error: "not assigned" });
    completeTaskAssignment({ assignmentId: assignment.id, userId: authorId });
    return json(200, { ok: true, task_id: task.id });
  }

  return json(404, { error: "not found" });
}
