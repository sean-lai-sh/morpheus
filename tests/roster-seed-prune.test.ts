import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MANUAL_ROSTER_BINDINGS } from "../src/coordinator/roster-map.ts";
import { resolveAttendeeEmails } from "../src/coordinator/attendees.ts";
import { applyRosterSeedResult, getRosterBinding, listAllRosterBindings } from "../src/storage/roster-map.ts";
import { getDb } from "../src/storage/db.ts";
import { withTempDb } from "./helpers.ts";

const db = withTempDb();
beforeAll(() => {
  getDb();
});
afterAll(() => db.cleanup());

const A = { discord_id: "200000000000000001", email: "a@nyu.edu", name: "A", disc: "a", confidence: "disc" as const };
const B = { discord_id: "200000000000000002", email: "b@nyu.edu", name: "B", disc: "b", confidence: "disc" as const };

describe("roster seed replaces the snapshot", () => {
  test("seed A+B then reseed A: B is pruned and no longer invited on f26_roster", () => {
    applyRosterSeedResult({ mappings: [A, B] });
    expect(getRosterBinding(B.discord_id)).not.toBeNull();

    const second = applyRosterSeedResult({ mappings: [A] });
    expect(second.pruned).toBe(1);
    expect(getRosterBinding(A.discord_id)?.email).toBe("a@nyu.edu");
    expect(getRosterBinding(B.discord_id)).toBeNull();

    // `listAllRosterBindings` IS the production guest list.
    const invited = resolveAttendeeEmails({ audience: "f26_roster", participantIds: [] });
    expect(invited.emails).toContain("a@nyu.edu");
    expect(invited.emails).not.toContain("b@nyu.edu");
  });

  test("manual bindings survive a reseed that does not mention them", () => {
    applyRosterSeedResult({ mappings: [A] });
    for (const manual of MANUAL_ROSTER_BINDINGS) {
      expect(getRosterBinding(manual.discord_id)?.email).toBe(manual.email);
    }
    expect(listAllRosterBindings()).toHaveLength(1 + MANUAL_ROSTER_BINDINGS.length);
  });

  test("a seed that maps nobody is a no-op, not a wipe", () => {
    applyRosterSeedResult({ mappings: [A, B] });
    const before = listAllRosterBindings().length;
    const empty = applyRosterSeedResult({ mappings: [] });
    expect(empty.pruned).toBe(0);
    expect(listAllRosterBindings()).toHaveLength(before);
  });

  test("prune: false keeps unmentioned rows (one-off top-ups)", () => {
    applyRosterSeedResult({ mappings: [A, B] });
    applyRosterSeedResult({ mappings: [A], prune: false });
    expect(getRosterBinding(B.discord_id)).not.toBeNull();
  });
});
