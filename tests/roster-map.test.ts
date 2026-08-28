import { describe, expect, test } from "bun:test";
import { matchRosterToMembers } from "../src/coordinator/roster-map.ts";

describe("matchRosterToMembers", () => {
  const members = [
    { id: "11", username: "seanlai", global_name: "Sean Lai", nick: "Sean" },
    { id: "22", username: "sam", global_name: "Sam Example", nick: null },
    { id: "33", username: "other", global_name: "Marc Chen", nick: "Marc Chen" },
    { id: "44", username: "fahim", global_name: "Fahim Mehraj", nick: "Fahim Mehraj" },
    { id: "55", username: "khidir", global_name: "Khidir", nick: "Khidir Ali" },
    { id: "66", username: "zach", global_name: "Zach", nick: "Zach Something" },
  ];

  test("Disc handle matches username before name", () => {
    const result = matchRosterToMembers(
      [{ first: "Sean", last: "Lai", email: "sean@nyu.edu", disc: "@seanlai" }],
      members,
    );
    expect(result.mappings).toEqual([
      { discord_id: "11", email: "sean@nyu.edu", name: "Sean Lai", disc: "@seanlai", confidence: "disc" },
    ]);
    expect(result.unmatched).toEqual([]);
  });

  test("First+Last matches nick/global_name when Disc misses", () => {
    const result = matchRosterToMembers(
      [{ first: "Sam", last: "Example", email: "sam@nyu.edu", disc: "not-a-handle" }],
      members,
    );
    expect(result.mappings).toEqual([
      { discord_id: "22", email: "sam@nyu.edu", name: "Sam Example", disc: "not-a-handle", confidence: "name" },
    ]);
  });

  test("empty Disc (Marc, Fahim, Khidir, Zach) stays unmatched — no name guess", () => {
    const result = matchRosterToMembers(
      [
        { first: "Marc", last: "Chen", email: "marc@nyu.edu", disc: null },
        { first: "Fahim", last: "Mehraj", email: "fahim@nyu.edu", disc: "" },
        { first: "Khidir", last: "Ali", email: "khidir@nyu.edu", disc: null },
        { first: "Zach", last: "Something", email: "zach@nyu.edu", disc: "   " },
      ],
      members,
    );
    expect(result.mappings).toEqual([]);
    expect(result.unmatched.map((row) => row.name).sort()).toEqual([
      "Fahim Mehraj",
      "Khidir Ali",
      "Marc Chen",
      "Zach Something",
    ]);
    expect(result.unmatched.every((row) => row.reason === "empty_disc")).toBe(true);
  });
});
