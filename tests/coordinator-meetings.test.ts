import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getDb } from "../src/storage/db.ts";
import {
  cancelMeeting,
  createScheduledMeeting,
  getMeeting,
} from "../src/storage/coordinator-meetings.ts";
import { countOutboxByType, getOutboxEvent } from "../src/storage/outbox.ts";
import { withTempDb } from "./helpers.ts";

const db = withTempDb();
beforeAll(() => {
  getDb();
});
afterAll(() => db.cleanup());

const START = Date.now() + 2 * 60 * 60_000;

describe("meetings outbox", () => {
  test("confirm/create emits exactly one calendar_sync outbox row", () => {
    const id = crypto.randomUUID();
    const result = createScheduledMeeting({
      id,
      createdByUserId: "creator-1",
      title: "Eboard standup",
      startsAt: START,
      durationMinutes: 30,
      timeZone: "America/New_York",
      channelId: "1001",
      participants: [{ userId: "u-1", displayName: "Sam" }],
    });
    expect(result.outboxEvents).toHaveLength(1);
    expect(result.outboxEvents[0]?.type).toBe("meeting.calendar_sync_requested");
    expect(result.outboxEvents[0]?.aggregateId).toBe(id);
    expect(result.outboxEvents[0]?.expectedVersion).toBe(1);
    expect(countOutboxByType("meeting.calendar_sync_requested", id)).toBe(1);
    expect(getMeeting(id)?.status).toBe("scheduled");
  });

  test("meeting + outbox share a transaction", () => {
    const id = crypto.randomUUID();
    expect(() => {
      getDb().transaction(() => {
        createScheduledMeeting({
          id,
          createdByUserId: "creator-1",
          title: "Rollback meeting",
          startsAt: START + 60_000,
          durationMinutes: 30,
          channelId: "1001",
          participants: [{ userId: "u-1" }],
        });
        throw new Error("rollback");
      })();
    }).toThrow("rollback");
    expect(getMeeting(id)).toBeNull();
    expect(countOutboxByType("meeting.calendar_sync_requested", id)).toBe(0);
  });

  test("cancel emits calendar_cancel type", () => {
    const id = crypto.randomUUID();
    createScheduledMeeting({
      id,
      createdByUserId: "creator-1",
      title: "Cancel me",
      startsAt: START + 120_000,
      durationMinutes: 45,
      channelId: "1001",
      participants: [{ userId: "u-2", displayName: "Riley" }],
    });
    const cancelled = cancelMeeting({ meetingId: id, creatorUserId: "creator-1" });
    expect(cancelled.meeting.status).toBe("cancelled");
    expect(cancelled.outboxEvents).toHaveLength(1);
    expect(cancelled.outboxEvents[0]?.type).toBe("meeting.calendar_cancel_requested");
    expect(getOutboxEvent(cancelled.outboxEvents[0]!.id)?.payload.meetingId).toBe(id);
    expect(countOutboxByType("meeting.calendar_cancel_requested", id)).toBe(1);
  });

  test("non-creator cannot cancel", () => {
    const id = crypto.randomUUID();
    createScheduledMeeting({
      id,
      createdByUserId: "creator-1",
      title: "Stay",
      startsAt: START + 180_000,
      durationMinutes: 15,
      channelId: "1001",
      participants: [{ userId: "u-3" }],
    });
    expect(() => cancelMeeting({ meetingId: id, creatorUserId: "intruder" })).toThrow(
      "Only the meeting creator can cancel it.",
    );
    expect(getMeeting(id)?.status).toBe("scheduled");
  });
});
