import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../src/storage/db.ts";
import {
  MEETING_DRAFT_TTL_MS,
  claimMeetingDraft,
  createMeetingDraft,
  deleteExpiredMeetingDrafts,
  getMeetingDraft,
  setMeetingDraftAudience,
} from "../src/storage/meeting-drafts.ts";
import { withTempDb } from "./helpers.ts";

const db = withTempDb();
beforeAll(() => {
  getDb();
});
afterAll(() => db.cleanup());

beforeEach(() => {
  getDb().exec("DELETE FROM meeting_drafts");
});

const NOW = 1_770_000_000_000;
const OWNER = "user-owner";
const OTHER = "user-other";

function draft(overrides: Partial<Parameters<typeof createMeetingDraft>[0]> = {}) {
  return createMeetingDraft({
    createdByUserId: OWNER,
    channelId: "1001",
    title: "Eboard standup",
    startsAt: NOW + 2 * 60 * 60_000,
    durationMinutes: 30,
    timeZone: "America/New_York",
    notes: "bring laptops",
    location: "Bobst 5th floor",
    now: NOW,
    ...overrides,
  });
}

describe("meeting drafts", () => {
  test("create/read round-trip", () => {
    const created = draft();
    expect(created.createdAt).toBe(NOW);
    expect(created.expiresAt).toBe(NOW + MEETING_DRAFT_TTL_MS);
    expect(MEETING_DRAFT_TTL_MS).toBe(15 * 60_000);

    const read = getMeetingDraft(created.id, OWNER, NOW);
    expect(read).toEqual(created);
    expect(read?.title).toBe("Eboard standup");
    expect(read?.channelId).toBe("1001");
    expect(read?.startsAt).toBe(NOW + 2 * 60 * 60_000);
    expect(read?.durationMinutes).toBe(30);
    expect(read?.timeZone).toBe("America/New_York");
    expect(read?.notes).toBe("bring laptops");
    expect(read?.location).toBe("Bobst 5th floor");
    // Nothing has been selected yet.
    expect(read?.audience).toBeNull();
  });

  test("another user cannot read it", () => {
    const created = draft();
    expect(getMeetingDraft(created.id, OTHER, NOW)).toBeNull();
    expect(getMeetingDraft(created.id, OWNER, NOW)).not.toBeNull();
  });

  test("another user cannot claim it, and the owner still can", () => {
    const created = draft();
    expect(claimMeetingDraft(created.id, OTHER, NOW)).toBeNull();
    expect(claimMeetingDraft(created.id, OWNER, NOW)?.id).toBe(created.id);
  });

  test("expired drafts are invisible to both readers before any sweep", () => {
    const created = draft();
    const afterTtl = created.expiresAt + 1;

    // Nothing has been swept: the row is still physically present.
    const remaining = getDb()
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM meeting_drafts")
      .get()?.n;
    expect(remaining).toBe(1);

    expect(getMeetingDraft(created.id, OWNER, afterTtl)).toBeNull();
    expect(claimMeetingDraft(created.id, OWNER, afterTtl)).toBeNull();

    // Exactly at expires_at the draft is already gone (predicate is `> now`).
    expect(getMeetingDraft(created.id, OWNER, created.expiresAt)).toBeNull();
    // ...but one ms earlier it is still live, and the failed claims above did
    // not consume it.
    expect(getMeetingDraft(created.id, OWNER, created.expiresAt - 1)?.id).toBe(created.id);
  });

  test("claimMeetingDraft returns the row once and null the second time", () => {
    const created = draft();

    const first = claimMeetingDraft(created.id, OWNER, NOW);
    expect(first).toEqual(created);

    // The double-submit guard: a second "Confirm" click must come away empty.
    const second = claimMeetingDraft(created.id, OWNER, NOW);
    expect(second).toBeNull();

    // And the claim really removed it.
    expect(getMeetingDraft(created.id, OWNER, NOW)).toBeNull();
    const remaining = getDb()
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM meeting_drafts")
      .get()?.n;
    expect(remaining).toBe(0);
  });

  test("deleteExpiredMeetingDrafts removes only expired rows and reports the count", () => {
    const old1 = draft({ title: "Old one", now: NOW - MEETING_DRAFT_TTL_MS - 5_000 });
    const old2 = draft({ title: "Old two", now: NOW - MEETING_DRAFT_TTL_MS - 1 });
    const live = draft({ title: "Still live" });

    expect(deleteExpiredMeetingDrafts(NOW)).toBe(2);

    expect(getMeetingDraft(old1.id, OWNER, NOW)).toBeNull();
    expect(getMeetingDraft(old2.id, OWNER, NOW)).toBeNull();
    expect(getMeetingDraft(live.id, OWNER, NOW)?.title).toBe("Still live");

    // Idempotent: a second sweep with nothing expired removes nothing.
    expect(deleteExpiredMeetingDrafts(NOW)).toBe(0);
  });

  test("notes and location round-trip as null, not the string \"null\"", () => {
    const empty = draft({ notes: null, location: null });
    expect(empty.notes).toBeNull();
    expect(empty.location).toBeNull();

    const read = getMeetingDraft(empty.id, OWNER, NOW);
    expect(read?.notes).toBeNull();
    expect(read?.location).toBeNull();
    expect(read?.notes).not.toBe("null");
    expect(read?.location).not.toBe("null");

    const claimed = claimMeetingDraft(empty.id, OWNER, NOW);
    expect(claimed?.notes).toBeNull();
    expect(claimed?.location).toBeNull();

    // ...and each is independent of the other.
    const notesOnly = draft({ notes: "agenda in the doc", location: null });
    expect(getMeetingDraft(notesOnly.id, OWNER, NOW)?.notes).toBe("agenda in the doc");
    expect(getMeetingDraft(notesOnly.id, OWNER, NOW)?.location).toBeNull();

    const locationOnly = draft({ notes: null, location: "https://zoom.us/j/123" });
    expect(getMeetingDraft(locationOnly.id, OWNER, NOW)?.notes).toBeNull();
    expect(getMeetingDraft(locationOnly.id, OWNER, NOW)?.location).toBe("https://zoom.us/j/123");
  });

  test("blank-ish text normalizes to null; title, notes and location are capped", () => {
    const blank = draft({ notes: "   ", location: "  " });
    expect(getMeetingDraft(blank.id, OWNER, NOW)?.notes).toBeNull();
    expect(getMeetingDraft(blank.id, OWNER, NOW)?.location).toBeNull();

    const long = draft({
      title: "T".repeat(500),
      notes: "N".repeat(5_000),
      location: "L".repeat(5_000),
    });
    expect(long.title).toHaveLength(100);
    expect(long.notes).toHaveLength(1000);
    expect(long.location).toHaveLength(200);
  });

  test("setMeetingDraftAudience survives the hop to Confirm", () => {
    const created = draft();
    const audience = {
      audienceKind: "picked" as const,
      participants: [
        { userId: "u-1", displayName: "Sam" },
        { userId: "u-2", displayName: "Riley" },
      ],
    };

    const updated = setMeetingDraftAudience(created.id, OWNER, audience, NOW);
    expect(updated?.audience).toEqual(audience);

    // Visible to a plain read too, not just the return value.
    expect(getMeetingDraft(created.id, OWNER, NOW)?.audience).toEqual(audience);

    // The Confirm click gets it intact, and the rest of the draft with it.
    const claimed = claimMeetingDraft(created.id, OWNER, NOW);
    expect(claimed?.audience).toEqual(audience);
    expect(claimed?.title).toBe("Eboard standup");
    expect(claimed?.location).toBe("Bobst 5th floor");
  });

  test("setMeetingDraftAudience carries the f26_roster kind with no participants", () => {
    const created = draft();
    const audience = { audienceKind: "f26_roster" as const, participants: [] };
    expect(setMeetingDraftAudience(created.id, OWNER, audience, NOW)?.audience).toEqual(audience);
    expect(claimMeetingDraft(created.id, OWNER, NOW)?.audience).toEqual(audience);
  });

  test("setMeetingDraftAudience refreshes the TTL", () => {
    const created = draft();
    const later = NOW + 12 * 60_000; // deep into the original window
    const updated = setMeetingDraftAudience(
      created.id,
      OWNER,
      { audienceKind: "picked", participants: [{ userId: "u-1", displayName: "Sam" }] },
      later,
    );
    expect(updated?.expiresAt).toBe(later + MEETING_DRAFT_TTL_MS);

    // Which means Confirm still works past the original expiry.
    expect(claimMeetingDraft(created.id, OWNER, created.expiresAt + 60_000)?.id).toBe(created.id);
  });

  test("another user cannot set the audience on someone else's draft", () => {
    const created = draft();
    const result = setMeetingDraftAudience(
      created.id,
      OTHER,
      { audienceKind: "picked", participants: [{ userId: "intruder", displayName: "Mallory" }] },
      NOW,
    );
    expect(result).toBeNull();
    // And nothing was written.
    expect(getMeetingDraft(created.id, OWNER, NOW)?.audience).toBeNull();
  });

  test("an expired draft cannot have its audience set", () => {
    const created = draft();
    const afterTtl = created.expiresAt + 1;
    const result = setMeetingDraftAudience(
      created.id,
      OWNER,
      { audienceKind: "picked", participants: [{ userId: "u-1", displayName: "Sam" }] },
      afterTtl,
    );
    expect(result).toBeNull();

    // The write must not have resurrected the row by refreshing expires_at.
    const raw = getDb()
      .query<{ audience_json: string | null; expires_at: number }, [string]>(
        "SELECT audience_json, expires_at FROM meeting_drafts WHERE id = ?",
      )
      .get(created.id);
    expect(raw?.audience_json).toBeNull();
    expect(raw?.expires_at).toBe(created.expiresAt);
  });

  test("setMeetingDraftAudience on a missing draft returns null", () => {
    const result = setMeetingDraftAudience(
      crypto.randomUUID(),
      OWNER,
      { audienceKind: "picked", participants: [] },
      NOW,
    );
    expect(result).toBeNull();
  });

  test("malformed audience_json reads back as null rather than throwing", () => {
    const cases = [
      "not json at all",
      "{",
      "null",
      "[]",
      '"a string"',
      "42",
      '{"participants":[{"userId":"u-1","displayName":"Sam"}]}', // no kind
      '{"audienceKind":"everyone","participants":[]}', // unknown kind
      '{"audienceKind":"picked"}', // no participants
      '{"audienceKind":"picked","participants":"u-1"}', // participants not an array
      '{"audienceKind":"picked","participants":[{"userId":"u-1"}]}', // no displayName
      '{"audienceKind":"picked","participants":[{"userId":7,"displayName":"Sam"}]}', // wrong type
      '{"audienceKind":"picked","participants":[null]}',
    ];

    for (const bad of cases) {
      const created = draft();
      getDb()
        .query("UPDATE meeting_drafts SET audience_json = ? WHERE id = ?")
        .run(bad, created.id);

      expect(() => getMeetingDraft(created.id, OWNER, NOW)).not.toThrow();
      expect(getMeetingDraft(created.id, OWNER, NOW)?.audience).toBeNull();
      expect(claimMeetingDraft(created.id, OWNER, NOW)?.audience).toBeNull();
    }
  });

  test("a half-valid participant list is rejected whole, not partially kept", () => {
    const created = draft();
    getDb()
      .query("UPDATE meeting_drafts SET audience_json = ? WHERE id = ?")
      .run(
        '{"audienceKind":"picked","participants":[{"userId":"u-1","displayName":"Sam"},{"userId":"u-2"}]}',
        created.id,
      );
    // Booking half an audience is worse than booking none: the caller would
    // silently drop an invitee.
    expect(getMeetingDraft(created.id, OWNER, NOW)?.audience).toBeNull();
  });
});
