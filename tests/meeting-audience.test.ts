import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  audienceSelectionsFromMentions,
  collectMentionRoleIds,
  composeMeetUserAudience,
  extractMentionableAudience,
  extractRoleSnowflakes,
  formatUnmappedInviteRefusal,
  MEET_REVIEW_EMPTY,
  MEET_ROSTER_UNSEEDED,
  meetingAudienceFromSelections,
  meetReviewBlocker,
  pickedUsersFromSelect,
  unmappedPickRefusal,
  resolveMeetingInvitees,
} from "../src/coordinator/audience.ts";
import { EBOARD_ROLE_ID } from "../src/coordinator/roster-map.ts";
import { buildCalendarJobPack, serializeCalendarJobPack } from "../src/coordinator/calendar-job.ts";
import { createScheduledMeeting, getMeeting, getMeetingParticipants } from "../src/storage/coordinator-meetings.ts";
import {
  applyRosterSeedResult,
  countSeededRosterBindings,
  getRosterBinding,
  listAllRosterBindings,
  upsertManualRosterBindings,
} from "../src/storage/roster-map.ts";
import { getDb } from "../src/storage/db.ts";
import { withTempDb } from "./helpers.ts";

const db = withTempDb();
beforeAll(() => {
  getDb();
});
afterAll(() => db.cleanup());

