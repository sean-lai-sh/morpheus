import { peekClient } from "../bot/client.ts";
import { logger } from "../logger.ts";
import {
  getMeetingParticipants,
  listDueMeetingHourReminders,
  markMeetingHourReminderSent,
} from "../storage/coordinator-meetings.ts";
import { recoverPendingOutbox } from "./publisher.ts";

const SWEEP_MS = 60_000;

let sweepTimer: ReturnType<typeof setInterval> | undefined;

export async function runCoordinatorSweep(now: number = Date.now()): Promise<void> {
  try {
    const outcomes = await recoverPendingOutbox(50, { now });
    const accepted = outcomes.filter((o) => o.status === "accepted").length;
    const deferred = outcomes.filter((o) => o.status === "deferred").length;
    if (outcomes.length > 0) {
      logger.info({ accepted, deferred, pendingCount: outcomes.length }, "outbox.sweep.completed");
    }
  } catch (err) {
    logger.error({ err }, "outbox.sweep.failed");
  }
  try {
    await sendDueMeetingHourReminders(now);
  } catch (err) {
    logger.error({ err }, "meeting.hour_reminder.sweep_failed");
  }
}

export async function sendDueMeetingHourReminders(now: number = Date.now()): Promise<number> {
  const due = listDueMeetingHourReminders(now);
  if (due.length === 0) return 0;
  const client = peekClient();
  let sent = 0;
  for (const meeting of due) {
    const when = new Date(meeting.startsAt).toLocaleString("en-US", {
      timeZone: meeting.timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    });
    const text = `Reminder: **${meeting.title}** starts in one hour.\n${when}${meeting.meetLink ? `\nMeet: ${meeting.meetLink}` : ""}`;
    const participants = getMeetingParticipants(meeting.id);
    if (client?.isReady()) {
      await Promise.allSettled(
        participants.map(async (person) => {
          const user = await client.users.fetch(person.userId);
          await user.send({ content: text });
        }),
      );
    }
    if (markMeetingHourReminderSent(meeting.id, now)) {
      sent += 1;
      logger.info({ meetingId: meeting.id, recipientCount: participants.length }, "meeting.hour_reminder.completed");
    }
  }
  return sent;
}

export function startOutboxSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    void runCoordinatorSweep();
  }, SWEEP_MS);
  sweepTimer.unref?.();
  logger.info({ interval_ms: SWEEP_MS }, "outbox sweeper scheduled");
}

export function stopOutboxSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
}
