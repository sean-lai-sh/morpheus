import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EBOARD_ROLE_ID } from "../src/coordinator/roster-map.ts";
import { MISSING_DUE_REPLY, parseTodoIntent } from "../src/coordinator/todo-intent.ts";
import {
  completeVisibleTodo,
  createAndActivateTodo,
  listVisibleTodos,
  MAX_NL_TODO_ASSIGNEES,
  NL_TODO_REMINDER_POLICY,
  TodoUserError,
} from "../src/coordinator/todo-nl.ts";
import { tryHandleTodoMention } from "../src/bot/todo-mention.ts";
import { tryEnqueueJob, type JobCandidate } from "../src/bot/enqueue.ts";
import { publishOutboxEvent } from "../src/coordinator/publisher.ts";
import {
  activateTask,
  addTaskAssignments,
  cancelTask,
  createTaskDraft,
  getTask,
  getTaskAssignments,
  setTaskAssignmentReminderOverride,
  updateTask,
} from "../src/storage/coordinator-tasks.ts";
import { listPendingOutbox } from "../src/storage/outbox.ts";
import { claimJob, enqueueJob, getJobByDiscordMessageId } from "../src/storage/jobs.ts";
import { handleHttpRequest } from "../src/http/health.ts";
import { withTempDb } from "./helpers.ts";
import { EBOARD, EBOARD_TOKEN, SPONSORS, withWorkspaceConfig } from "./jobs-fixture.ts";

const BOT = "bot-1";
const ROLE = "role-eboard";
const db = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;

beforeAll(() => {
  cfg = withWorkspaceConfig();
});

afterAll(() => {
  cfg.cleanup();
  db.cleanup();
});

const NOW = Date.parse("2026-09-04T16:00:00Z");

function candidate(over: Partial<JobCandidate> & { discordMessageId: string; content: string }): JobCandidate {
  return {
    discordChannelId: SPONSORS,
    discordThreadId: null,
    parentChannelId: null,
    authorId: "111",
    authorIsBot: false,
    authorRoleIds: [ROLE],
    mentionedBot: true,
    replyToBot: false,
    source: "mention",
    ...over,
  };
}

describe("todo intent", () => {
  test("add with by-due parses title and instant", () => {
    const intent = parseTodoIntent(`<@${BOT}> add a todo review the deck by friday 2pm`, {
      botUserId: BOT,
      now: NOW,
    });
    expect(intent.kind).toBe("add");
    if (intent.kind !== "add") return;
    expect(intent.title).toBe("review the deck");
    expect(intent.dueAt).toBeGreaterThan(NOW);
  });

  test("add without a due is missing_due, not unclear", () => {
    const intent = parseTodoIntent(`<@${BOT}> add a todo review the deck`, { botUserId: BOT, now: NOW });
    expect(intent.kind).toBe("missing_due");
    if (intent.kind !== "missing_due") return;
    expect(intent.title).toBe("review the deck");
    expect(intent.dueError).toContain("friday 2pm");
  });

  test("unparseable due is missing_due", () => {
    const intent = parseTodoIntent(`<@${BOT}> add a todo review the deck by friday 3`, {
      botUserId: BOT,
      now: NOW,
    });
    expect(intent.kind).toBe("missing_due");
  });

  test("the word eboard is not an add, and list/done match", () => {
    expect(parseTodoIntent(`<@${BOT}> what did we decide about eboard tasks`, { botUserId: BOT }).kind).toBe(
      "unclear",
    );
    expect(parseTodoIntent(`<@${BOT}> what's on my list`, { botUserId: BOT }).kind).toBe("list");
    expect(parseTodoIntent(`<@${BOT}> mark receipts done`, { botUserId: BOT })).toEqual({
      kind: "done",
      titleFragment: "receipts",
    });
  });

  test("an agent request that opens with complete/finish is not a done intent", () => {
    for (const text of [
      `<@${BOT}> complete the migration checklist for me`,
      `<@${BOT}> finish the draft agenda`,
      `<@${BOT}> completed the thing already`,
    ]) {
      expect(parseTodoIntent(text, { botUserId: BOT, now: NOW }).kind).toBe("unclear");
    }
    expect(parseTodoIntent(`<@${BOT}> complete task snacks`, { botUserId: BOT, now: NOW })).toEqual({
      kind: "done",
      titleFragment: "snacks",
    });
  });

  test("a question with no due date falls through instead of demanding one", () => {
    expect(
      parseTodoIntent(`<@${BOT}> can you create a task list for the wiki?`, { botUserId: BOT, now: NOW }).kind,
    ).toBe("unclear");
  });

  test("mid-sentence 'create a task' is unclear, not an add", () => {
    expect(
      parseTodoIntent(`<@${BOT}> how do I create a task in Asana by friday 2pm`, { botUserId: BOT, now: NOW })
        .kind,
    ).toBe("unclear");
  });

  test("can you add a todo at the start still adds and strips the lead-in", () => {
    const intent = parseTodoIntent(`<@${BOT}> can you add a todo ship shirts by friday 2pm`, {
      botUserId: BOT,
      now: NOW,
    });
    expect(intent.kind).toBe("add");
    if (intent.kind !== "add") return;
    expect(intent.title).toBe("ship shirts");
  });

  test("role snowflake is ignored by the parser body", () => {
    const intent = parseTodoIntent(
      `<@${BOT}> add a todo ping sponsors <@&${EBOARD_ROLE_ID}> by tomorrow 3:30pm`,
      { botUserId: BOT, now: NOW },
    );
    expect(intent.kind).toBe("add");
    if (intent.kind !== "add") return;
    expect(intent.title).toBe("ping sponsors");
  });
});

