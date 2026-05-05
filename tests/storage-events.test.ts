import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import { getDb } from "../src/storage/db.ts";
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
  test("migration is idempotent (re-running CREATE TABLE does not error)", () => {
    const db = getDb();
    expect(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          date TEXT,
          status TEXT NOT NULL,
          channel_id TEXT,
          source_type TEXT NOT NULL,
          source_message_id TEXT,
          source_channel_id TEXT,
          is_manual INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL,
          updated_by TEXT
        );
      `);
    }).not.toThrow();
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
