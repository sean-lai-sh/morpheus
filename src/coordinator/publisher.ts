import { logger } from "../logger.ts";
import { dispatchEnqueuedJob } from "../bot/enqueue.ts";
import { peekClient } from "../bot/client.ts";
import { getMeeting, getMeetingParticipants } from "../storage/coordinator-meetings.ts";
import {
  canSendTaskReminder,
  enqueueNextRecurringReminder,
  loadTaskReminder,
  recordTaskReminderDelivery,
} from "../storage/coordinator-tasks.ts";
import { enqueueJob, getJobByDiscordMessageId } from "../storage/jobs.ts";
import {
  listPendingOutbox,
  markOutboxDispatched,
  markOutboxFailed,
  recordOutboxDispatchFailure,
  type OutboxEvent,
} from "../storage/outbox.ts";
import {
  effectiveTaskReminderPolicy,
  nextTaskReminderAt,
} from "./reminders.ts";
import {
  buildCalendarJobPack,
  coordinatorJobMessageId,
  namespaceForMeetingChannel,
  redactCalendarJobContent,
  serializeCalendarJobPack,
} from "./calendar-job.ts";
import {
  DEFERRING_SKIPS,
  tryMiniCalendarCancel,
  tryMiniCalendarSync,
  type FastPathOutcome,
} from "./calendar-fast-path.ts";
import { applyCalendarSyncResult, type MeetingRow } from "../storage/coordinator-meetings.ts";

export const OUTBOX_HANDOFF_TIMEOUT_MS = 1_500;

export type OutboxDispatchStatus = "accepted" | "deferred" | "unsupported";

export interface OutboxDispatchOutcome {
  outboxId: string;
  status: OutboxDispatchStatus;
}

export interface ReminderDmSender {
  send(input: {
    userId: string;
    title: string;
    body: string;
    assignmentId: string;
  }): Promise<void>;
}

const HANDOFF_TIMEOUT_MS = OUTBOX_HANDOFF_TIMEOUT_MS;

/**
 * Outbox rows currently being dispatched by this process.
 *
 * The `/meet` handler publishes a row immediately and the 60s sweeper re-reads
 * every `pending` row, so the two overlap whenever Google is slow; without a
 * lease the second dispatcher would POST again while the first is mid-flight.
 * (The deterministic event id turns that into a 409, not a duplicate event, but
 * it would still mail the guest list twice.) One process owns the SQLite file,
 * so an in-memory set is the whole lease.
 */