describe("todo apply + visibility", () => {
  test("defaults to the speaker and pins the dual reminder policy", () => {
    const dueAt = NOW + 3 * 24 * 60 * 60_000;
    const created = createAndActivateTodo({
      createdByUserId: "111",
      title: "File receipts",
      dueAt,
      channelId: SPONSORS,
      assignees: [{ userId: "111", displayName: "Sam" }],
      now: NOW,
    });
    expect(created.task.status).toBe("open");
    expect(created.task.dueAt).toBe(dueAt);
    expect(created.assignments).toHaveLength(1);
    expect(created.assignments[0]?.userId).toBe("111");
    expect(created.assignments[0]?.reminderPolicyOverride).toBe(NL_TODO_REMINDER_POLICY);
    expect(created.assignments[0]?.channelReminder).toBe(true);
    expect(created.outboxEvents).toHaveLength(1);
    expect(created.outboxEvents[0]?.payload.slot).toBe("one_day");
    expect(listVisibleTodos("111").map((row) => row.task.title)).toContain("File receipts");
    expect(listVisibleTodos("999")).toEqual([]);
  });

  test("creator sees a task they are not assigned to; they cannot complete it", () => {
    const dueAt = NOW + 4 * 24 * 60 * 60_000;
    createAndActivateTodo({
      createdByUserId: "owner-1",
      title: "Ask Ellie",
      dueAt,
      channelId: SPONSORS,
      assignees: [{ userId: "assignee-2", displayName: "Ellie" }],
      now: NOW,
    });
    expect(listVisibleTodos("owner-1").some((row) => row.relation === "created")).toBe(true);
    expect(completeVisibleTodo("owner-1", "Ask Ellie").ok).toBe(false);
  });

  test("complete matches a unique title fragment", () => {
    const dueAt = NOW + 5 * 24 * 60 * 60_000;
    createAndActivateTodo({
      createdByUserId: "333",
      title: "Buy snacks",
      dueAt,
      channelId: SPONSORS,
      assignees: [{ userId: "333", displayName: "Lee" }],
      now: NOW,
    });
    const done = completeVisibleTodo("333", "snacks");
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.task.title).toBe("Buy snacks");
  });

  test("a bare done never picks a todo for you, even at one match", () => {
    const dueAt = NOW + 3 * 24 * 60 * 60_000;
    const created = createAndActivateTodo({
      createdByUserId: "888",
      title: "Only open item",
      dueAt,
      channelId: SPONSORS,
      assignees: [{ userId: "888", displayName: "Ari" }],
      now: NOW,
    });
    const result = completeVisibleTodo("888");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ambiguous");
    expect(getTask(created.task.id)?.status).toBe("open");
  });

  test("refuses an assignee list past the cap instead of mass-pinging", () => {
    const assignees = Array.from({ length: MAX_NL_TODO_ASSIGNEES + 1 }, (_, i) => ({
      userId: `bulk-${i}`,
      displayName: `Bulk ${i}`,
    }));
    expect(() =>
      createAndActivateTodo({
        createdByUserId: "999",
        title: "Everyone read this",
        dueAt: NOW + 2 * 24 * 60 * 60_000,
        channelId: SPONSORS,
        assignees,
        now: NOW,
      }),
    ).toThrow(TodoUserError);
  });

  test("cancelled tasks stay cancelled and are not completable via NL", () => {
    const dueAt = NOW + 6 * 24 * 60 * 60_000;
    const created = createAndActivateTodo({
      createdByUserId: "777",
      title: "Scrubbed retreat",
      dueAt,
      channelId: SPONSORS,
      assignees: [{ userId: "777", displayName: "Mo" }],
      now: NOW,
    });
    cancelTask({ taskId: created.task.id, creatorUserId: "777" });
    expect(listVisibleTodos("777").some((row) => row.task.id === created.task.id)).toBe(false);
    expect(completeVisibleTodo("777", "retreat").ok).toBe(false);
    expect(getTask(created.task.id)?.status).toBe("cancelled");
  });
});

