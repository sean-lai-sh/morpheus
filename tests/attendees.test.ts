import { describe, expect, test } from "bun:test";
import { resolveAttendeeEmails } from "../src/coordinator/attendees.ts";

/** Stub the two storage readers so these stay pure and DB-free. */
function deps(bindings: Record<string, string>) {
  return {
    bindingFor: (id: string) => (bindings[id] ? { email: bindings[id]! } : null),
    allBindings: () => Object.values(bindings).map((email) => ({ email })),
  };
}

const ROSTER = {
  "1": "ada@nyu.edu",
  "2": "grace@nyu.edu",
  "3": "alan@nyu.edu",
};

describe("resolveAttendeeEmails: picked", () => {
  test("invites exactly the picked participants, never the whole roster", () => {
    const r = resolveAttendeeEmails({ audience: "picked", participantIds: ["1", "3"] }, deps(ROSTER));
    expect(r.emails).toEqual(["ada@nyu.edu", "alan@nyu.edu"]);
    expect(r.emails).not.toContain("grace@nyu.edu");
    expect(r.unresolved).toEqual([]);
    expect(r.rosterCount).toBe(0);
  });

  test("an unbound snowflake is reported, not silently dropped or invited", () => {
    const r = resolveAttendeeEmails({ audience: "picked", participantIds: ["1", "999"] }, deps(ROSTER));
    expect(r.emails).toEqual(["ada@nyu.edu"]);
    expect(r.unresolved).toEqual(["999"]);
  });

  test("no participants yields no attendees", () => {
    const r = resolveAttendeeEmails({ audience: "picked", participantIds: [] }, deps(ROSTER));
    expect(r.emails).toEqual([]);
    expect(r.rosterCount).toBe(0);
  });
});

describe("resolveAttendeeEmails: f26_roster", () => {
  test("invites every seeded binding and reports how many that was", () => {
    const r = resolveAttendeeEmails({ audience: "f26_roster", participantIds: [] }, deps(ROSTER));
    expect(r.emails).toEqual(["ada@nyu.edu", "grace@nyu.edu", "alan@nyu.edu"]);
    expect(r.rosterCount).toBe(3);
  });

  test("extra picked users ride along with the roster without duplicating", () => {
    const withExtra = { ...ROSTER, "4": "kat@nyu.edu" };
    const r = resolveAttendeeEmails(
      // "1" is already in the roster block; "4" is the extra.
      { audience: "f26_roster", participantIds: ["1", "4"] },
      deps(withExtra),
    );
    expect(r.emails).toEqual(["ada@nyu.edu", "grace@nyu.edu", "alan@nyu.edu", "kat@nyu.edu"]);
    expect(r.emails.filter((e) => e === "ada@nyu.edu")).toHaveLength(1);
  });

  test("an empty roster is not an error; it resolves to no attendees", () => {
    const r = resolveAttendeeEmails({ audience: "f26_roster", participantIds: [] }, deps({}));
    expect(r.emails).toEqual([]);
    expect(r.rosterCount).toBe(0);
  });
});

describe("resolveAttendeeEmails: normalization", () => {
  test("addresses are lowercased and deduped case-insensitively", () => {
    const r = resolveAttendeeEmails(
      { audience: "picked", participantIds: ["a", "b"] },
      {
        bindingFor: (id) => ({ email: id === "a" ? "Ada@NYU.edu" : "  ada@nyu.edu " }),
        allBindings: () => [],
      },
    );
    expect(r.emails).toEqual(["ada@nyu.edu"]);
  });

  test("a blank stored address contributes nothing", () => {
    const r = resolveAttendeeEmails(
      { audience: "picked", participantIds: ["a"] },
      { bindingFor: () => ({ email: "   " }), allBindings: () => [] },
    );
    expect(r.emails).toEqual([]);
    // It was bound, just unusable -- that is not the same as an unbound user.
    expect(r.unresolved).toEqual([]);
  });

  test("ordering is stable: roster block first, then picked extras", () => {
    const a = resolveAttendeeEmails({ audience: "f26_roster", participantIds: ["9"] }, {
      bindingFor: () => ({ email: "zoe@nyu.edu" }),
      allBindings: () => [{ email: "ada@nyu.edu" }, { email: "grace@nyu.edu" }],
    });
    expect(a.emails).toEqual(["ada@nyu.edu", "grace@nyu.edu", "zoe@nyu.edu"]);
  });
});