const inFlightOutbox = new Set<string>();

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`outbox handoff exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logCorrelate(event: OutboxEvent, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const payload = event.payload;
  return {
    outboxId: event.id,
    type: event.type,
    aggregateId: event.aggregateId,
    version: event.expectedVersion,
    meetingId: typeof payload.meetingId === "string" ? payload.meetingId : undefined,
    assignmentId: typeof payload.assignmentId === "string" ? payload.assignmentId : undefined,
    ...extra,
  };
}

export async function defaultReminderDmSender(
  input: { userId: string; title: string; body: string; assignmentId: string },
): Promise<void> {
  const client = peekClient();
  if (!client?.isReady()) throw new Error("discord-client-unavailable");
  const user = await client.users.fetch(input.userId);
  await user.send({
    content: `**${input.title}**\n${input.body}`,
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            custom_id: `task-complete:${input.assignmentId}`,
            label: "Mark done",
          },
          {
            type: 2,
            style: 2,
            custom_id: `task-reminder:${input.assignmentId}`,
            label: "Reminder settings",
          },
        ],
      },
    ],
  });
}

async function dispatchTaskReminder(
  event: OutboxEvent,
  now: number,
  sendDm: ReminderDmSender["send"],
): Promise<OutboxDispatchStatus> {
  const assignmentId = String(event.payload.assignmentId ?? event.aggregateId);
  const reminderVersion = Number(event.payload.reminderVersion ?? event.expectedVersion);
  const loaded = loadTaskReminder(assignmentId);
  if (!canSendTaskReminder(loaded, reminderVersion)) {
    logger.info(logCorrelate(event, { reason: "assignment_not_open_or_stale" }), "outbox.publish.skipped");
    markOutboxDispatched(event.id, now);
    return "accepted";
  }
  const policy = effectiveTaskReminderPolicy(
    loaded.assignment.reminderPolicyOverride ?? undefined,
    loaded.defaultPolicy,
  );
  const scheduledFor = event.payload.scheduledFor
    ? new Date(Number(event.payload.scheduledFor))
    : nextTaskReminderAt({
        policy,
        dueAt: loaded.task.dueAt != null ? new Date(loaded.task.dueAt) : undefined,
        now: new Date(now),
      });
  if (!scheduledFor || Number.isNaN(scheduledFor.valueOf())) {
    logger.info(logCorrelate(event, { reason: "no_due_date_or_policy_disabled" }), "outbox.publish.skipped");
    markOutboxDispatched(event.id, now);
    return "accepted";
  }
  if (scheduledFor.getTime() > now) {
    logger.debug(
      logCorrelate(event, { scheduledFor: scheduledFor.toISOString() }),
      "outbox.publish.deferred_until",
    );
    return "deferred";
  }

  const due = loaded.task.dueAt
    ? new Date(loaded.task.dueAt).toLocaleString("en-US", {
        timeZone: loaded.task.timeZone,
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;
  const body = `${loaded.task.description ? `${loaded.task.description}\n` : ""}${due ? `Due: ${due}` : ""}\nYou can update your personal reminder setting below.`.trim();

  try {
    await withDeadline(
      sendDm({
        userId: loaded.assignment.userId,
        title: loaded.task.title,
        body,
        assignmentId,
      }),
      HANDOFF_TIMEOUT_MS,
    );
    recordTaskReminderDelivery({
      assignmentId,
      reminderRevision: reminderVersion,
      scheduledFor: scheduledFor.getTime(),
      status: "sent",
      now,
    });
    markOutboxDispatched(event.id, now);
    logger.info(logCorrelate(event, { scheduledFor: scheduledFor.toISOString() }), "outbox.publish.accepted");
    const next = enqueueNextRecurringReminder({
      assignmentId,
      scheduledFor: scheduledFor.getTime(),
      now,
    });
    if (next) {
      logger.info(
        { assignmentId, outboxId: next.id, reminderVersion: next.expectedVersion },
        "task.reminder.next_queued",
      );
    }
    return "accepted";
  } catch (error) {
    const message = errorMessage(error);
    recordTaskReminderDelivery({
      assignmentId,
      reminderRevision: reminderVersion,
      scheduledFor: scheduledFor.getTime(),
      status: "failed",
      error: message.slice(0, 500),
      now,
    });
    const failure = recordOutboxDispatchFailure(event.id, message, now);
    logger.error(
      logCorrelate(event, { err: message, attempts: failure.attempts }),
      failure.deadLettered ? "outbox.publish.dead_lettered" : "outbox.publish.deferred",
    );
    return "deferred";
  }
}

export interface CalendarJobEnqueue {
  (input: {
    discordMessageId: string;
    discordChannelId: string;
    authorId: string;
    namespace: string;
    content: string;
    now: number;
  }): { duplicate: boolean };
}

export interface CalendarJobDispatch {
  (input: { discordMessageId: string }): Promise<boolean>;
}

export interface CalendarFastPath {
  (input: {
    kind: "meeting.calendar_sync" | "meeting.calendar_cancel";
    meeting: MeetingRow;
    participantIds: string[];
  }): Promise<FastPathOutcome>;
}

async function dispatchCalendarJob(
  event: OutboxEvent,
  now: number,
  opts: {
    enqueue?: CalendarJobEnqueue;
    dispatch?: CalendarJobDispatch;
    /** Test seam. Omitted in production so the real credential check runs. */
    fastPath?: CalendarFastPath;
  } = {},
): Promise<OutboxDispatchStatus> {
  const meetingId = String(event.payload.meetingId ?? event.aggregateId);
  const version = Number(event.payload.version ?? event.expectedVersion);
  const meeting = getMeeting(meetingId);
  if (!meeting) {
    markOutboxFailed(event.id, "meeting_not_found", now);
    logger.warn(logCorrelate(event, { reason: "meeting_not_found" }), "outbox.publish.unsupported");
    return "unsupported";
  }
  if (meeting.version !== version && event.type === "meeting.calendar_sync_requested") {
    markOutboxDispatched(event.id, now);
    logger.info(logCorrelate(event, { reason: "stale_version" }), "outbox.publish.skipped");
    return "accepted";
  }

  const kind =
    event.type === "meeting.calendar_cancel_requested" ? "meeting.calendar_cancel" : "meeting.calendar_sync";
  const participantIds = getMeetingParticipants(meeting.id).map((person) => person.userId);

  // Deterministic path first. The Mini holds `roster_bindings`, so it is the
  // only process that can turn these snowflakes into addresses -- Grok cannot
  // query them, which is why the remote pack carries only counts and ids. Any
  // skip falls through to the Grok handoff below, so a miss costs latency, not
  // the meeting.
  const runFastPath =
    opts.fastPath ??
    ((input) =>
      input.kind === "meeting.calendar_cancel"
        ? tryMiniCalendarCancel({
            meetingId: input.meeting.id,
            calendarEventId: input.meeting.calendarEventId,
          })
        : tryMiniCalendarSync({
            meetingId: input.meeting.id,
            title: input.meeting.title,
            startsAt: new Date(input.meeting.startsAt).toISOString(),
            endsAt: new Date(input.meeting.endsAt).toISOString(),
            timeZone: input.meeting.timeZone,
            notes: input.meeting.notes,
            location: input.meeting.location,
            audience: input.meeting.audienceKind ?? "picked",
            participantIds: input.participantIds,
            calendarEventId: input.meeting.calendarEventId,
          }));

  const fast = await runFastPath({ kind, meeting, participantIds });
  if (fast.ok) {
    if (kind === "meeting.calendar_sync") {
      const applied = applyCalendarSyncResult({
        meetingId: meeting.id,
        version,
        calendarEventId: fast.calendarEventId,
        meetLink: fast.meetLink,
        now,
      });
      if (!applied.applied && applied.reason === "not_scheduled" && fast.calendarEventId) {
        // The organizer cancelled while the insert was in flight. The cancel
        // row snapshotted `calendarEventId: null`, so nothing else will ever
        // delete this event; do it now, while we still hold the id.
        logger.warn(
          logCorrelate(event, { meetingId, reason: applied.reason }),
          "calendar fast path: meeting cancelled mid-insert; removing the event",
        );
        const undo = await runFastPath({
          kind: "meeting.calendar_cancel",
          meeting: { ...meeting, calendarEventId: fast.calendarEventId },
          participantIds,
        });
        if (!undo.ok) {
          const failure = recordOutboxDispatchFailure(event.id, `orphan-event:${undo.skip}`, now);
          logger.error(
            logCorrelate(event, { meetingId, skip: undo.skip, attempts: failure.attempts }),
            failure.deadLettered ? "outbox.publish.dead_lettered" : "outbox.publish.deferred",
          );
          return "deferred";
        }
      }
    }
    markOutboxDispatched(event.id, now);
    logger.info(
      logCorrelate(event, {
        meetingId,
        attendees: fast.attendeeCount,
        unresolved: fast.unresolvedCount ?? 0,
        path: "mini",
      }),
      "outbox.publish.accepted",
    );
    return "accepted";
  }
  if (DEFERRING_SKIPS.has(fast.skip)) {
    // The event may exist on Google's side (or provably does, minus its Meet).
    // Grok would create a second one; keep the row pending so the sweeper
    // retries the Mini, which converges on the same deterministic event id.
    if (kind === "meeting.calendar_sync" && fast.calendarEventId) {
      applyCalendarSyncResult({ meetingId: meeting.id, version, calendarEventId: fast.calendarEventId, now });
    }
    const failure = recordOutboxDispatchFailure(event.id, `calendar fast path: ${fast.skip}`, now);
    logger.warn(
      logCorrelate(event, { meetingId, skip: fast.skip, attempts: failure.attempts }),
      failure.deadLettered ? "outbox.publish.dead_lettered" : "outbox.publish.deferred",
    );
    return "deferred";
  }
  logger.info(
    logCorrelate(event, { meetingId, skip: fast.skip }),
    "calendar fast path skipped; handing off to Grok",
  );

  const pack = buildCalendarJobPack({
    kind,
    meeting,
    outboxId: event.id,
    version,
    participantCount: participantIds.length,
    participantIds,
  });
  const content = redactCalendarJobContent(serializeCalendarJobPack(pack));
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(content.replace(/hello@techatnyu\.org/gi, ""))) {
    markOutboxFailed(event.id, "refused-email-in-payload", now);
    logger.error(logCorrelate(event), "outbox.publish.refused_email_in_payload");
    return "unsupported";
  }
  if (/discord_bot_token|DISCORD_BOT_TOKEN/i.test(content)) {
    markOutboxFailed(event.id, "refused-discord-token-in-payload", now);
    logger.error(logCorrelate(event), "outbox.publish.refused_token_in_payload");
    return "unsupported";
  }

  const namespace = namespaceForMeetingChannel(meeting.channelId);
  const channelId = meeting.channelId;
  if (!namespace || !channelId) {
    const failure = recordOutboxDispatchFailure(event.id, "unknown-namespace", now);
    if (failure.deadLettered) {
      logger.error(
        logCorrelate(event, { reason: "unknown-namespace", attempts: failure.attempts }),
        "outbox.publish.dead_lettered",
      );
    } else {
      logger.warn(
        logCorrelate(event, { reason: "unknown-namespace", attempts: failure.attempts }),
        "outbox.publish.deferred",
      );
    }
    return "deferred";
  }

  const discordMessageId = coordinatorJobMessageId(event.id);
  const enqueue =
    opts.enqueue ??
    ((input) => {
      const result = enqueueJob(
        {
          discordMessageId: input.discordMessageId,
          discordChannelId: input.discordChannelId,
          discordThreadId: null,
          authorId: input.authorId,
          namespace: input.namespace,
          content: input.content,
          // Calendar handoffs need Grok's Google tooling, which the SDK
          // sibling does not have; the background lane is never routed there.
          // It also keeps these machine-issued jobs off the meeting creator's
          // interactive cap, which is lane-scoped.
          lane: "background",
        },
        input.now,
      );
      return { duplicate: result.duplicate };
    });
  const dispatch =
    opts.dispatch ??
    (async (input) => {
      const job = getJobByDiscordMessageId(input.discordMessageId);
      if (!job) return false;
      const result = await dispatchEnqueuedJob(job, { lane: "background" });
      return result.dispatched;
    });

  try {
    await withDeadline(
      (async () => {
        enqueue({
          discordMessageId,
          discordChannelId: channelId,
          authorId: meeting.createdByUserId,
          namespace,
          content,
          now,
        });
        const dispatched = await dispatch({ discordMessageId });
        if (!dispatched) throw new Error("calendar job dispatch skipped or failed");
      })(),
      HANDOFF_TIMEOUT_MS,
    );
    markOutboxDispatched(event.id, now);
    logger.info(logCorrelate(event, { meetingId }), "outbox.publish.accepted");
    return "accepted";
  } catch (error) {
    const message = errorMessage(error);
    const failure = recordOutboxDispatchFailure(event.id, message, now);
    logger.error(
      logCorrelate(event, { err: message, meetingId, attempts: failure.attempts }),
      failure.deadLettered ? "outbox.publish.dead_lettered" : "outbox.publish.deferred",
    );
    return "deferred";
  }
}

export async function publishOutboxEvent(
  event: OutboxEvent,
  opts: {
    now?: number;
    sendDm?: ReminderDmSender["send"];
    enqueueCalendar?: CalendarJobEnqueue;
    dispatchCalendar?: CalendarJobDispatch;
    /** Test seam for the Mini-side Calendar insert; see `dispatchCalendarJob`. */
    calendarFastPath?: CalendarFastPath;
  } = {},
): Promise<OutboxDispatchOutcome> {
  const now = opts.now ?? Date.now();
  logger.info(logCorrelate(event), "outbox.publish.started");
  try {
    if (event.type === "task.assignment_reminder_requested") {
      const status = await dispatchTaskReminder(event, now, opts.sendDm ?? defaultReminderDmSender);
      return { outboxId: event.id, status };
    }
    if (
      event.type === "meeting.calendar_sync_requested" ||
      event.type === "meeting.calendar_cancel_requested"
    ) {
      if (inFlightOutbox.has(event.id)) {
        logger.info(logCorrelate(event), "outbox.publish.already_in_flight");
        return { outboxId: event.id, status: "deferred" };
      }
      inFlightOutbox.add(event.id);
      try {
        const status = await dispatchCalendarJob(event, now, {
          enqueue: opts.enqueueCalendar,
          dispatch: opts.dispatchCalendar,
          fastPath: opts.calendarFastPath,
        });
        return { outboxId: event.id, status };
      } finally {
        inFlightOutbox.delete(event.id);
      }
    }
    markOutboxFailed(event.id, `Unsupported outbox type: ${event.type}`, now);
    logger.warn(logCorrelate(event), "outbox.publish.unsupported");
    return { outboxId: event.id, status: "unsupported" };
  } catch (error) {
    const message = errorMessage(error);
    const failure = recordOutboxDispatchFailure(event.id, message, now);
    logger.error(
      logCorrelate(event, { err: message, attempts: failure.attempts }),
      failure.deadLettered ? "outbox.publish.dead_lettered" : "outbox.publish.deferred",
    );
    return { outboxId: event.id, status: "deferred" };
  }
}

export async function publishOutboxEvents(
  events: OutboxEvent[],
  opts?: Parameters<typeof publishOutboxEvent>[1],
): Promise<OutboxDispatchOutcome[]> {
  return Promise.all(events.map((event) => publishOutboxEvent(event, opts)));
}

export async function recoverPendingOutbox(
  limit = 50,
  opts?: Parameters<typeof publishOutboxEvent>[1],
): Promise<OutboxDispatchOutcome[]> {
  const events = listPendingOutbox(limit);
  logger.info({ pendingCount: events.length }, "outbox.recovery.loaded");
  return publishOutboxEvents(events, opts);
}