describe("dual reminders + channel post", () => {
  test("schedules T-1d then T-5h and posts channel + DM", async () => {
    const dueAt = Date.parse("2026-09-10T17:00:00Z");
    const created = createAndActivateTodo({
      createdByUserId: "444",
      title: "Submit invoice",
      dueAt,
      channelId: SPONSORS,
      assignees: [{ userId: "444", displayName: "Kai" }],
      now: Date.parse("2026-09-01T12:00:00Z"),
    });
    const first = created.outboxEvents[0]!;
    expect(first.payload.scheduledFor).toBe(Date.parse("2026-09-09T17:00:00Z"));

    const dms: string[] = [];
    const channels: Array<{ channelId: string; userId: string; slot: string }> = [];
    const early = await publishOutboxEvent(first, {
      now: Date.parse("2026-09-01T12:00:00Z"),
      sendDm: async ({ userId }) => {
        dms.push(userId);
      },
      sendChannel: async (input) => {
        channels.push({ channelId: input.channelId, userId: input.userId, slot: input.slot });
      },
    });
    expect(early.status).toBe("deferred");
    expect(dms).toEqual([]);

    const sent = await publishOutboxEvent(first, {
      now: Date.parse("2026-09-09T17:00:00Z"),
      sendDm: async ({ userId }) => {
        dms.push(`dm:${userId}`);
      },
      sendChannel: async (input) => {
        channels.push({ channelId: input.channelId, userId: input.userId, slot: input.slot });
      },
    });
    expect(sent.status).toBe("accepted");
    expect(dms).toContain("dm:444");
    expect(channels).toEqual([{ channelId: SPONSORS, userId: "444", slot: "one_day" }]);

    const fiveHour = listPendingOutbox().find((event) => event.payload.slot === "five_hours");
    expect(fiveHour).toBeDefined();
    expect(fiveHour?.payload.scheduledFor).toBe(Date.parse("2026-09-10T12:00:00Z"));

    const later = await publishOutboxEvent(fiveHour!, {
      now: Date.parse("2026-09-10T12:00:00Z"),
      sendDm: async () => undefined,
      sendChannel: async (input) => {
        channels.push({ channelId: input.channelId, userId: input.userId, slot: input.slot });
      },
    });
    expect(later.status).toBe("accepted");
    expect(channels.some((row) => row.slot === "five_hours")).toBe(true);
  });

  test("a due date inside the window skips the elapsed 1-day slot", () => {
    const now = Date.parse("2026-09-10T11:00:00Z");
    const created = createAndActivateTodo({
      createdByUserId: "1010",
      title: "Due in six hours",
      dueAt: Date.parse("2026-09-10T17:00:00Z"),
      channelId: SPONSORS,
      assignees: [{ userId: "1010", displayName: "Sam" }],
      now,
    });
    const first = created.outboxEvents[0]!;
    // Not a ping labelled "1-day reminder" fired the moment the todo is made.
    expect(first.payload.slot).toBe("five_hours");
    expect(first.payload.scheduledFor).toBe(Date.parse("2026-09-10T12:00:00Z"));
  });

  test("channel failure still accepts when the DM lands", async () => {
    const dueAt = Date.parse("2026-09-10T17:00:00Z");
    const created = createAndActivateTodo({
      createdByUserId: "555",
      title: "Channel down",
      dueAt,
      channelId: SPONSORS,
      assignees: [{ userId: "555", displayName: "Pat" }],
      now: Date.parse("2026-09-09T17:00:00Z"),
    });
    const outcome = await publishOutboxEvent(created.outboxEvents[0]!, {
      now: Date.parse("2026-09-09T17:00:00Z"),
      sendDm: async () => undefined,
      sendChannel: async () => {
        throw new Error("channel-not-text");
      },
    });
    expect(outcome.status).toBe("accepted");
  });

  test("daily_until_done stays DM-only", async () => {
    const dueAt = Date.now() + 60 * 60_000;
    const channels: string[] = [];
    const task = createTaskDraft({ createdByUserId: "666", title: "Daily only", channelId: SPONSORS });
    addTaskAssignments({
      taskId: task.id,
      creatorUserId: "666",
      assignees: [{ userId: "666", displayName: "Daily" }],
    });
    updateTask({ taskId: task.id, creatorUserId: "666", dueAt });
    const { outboxEvents } = activateTask({ taskId: task.id, creatorUserId: "666" });
    const outcome = await publishOutboxEvent(outboxEvents[0]!, {
      now: Date.now() + 2 * 60 * 60_000,
      sendDm: async () => undefined,
      sendChannel: async () => {
        channels.push("nope");
      },
    });
    expect(outcome.status).toBe("accepted");
    expect(channels).toEqual([]);
    expect(getTaskAssignments(task.id)[0]?.reminderPolicyOverride).toBeNull();
    expect(getTaskAssignments(task.id)[0]?.channelReminder).toBe(false);
  });

  test("dual policy without the channel pin stays DM-only", async () => {
    const dueAt = Date.now() + 60 * 60_000;
    const channels: string[] = [];
    const task = createTaskDraft({ createdByUserId: "667", title: "Policy only", channelId: SPONSORS });
    addTaskAssignments({
      taskId: task.id,
      creatorUserId: "667",
      assignees: [{ userId: "667", displayName: "Pat" }],
      reminderPolicyOverride: "one_day_and_five_hours",
    });
    updateTask({ taskId: task.id, creatorUserId: "667", dueAt });
    const { outboxEvents } = activateTask({ taskId: task.id, creatorUserId: "667" });
    const outcome = await publishOutboxEvent(outboxEvents[0]!, {
      now: Date.now() + 2 * 60 * 60_000,
      sendDm: async () => undefined,
      sendChannel: async () => {
        channels.push("nope");
      },
    });
    expect(outcome.status).toBe("accepted");
    expect(channels).toEqual([]);
    expect(getTaskAssignments(task.id)[0]?.channelReminder).toBe(false);
  });

  test("changing a personal reminder override clears the channel pin", async () => {
    const dueAt = Date.now() + 2 * 24 * 60 * 60_000;
    const created = createAndActivateTodo({
      createdByUserId: "668",
      title: "Unpin me",
      dueAt,
      channelId: SPONSORS,
      assignees: [{ userId: "668", displayName: "Lee" }],
    });
    expect(created.assignments[0]?.channelReminder).toBe(true);
    const result = setTaskAssignmentReminderOverride({
      assignmentId: created.assignments[0]!.id,
      userId: "668",
      policy: "one_day_before",
    });
    expect(result.assignment.channelReminder).toBe(false);
    expect(result.assignment.reminderPolicyOverride).toBe("one_day_before");
  });
});

