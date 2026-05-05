import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import { getDb, resetDbForTest } from "../src/storage/db.ts";
import {
  EVENT_STATUSES,
  type EventStatus,
  InvalidEventStatusError,
  ManualOverrideError,
  VersionConflictError,
  findEvents,
  getEventById,
  getEventByName,
  upsertEvent,
} from "../src/storage/events.ts";

const t = withTempDb();
beforeAll(() => {});
afterAll(() => t.cleanup());

describe("storage/events", () => {
  test("real migration creates the events table and indexes, idempotently", () => {
    // First open runs the real migration in src/storage/db.ts.
    const db = getDb();
    const tableNames = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'`,
      )
      .all()
      .map((r) => r.name);
    expect(tableNames).toEqual(["events"]);

    const indexNames = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'events'
          ORDER BY name`,
      )
      .all()
      .map((r) => r.name);
    expect(indexNames).toContain("events_name_idx");
    expect(indexNames).toContain("events_date_idx");

    // Re-open the DB to run migrate() a second time over the same file —
    // proves the real migration is idempotent (not just a fresh CREATE).
    resetDbForTest();
    expect(() => getDb()).not.toThrow();
  });

  test("upsertEvent inserts a new row at version 1", () => {
    const ev = upsertEvent({
      name: "alpha",
      date: "2026-06-01",
      status: "planned",
      sourceType: "manual_seed",
      isManual: true,
      updatedBy: "alice",
    });
    expect(ev.id).toBeGreaterThan(0);
    expect(ev.version).toBe(1);
    expect(ev.is_manual).toBe(1);
    expect(ev.status).toBe("planned");
  });

  test("all status enum values round-trip through insert/select", () => {
    for (const status of EVENT_STATUSES) {
      const ev = upsertEvent({
        name: `status-${status}`,
        status,
        sourceType: "agent_update",
      });
      const got = getEventById(ev.id);
      expect(got?.status).toBe(status);
    }
  });

  test("insert with bad status throws InvalidEventStatusError", () => {
    expect(() =>
      upsertEvent({
        name: "bad",
        status: "nonsense" as EventStatus,
        sourceType: "agent_update",
      }),
    ).toThrow(InvalidEventStatusError);
  });

  test("upsertEvent bumps version by 1 on update", () => {
    const created = upsertEvent({
      name: "beta",
      status: "planned",
      sourceType: "agent_update",
    });
    expect(created.version).toBe(1);
    const updated = upsertEvent({
      id: created.id,
      name: "beta",
      status: "confirmed",
      sourceType: "agent_update",
      expectedVersion: 1,
    });
    expect(updated.version).toBe(2);
    expect(updated.status).toBe("confirmed");
    const updated2 = upsertEvent({
      id: created.id,
      name: "beta",
      status: "in_prep",
      sourceType: "agent_update",
      expectedVersion: 2,
    });
    expect(updated2.version).toBe(3);
  });

  test("simulated concurrent write at same expectedVersion throws on the loser", () => {
    const created = upsertEvent({
      name: "race",
      status: "planned",
      sourceType: "agent_update",
    });
    // First update wins.
    upsertEvent({
      id: created.id,
      name: "race",
      status: "confirmed",
      sourceType: "agent_update",
      expectedVersion: 1,
    });
    // A second writer that read the old version (1) and tries to apply must
    // fail rather than silently bump to a stale version.
    expect(() =>
      upsertEvent({
        id: created.id,
        name: "race",
        status: "in_prep",
        sourceType: "agent_update",
        expectedVersion: 1,
      }),
    ).toThrow(VersionConflictError);
    // Stored version is 2, not 3.
    expect(getEventById(created.id)?.version).toBe(2);
  });

  test("update without expectedVersion throws (no silent fall-back)", () => {
    const created = upsertEvent({
      name: "needs-version",
      status: "planned",
      sourceType: "agent_update",
    });
    expect(() =>
      upsertEvent({
        id: created.id,
        name: "needs-version",
        status: "confirmed",
        sourceType: "agent_update",
      }),
    ).toThrow(/expectedVersion is required/);
  });

  test("version mismatch throws VersionConflictError", () => {
    const created = upsertEvent({
      name: "gamma",
      status: "planned",
      sourceType: "agent_update",
    });
    expect(() =>
      upsertEvent({
        id: created.id,
        name: "gamma",
        status: "confirmed",
        sourceType: "agent_update",
        expectedVersion: 99,
      }),
    ).toThrow(VersionConflictError);
  });

  test("backfill_parser cannot overwrite a manual row", () => {
    const created = upsertEvent({
      name: "manual-locked",
      status: "planned",
      sourceType: "slash_command",
      isManual: true,
    });
    expect(() =>
      upsertEvent({
        id: created.id,
        name: "manual-locked",
        status: "confirmed",
        sourceType: "backfill_parser",
        expectedVersion: created.version,
      }),
    ).toThrow(ManualOverrideError);
    // version untouched
    expect(getEventById(created.id)?.version).toBe(1);
  });

  test("agent_update can update a manual row (only parser is gated)", () => {
    const created = upsertEvent({
      name: "manual-but-agent-ok",
      status: "planned",
      sourceType: "slash_command",
      isManual: true,
    });
    const updated = upsertEvent({
      id: created.id,
      name: "manual-but-agent-ok",
      status: "confirmed",
      sourceType: "agent_update",
      isManual: true,
      expectedVersion: 1,
    });
    expect(updated.version).toBe(2);
    expect(updated.status).toBe("confirmed");
  });

  test("update without isManual preserves the existing manual flag", () => {
    const created = upsertEvent({
      name: "preserve-manual",
      status: "planned",
      sourceType: "slash_command",
      isManual: true,
    });
    expect(created.is_manual).toBe(1);
    // agent_update is allowed to update a manual row, but if it doesn't pass
    // isManual the bit must NOT be cleared (otherwise a later parser write
    // would no longer be blocked).
    const updated = upsertEvent({
      id: created.id,
      name: "preserve-manual",
      status: "confirmed",
      sourceType: "agent_update",
      expectedVersion: 1,
    });
    expect(updated.is_manual).toBe(1);
    // Subsequent parser write must still be rejected.
    expect(() =>
      upsertEvent({
        id: created.id,
        name: "preserve-manual",
        status: "in_prep",
        sourceType: "backfill_parser",
        expectedVersion: 2,
      }),
    ).toThrow(ManualOverrideError);
  });

  test("update preserves nullable fields when omitted, clears them on explicit null", () => {
    const created = upsertEvent({
      name: "partial",
      date: "2026-08-01",
      status: "planned",
      channelId: "chan-1",
      sourceType: "slash_command",
      sourceMessageId: "msg-1",
      sourceChannelId: "schan-1",
      updatedBy: "alice",
    });
    // Omit nullable fields → preserved.
    const preserved = upsertEvent({
      id: created.id,
      name: "partial",
      status: "confirmed",
      sourceType: "agent_update",
      expectedVersion: 1,
    });
    expect(preserved.date).toBe("2026-08-01");
    expect(preserved.channel_id).toBe("chan-1");
    expect(preserved.source_message_id).toBe("msg-1");
    expect(preserved.source_channel_id).toBe("schan-1");
    expect(preserved.updated_by).toBe("alice");
    // Explicit null → cleared.
    const cleared = upsertEvent({
      id: created.id,
      name: "partial",
      status: "in_prep",
      sourceType: "agent_update",
      expectedVersion: 2,
      date: null,
      channelId: null,
      sourceMessageId: null,
      sourceChannelId: null,
      updatedBy: null,
    });
    expect(cleared.date).toBeNull();
    expect(cleared.channel_id).toBeNull();
    expect(cleared.source_message_id).toBeNull();
    expect(cleared.source_channel_id).toBeNull();
    expect(cleared.updated_by).toBeNull();
  });

  test("isManual: false explicitly clears the manual flag", () => {
    const created = upsertEvent({
      name: "explicit-clear",
      status: "planned",
      sourceType: "slash_command",
      isManual: true,
    });
    const cleared = upsertEvent({
      id: created.id,
      name: "explicit-clear",
      status: "confirmed",
      sourceType: "slash_command",
      isManual: false,
      expectedVersion: 1,
    });
    expect(cleared.is_manual).toBe(0);
  });

  test("getEventByName returns the most recent matching row", () => {
    upsertEvent({
      name: "lookup-me",
      status: "planned",
      sourceType: "agent_update",
    });
    const second = upsertEvent({
      name: "lookup-me",
      status: "confirmed",
      sourceType: "agent_update",
    });
    expect(getEventByName("lookup-me")?.id).toBe(second.id);
    expect(getEventByName("does-not-exist")).toBeNull();
  });

  test("findEvents filters by name and date", () => {
    upsertEvent({
      name: "find-a",
      date: "2026-07-01",
      status: "planned",
      sourceType: "agent_update",
    });
    upsertEvent({
      name: "find-a",
      date: "2026-07-02",
      status: "planned",
      sourceType: "agent_update",
    });
    upsertEvent({
      name: "find-b",
      date: "2026-07-01",
      status: "planned",
      sourceType: "agent_update",
    });

    expect(findEvents({ name: "find-a" })).toHaveLength(2);
    expect(findEvents({ date: "2026-07-01" }).length).toBeGreaterThanOrEqual(2);
    const both = findEvents({ name: "find-a", date: "2026-07-02" });
    expect(both).toHaveLength(1);
    expect(both[0]?.name).toBe("find-a");
    expect(both[0]?.date).toBe("2026-07-02");
  });
});
