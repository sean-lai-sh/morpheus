import { describe, expect, test } from "bun:test";
import { meetingAudienceFromSelections } from "../src/coordinator/audience.ts";

describe("meeting audience from picker", () => {
  test("explicit users stay picked and are not a roster expand", () => {
    const result = meetingAudienceFromSelections([
      { kind: "user", id: "1", displayName: "Pope" },
      { kind: "user", id: "2", displayName: "Jennifer" },
    ]);
    expect(result.audienceKind).toBe("picked");
    expect(result.userSelections.map((user) => user.id)).toEqual(["1", "2"]);
  });

  test("any role means F26 roster — do not expand Discord members", () => {
    const result = meetingAudienceFromSelections([{ kind: "role", id: "1203562091500404782" }]);
    expect(result.audienceKind).toBe("f26_roster");
    expect(result.userSelections).toEqual([]);
  });

  test("mixed role + users: roster wins; extra user identities stay", () => {
    const result = meetingAudienceFromSelections([
      { kind: "role", id: "1203562091500404782" },
      { kind: "user", id: "99", displayName: "Sean" },
    ]);
    expect(result.audienceKind).toBe("f26_roster");
    expect(result.userSelections.map((user) => user.id)).toEqual(["99"]);
  });
});