describe("mention hook vs enqueue", () => {
  test("high-confidence add replies and does not enqueue a job", async () => {
    const replies: string[] = [];
    const msg = candidate({
      discordMessageId: "todo-add-1",
      content: `<@${BOT}> add a todo ship shirts by friday 2pm`,
    });
    const handled = await tryHandleTodoMention(msg, {
      botUserId: BOT,
      triggerRoleIds: new Set([ROLE]),
      now: NOW,
      reply: async (text) => {
        replies.push(text);
      },
    });
    expect(handled.handled).toBe(true);
    expect(replies[0]).toContain("ship shirts");
    expect(getJobByDiscordMessageId("todo-add-1")).toBeNull();
  });

  test("a thread mention stores the thread id as the reminder destination", async () => {
    const threadId = "1999888777666";
    await tryHandleTodoMention(
      candidate({
        discordMessageId: "todo-thread-1",
        discordChannelId: threadId,
        discordThreadId: threadId,
        parentChannelId: SPONSORS,
        authorId: "888",
        content: `<@${BOT}> add a todo thread dest by friday 2pm`,
      }),
      {
        botUserId: BOT,
        triggerRoleIds: new Set([ROLE]),
        now: NOW,
        reply: async () => undefined,
      },
    );
    const created = listVisibleTodos("888").find((row) => row.task.title === "thread dest");
    expect(created?.task.channelId).toBe(threadId);
  });

  test("missing due is handled locally and does not enqueue", async () => {
    const replies: string[] = [];
    const handled = await tryHandleTodoMention(
      candidate({
        discordMessageId: "todo-missing-1",
        content: `<@${BOT}> add a todo ship shirts`,
      }),
      {
        botUserId: BOT,
        triggerRoleIds: new Set([ROLE]),
        now: NOW,
        reply: async (text) => {
          replies.push(text);
        },
      },
    );
    expect(handled.handled).toBe(true);
    expect(replies[0]).toContain("friday 2pm");
    expect(replies[0]).toContain(MISSING_DUE_REPLY.slice(0, 10));
    expect(getJobByDiscordMessageId("todo-missing-1")).toBeNull();
  });

  test("unclear research still falls through to enqueue", async () => {
    const handled = await tryHandleTodoMention(
      candidate({
        discordMessageId: "todo-ask-1",
        content: `<@${BOT}> what did we decide about the retreat`,
      }),
      { botUserId: BOT, triggerRoleIds: new Set([ROLE]), now: NOW, reply: async () => undefined },
    );
    expect(handled.handled).toBe(false);
    const job = await tryEnqueueJob(
      candidate({
        discordMessageId: "todo-ask-1",
        content: `<@${BOT}> what did we decide about the retreat`,
      }),
      { triggerRoleIds: new Set([ROLE]), dispatch: false },
    );
    expect(job.job).not.toBeNull();
    expect(job.skipped).toBeUndefined();
  });
});

