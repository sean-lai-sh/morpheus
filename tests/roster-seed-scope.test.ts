import { describe, expect, test } from "bun:test";
import { isRosterSeedCandidate } from "../src/coordinator/seed-job.ts";
import {
  EBOARD_ROLE_ID,
  LEADERSHIP_ROLE_ID,
  SENIOR_ADV_ROLE_ID,
} from "../src/coordinator/roster-map.ts";

const OTHER = "999999999999999999";

describe("isRosterSeedCandidate", () => {
  test("an @Eboard member is seeded", () => {
    expect(isRosterSeedCandidate({ isBot: false, roleIds: [EBOARD_ROLE_ID] })).toBe(true);
  });

  test("Leadership and Senior Adv are seeded too", () => {
    // They can be on the F26 sheet; excluding them would make them
    // un-inviteable through /meet later.
    expect(isRosterSeedCandidate({ isBot: false, roleIds: [LEADERSHIP_ROLE_ID] })).toBe(true);
    expect(isRosterSeedCandidate({ isBot: false, roleIds: [SENIOR_ADV_ROLE_ID] })).toBe(true);
  });

  test("an ordinary member with no eboard role is NOT seeded", () => {
    // This is the regression: the seed used to serialize every non-bot member.
    expect(isRosterSeedCandidate({ isBot: false, roleIds: [OTHER] })).toBe(false);
    expect(isRosterSeedCandidate({ isBot: false, roleIds: [] })).toBe(false);
  });

  test("a bot is never seeded, even carrying the role", () => {
    expect(isRosterSeedCandidate({ isBot: true, roleIds: [EBOARD_ROLE_ID] })).toBe(false);
  });

  test("extra unrelated roles alongside the eboard role still qualify", () => {
    expect(isRosterSeedCandidate({ isBot: false, roleIds: [OTHER, EBOARD_ROLE_ID] })).toBe(true);
  });

  test("filtering a mixed guild keeps only the eboard side", () => {
    const guild = [
      { id: "1", isBot: false, roleIds: [EBOARD_ROLE_ID] },
      { id: "2", isBot: false, roleIds: [OTHER] },          // pearmeow-shaped
      { id: "3", isBot: true, roleIds: [EBOARD_ROLE_ID] },
      { id: "4", isBot: false, roleIds: [LEADERSHIP_ROLE_ID] },
      { id: "5", isBot: false, roleIds: [] },
    ];
    expect(guild.filter(isRosterSeedCandidate).map((m) => m.id)).toEqual(["1", "4"]);
  });
});