describe("meeting audience", () => {
  test("Eboard role snowflake is f26_roster and does not expand members", () => {
    const selections = audienceSelectionsFromMentions({
      users: [],
      roleIds: [EBOARD_ROLE_ID],
    });
    const audience = meetingAudienceFromSelections(selections);
    expect(audience.audienceKind).toBe("f26_roster");
    expect(audience.userSelections).toEqual([]);
  });

  test("picker value is the Eboard snowflake even when resolved.roles is empty", () => {
    const selections = extractMentionableAudience({
      values: [EBOARD_ROLE_ID, "11"],
      resolved: {
        users: { "11": { username: "sean", global_name: "Sean" } },
        roles: {},
      },
    });
    expect(selections.some((row) => row.kind === "role" && row.id === EBOARD_ROLE_ID)).toBe(true);
    const audience = meetingAudienceFromSelections(selections);
    expect(audience.audienceKind).toBe("f26_roster");
    expect(audience.userSelections.map((u) => u.id)).toEqual(["11"]);
  });

  test("the word eboard is not a role detect", () => {
    expect(extractRoleSnowflakes("please invite eboard to the meeting Friday 3pm")).toEqual([]);
    expect(collectMentionRoleIds({ content: "invite Eboard and eboard", cachedRoleIds: [] })).toEqual([]);
    const audience = meetingAudienceFromSelections(
      audienceSelectionsFromMentions({
        users: [{ id: "11", displayName: "Sean" }],
        roleIds: [],
      }),
    );
    expect(audience.audienceKind).toBe("picked");
  });

  test("<@&snowflake> in content is detected without the roles cache", () => {
    const ids = collectMentionRoleIds({
      content: `<@123> meeting Friday 3pm <@&${EBOARD_ROLE_ID}>`,
      cachedRoleIds: [],
    });
    expect(ids).toEqual([EBOARD_ROLE_ID]);
    expect(meetingAudienceFromSelections(audienceSelectionsFromMentions({ users: [], roleIds: ids })).audienceKind).toBe(
      "f26_roster",
    );
  });

  test("unmapped role is not the F26 dump", () => {
    const audience = meetingAudienceFromSelections(
      audienceSelectionsFromMentions({
        users: [],
        roleIds: ["999999999999999999"],
      }),
    );
    expect(audience.audienceKind).toBe("picked");
  });

  test("explicit users stay picked snowflakes", () => {
    const audience = meetingAudienceFromSelections(
      audienceSelectionsFromMentions({
        users: [{ id: "11", displayName: "Sean" }],
        roleIds: [],
      }),
    );
    expect(audience.audienceKind).toBe("picked");
    expect(audience.userSelections.map((u) => u.id)).toEqual(["11"]);
  });

  test("role + extra users keeps snowflakes on f26_roster", () => {
    const audience = meetingAudienceFromSelections(
      audienceSelectionsFromMentions({
        users: [{ id: "11", displayName: "Sean" }],
        roleIds: [EBOARD_ROLE_ID],
      }),
    );
    expect(audience.audienceKind).toBe("f26_roster");
    expect(audience.userSelections.map((u) => u.id)).toEqual(["11"]);
  });

  test("unmapped extra users are refused; bound extras are kept", () => {
    applyRosterSeedResult({
      mappings: [
        {
          discord_id: "11",
          email: "sean@nyu.edu",
          name: "Sean",
          disc: "sean",
          confidence: "disc",
        },
      ],
    });
    const refused = resolveMeetingInvitees(
      audienceSelectionsFromMentions({
        users: [{ id: "22", displayName: "Stranger" }],
        roleIds: [EBOARD_ROLE_ID],
      }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe("unmapped-users");
      expect(formatUnmappedInviteRefusal(refused.unmapped)).toContain("Stranger");
      expect(formatUnmappedInviteRefusal(refused.unmapped)).not.toContain("@nyu.edu");
    }
    const ok = resolveMeetingInvitees(
      audienceSelectionsFromMentions({
        users: [{ id: "11", displayName: "Sean" }],
        roleIds: [EBOARD_ROLE_ID],
      }),
    );
    expect(ok).toEqual({
      ok: true,
      audienceKind: "f26_roster",
      participants: [{ userId: "11", displayName: "Sean" }],
    });
    expect(getRosterBinding("22")).toBeNull();
  });

  test("picked users without a roster binding have no audience", () => {
    const result = resolveMeetingInvitees(
      audienceSelectionsFromMentions({
        users: [{ id: "33", displayName: "Nobody" }],
        roleIds: [],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unmapped-users");
  });

  test("f26_roster meeting may have zero participants; pack has audience and no emails", () => {
    const id = crypto.randomUUID();
    const created = createScheduledMeeting({
      id,
      createdByUserId: "creator-1",
      title: "Eboard",
      startsAt: Date.now() + 3_600_000,
      durationMinutes: 60,
      channelId: "1001",
      participants: [],
      audienceKind: "f26_roster",
    });
    expect(getMeeting(id)?.audienceKind).toBe("f26_roster");
    expect(getMeetingParticipants(id)).toEqual([]);
    const pack = buildCalendarJobPack({
      kind: "meeting.calendar_sync",
      meeting: created.meeting,
      outboxId: "ob-1",
      version: 1,
      participantCount: 0,
      participantIds: [],
    });
    const json = serializeCalendarJobPack(pack);
    expect(pack.audience).toBe("f26_roster");
    expect(pack.participant_ids).toEqual([]);
    expect(json).not.toMatch(/@nyu\.edu|@gmail\.com/i);
  });

  test("f26 pack keeps extra user snowflakes and still has no emails", () => {
    const pack = buildCalendarJobPack({
      kind: "meeting.calendar_sync",
      meeting: {
        id: "meet-role",
        title: "Eboard",
        startsAt: Date.now() + 3_600_000,
        endsAt: Date.now() + 7_200_000,
        timeZone: "America/New_York",
        notes: `invite <@&${EBOARD_ROLE_ID}>`,
        calendarEventId: null,
        audienceKind: "f26_roster",
      },
      outboxId: "ob-role",
      version: 1,
      participantCount: 1,
      participantIds: ["11"],
    });
    const json = serializeCalendarJobPack(pack);
    expect(pack.audience).toBe("f26_roster");
    expect(pack.participant_ids).toEqual(["11"]);
    expect(json).toContain(EBOARD_ROLE_ID);
    expect(json).toContain("hello@techatnyu.org");
    expect(json.replace(/hello@techatnyu\.org/gi, "")).not.toMatch(/@nyu\.edu|@gmail\.com/i);
  });

  test("pickedUsersFromSelect uses values even when resolved users are missing", () => {
    expect(
      pickedUsersFromSelect({
        values: ["11", "22"],
        users: { "11": { username: "sean", global_name: "Sean Lai" } },
      }),
    ).toEqual([
      { id: "11", displayName: "Sean Lai" },
      { id: "22", displayName: "22" },
    ]);
  });

  test("composeMeetUserAudience keeps mapped people and names the unmapped", () => {
    applyRosterSeedResult({
      mappings: [
        {
          discord_id: "11",
          email: "sean@nyu.edu",
          name: "Sean",
          disc: "sean",
          confidence: "disc",
        },
      ],
    });
    const mixed = composeMeetUserAudience({
      audienceKind: "picked",
      picked: [
        { id: "11", displayName: "Sean Lai" },
        { id: "22", displayName: "Helen xu" },
        { id: "33", displayName: "Surya" },
      ],
    });
    expect(mixed.participants).toEqual([{ userId: "11", displayName: "Sean Lai" }]);
    expect(mixed.unmapped.map((row) => row.displayName)).toEqual(["Helen xu", "Surya"]);
    expect(meetReviewBlocker(mixed)).toBeNull();

    const allUnmapped = composeMeetUserAudience({
      audienceKind: "picked",
      picked: [
        { id: "22", displayName: "helenn" },
        { id: "33", displayName: "Surya" },
        { id: "44", displayName: "shaszis" },
      ],
    });
    expect(allUnmapped.participants).toEqual([]);
    expect(meetReviewBlocker(allUnmapped)).toBe(formatUnmappedInviteRefusal(allUnmapped.unmapped));
    expect(meetReviewBlocker(allUnmapped)).toContain("helenn, Surya, shaszis");
    expect(meetReviewBlocker(allUnmapped)).not.toBe(MEET_REVIEW_EMPTY);
  });

  test("Review is ready once a role is saved, even if the last people pick was unmapped", () => {
    const blocked = meetReviewBlocker({
      audienceKind: "picked",
      participants: [],
      unmapped: [{ displayName: "helenn" }],
    });
    expect(blocked).toContain("helenn");
    expect(
      meetReviewBlocker({
        audienceKind: "f26_roster",
        participants: [],
        unmapped: [{ displayName: "helenn" }],
      }),
    ).toBeNull();
    expect(meetReviewBlocker(null)).toBe(MEET_REVIEW_EMPTY);
  });

  test("an unseeded roster map is reported as such, not blamed on the picks", () => {
    const unmapped = [{ displayName: "helenn" }, { displayName: "shaszis" }];
    // Every pick is unmapped when the map is empty, so naming the people tells
    // the organizer to fix something that is not theirs to fix.
    expect(unmappedPickRefusal(unmapped, 0)).toBe(MEET_ROSTER_UNSEEDED);
    expect(unmappedPickRefusal(unmapped, 0)).toContain("/meet seed");
    expect(unmappedPickRefusal(unmapped, 0)).not.toContain("helenn");
    expect(unmappedPickRefusal(unmapped, 4)).toContain("helenn, shaszis");
    expect(unmappedPickRefusal(unmapped)).toContain("helenn, shaszis");

    const audience = { audienceKind: "picked" as const, participants: [], unmapped };
    expect(meetReviewBlocker(audience, 0)).toBe(MEET_ROSTER_UNSEEDED);
    expect(meetReviewBlocker(audience, 4)).toContain("helenn, shaszis");
    // Nothing picked at all is still "pick someone", seeded or not.
    expect(meetReviewBlocker({ audienceKind: "picked", participants: [] }, 0)).toBe(
      MEET_REVIEW_EMPTY,
    );
  });

  test("@Eboard cannot stand in for an unseeded map", () => {
    const roster = { audienceKind: "f26_roster" as const, participants: [] };
    // Otherwise Confirm books a real event with an empty guest list and still
    // says "the Calendar invite is on its way".
    expect(meetReviewBlocker(roster, 0)).toBe(MEET_ROSTER_UNSEEDED);
    expect(meetReviewBlocker(roster, 12)).toBeNull();
    expect(meetReviewBlocker(roster)).toBeNull();
  });

  test("countSeededRosterBindings ignores the manual bindings migrate always inserts", () => {
    getDb().exec("DELETE FROM roster_bindings");
    upsertManualRosterBindings(getDb());
    // A raw COUNT(*) is 4 here, which is why it can never answer "has a seed
    // ever run" -- every migrate re-inserts MANUAL_ROSTER_BINDINGS.
    expect(listAllRosterBindings().length).toBeGreaterThan(0);
    expect(countSeededRosterBindings()).toBe(0);

    applyRosterSeedResult({
      mappings: [
        { discord_id: "11", email: "sean@nyu.edu", name: "Sean", disc: "sean", confidence: "disc" },
      ],
      prune: false,
    });
    expect(countSeededRosterBindings()).toBe(1);
  });

  test("picked meeting still requires an attendee", () => {
    expect(() =>
      createScheduledMeeting({
        createdByUserId: "creator-1",
        title: "1:1",
        startsAt: Date.now() + 3_600_000,
        durationMinutes: 30,
        participants: [],
        audienceKind: "picked",
      }),
    ).toThrow("Add at least one attendee.");
  });
});