describe("HTTP /v1/tasks", () => {
  function req(
    method: string,
    path: string,
    opts: { token?: string | null; body?: unknown; jobId?: string } = {},
  ): Request {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? EBOARD_TOKEN}`;
    if (opts.jobId) headers["x-morpheus-job"] = opts.jobId;
    return new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  function claimed(content = "add a todo from grok <@222> by friday 2pm") {
    const queued = enqueueJob({
      discordMessageId: `job-${crypto.randomUUID()}`,
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "111",
      namespace: EBOARD,
      content,
    }).job;
    return claimJob(queued.id, `grok-${EBOARD}`)!;
  }

  test("no claimed job → 403", async () => {
    const res = await handleHttpRequest(req("GET", "/v1/tasks"));
    expect(res.status).toBe(403);
  });

  test("queued job is not enough", async () => {
    const queued = enqueueJob({
      discordMessageId: `job-queued-${crypto.randomUUID()}`,
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "111",
      namespace: EBOARD,
      content: "q",
    }).job;
    const res = await handleHttpRequest(req("GET", "/v1/tasks", { jobId: queued.id }));
    expect(res.status).toBe(403);
  });

  test("create requires due_at and ignores spoofed user_id", async () => {
    const job = claimed();
    const missing = await handleHttpRequest(
      req("POST", "/v1/tasks", { jobId: job.id, body: { title: "No date", user_id: "evil" } }),
    );
    expect(missing.status).toBe(400);

    const dueAt = NOW + 8 * 24 * 60 * 60_000;
    // An assignee who was never mentioned is refused outright rather than
    // quietly swapped for the author: a silent swap makes the worker believe
    // it assigned someone it did not.
    const spoofedAssignee = await handleHttpRequest(
      req("POST", "/v1/tasks", {
        jobId: job.id,
        body: { title: "From HTTP", due_at: dueAt, assignee_ids: ["evil"] },
      }),
    );
    expect(spoofedAssignee.status).toBe(403);

    const created = await handleHttpRequest(
      req("POST", "/v1/tasks", {
        jobId: job.id,
        body: { title: "From HTTP", due_at: dueAt, user_id: "evil" },
      }),
    );
    expect(created.status).toBe(200);
    const body = (await created.json()) as { task: { title: string }; assignments: Array<{ user_id: string }> };
    expect(body.task.title).toBe("From HTTP");
    expect(body.assignments.every((row) => row.user_id === "111")).toBe(true);

    const listed = await handleHttpRequest(req("GET", "/v1/tasks", { jobId: job.id }));
    const list = (await listed.json()) as { tasks: Array<{ title: string }> };
    expect(list.tasks.some((row) => row.title === "From HTTP")).toBe(true);
  });

  test("cannot complete another user's assignment", async () => {
    const dueAt = NOW + 9 * 24 * 60 * 60_000;
    const created = createAndActivateTodo({
      createdByUserId: "other",
      title: "Not yours",
      dueAt,
      channelId: SPONSORS,
      assignees: [{ userId: "other", displayName: "Other" }],
      now: NOW,
    });
    const job = claimed();
    const res = await handleHttpRequest(req("POST", `/v1/tasks/${created.task.id}/complete`, { jobId: job.id }));
    expect(res.status).toBe(404);
  });
});
