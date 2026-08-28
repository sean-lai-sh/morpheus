import { describe, expect, test } from "bun:test";
import { EBOARD_ROLE_ID } from "../src/coordinator/roster-map.ts";
import {
  MEET_COMMAND,
  audienceLine,
  audienceRows,
  confirmSummary,
  meetCreateModal,
  meetingAnnouncement,
} from "../src/bot/coordinator.ts";

const START = Date.UTC(2026, 8, 4, 18, 0, 0);

function subcommand(name: string): Record<string, unknown> | undefined {
  const options = (MEET_COMMAND as { options?: Array<Record<string, unknown>> }).options ?? [];
  return options.find((o) => o.name === name);
}

describe("/meet create is a modal, not a pile of slash options", () => {
  test("create takes no options at all", () => {
    const create = subcommand("create");
    expect(create).toBeDefined();
    // The five fields moved into the modal; leaving even one behind would mean
    // two places to enter the same meeting.
    expect((create!.options as unknown[] | undefined) ?? []).toHaveLength(0);
  });

  test("cancel and seed are untouched", () => {
    expect(((subcommand("cancel")!.options as unknown[]) ?? []).length).toBe(1);
    expect(((subcommand("seed")!.options as unknown[]) ?? []).length).toBe(0);
  });

  test("the description no longer promises Grok does the booking", () => {
    expect(String(subcommand("create")!.description)).not.toContain("Grok");
  });
});

describe("the modal itself", () => {
  const json = meetCreateModal().toJSON() as {
    custom_id: string;
    components: Array<{ components: Array<{ custom_id: string; required?: boolean; label: string }> }>;
  };
  const fields = json.components.map((row) => row.components[0]!);

  test("routes on meet:create and carries exactly the five fields", () => {
    expect(json.custom_id).toBe("meet:create");
    // Five is Discord's hard maximum for a modal, so this is a ceiling, not a
    // preference -- a sixth field would silently fail to render.
    expect(fields.map((f) => f.custom_id)).toEqual(["title", "when", "duration", "location", "notes"]);
    expect(fields).toHaveLength(5);
  });

  test("only title and when are required", () => {
    const required = fields.filter((f) => f.required).map((f) => f.custom_id);
    expect(required).toEqual(["title", "when"]);
  });

  test("location is offered and optional", () => {
    const location = fields.find((f) => f.custom_id === "location")!;
    expect(location.required).toBeFalsy();
    expect(location.label.toLowerCase()).toContain("location");
  });
});

describe("confirmSummary is the last stop before real invitations", () => {
  const base = {
    title: "Eboard sync",
    startsAt: START,
    durationMinutes: 60,
    location: null,
    notes: null,
    timeZone: "America/New_York",
  };

  test("names the roster explicitly when the audience is the whole F26 list", () => {
    const out = confirmSummary({
      ...base,
      audience: { audienceKind: "f26_roster", participants: [] },
    });
    expect(out).toContain("full F26 roster");
    // The warning is the entire reason this step exists.
    expect(out).toContain("sends real calendar invitations");
  });

  test("counts picked people and uses the singular for one", () => {
    expect(
      confirmSummary({ ...base, audience: { audienceKind: "picked", participants: [{ userId: "1" }] } }),
    ).toContain("**1 person**");
    expect(
      confirmSummary({
        ...base,
        audience: { audienceKind: "picked", participants: [{ userId: "1" }, { userId: "2" }] },
      }),
    ).toContain("**2 people**");
  });

  test("roster plus extras reports both", () => {
    const out = confirmSummary({
      ...base,
      audience: { audienceKind: "f26_roster", participants: [{ userId: "9" }] },
    });
    expect(out).toContain("full F26 roster");
    expect(out).toContain("plus 1 more");
  });

  test("shows a location only when one was given", () => {
    expect(
      confirmSummary({ ...base, location: "Bobst 5th floor", audience: null }),
    ).toContain("📍 Bobst 5th floor");
    expect(confirmSummary({ ...base, audience: null })).not.toContain("📍");
  });

  test("renders the time as a Discord timestamp, not a server-local string", () => {
    const out = confirmSummary({ ...base, audience: null });
    expect(out).toContain(`<t:${START / 1000}:F>`);
  });
});

describe("meetingAnnouncement names the attendees", () => {
  const meeting = {
    title: "Eboard sync",
    startsAt: START,
    endsAt: START + 90 * 60_000,
    location: null,
    id: "m-42",
    audienceKind: "picked" as const,
    timeZone: "America/New_York",
  };
  const people = [{ userId: "111" }, { userId: "222" }, { userId: "333" }];

  test("lists every attendee as a mention rather than a bare count", () => {
    const out = meetingAnnouncement(meeting, people);
    expect(out).toContain("**Attending:** <@111> <@222> <@333>");
    // The count was the thing being replaced.
    expect(out).not.toContain("3 attendee");
  });

  test("derives duration from the stored window", () => {
    expect(meetingAnnouncement(meeting, people)).toContain("1h30m");
  });

  test("carries the meeting id so /meet cancel is possible", () => {
    expect(meetingAnnouncement(meeting, people)).toContain("`m-42`");
  });

  test("an f26 audience announces the role, still without expanding it", () => {
    const out = meetingAnnouncement({ ...meeting, audienceKind: "f26_roster" }, []);
    expect(out).toContain(`<@&${EBOARD_ROLE_ID}>`);
  });

  test("role plus individuals shows the role first, then the extras", () => {
    const out = meetingAnnouncement({ ...meeting, audienceKind: "f26_roster" }, [{ userId: "999" }]);
    expect(out).toContain(`**Attending:** <@&${EBOARD_ROLE_ID}> <@999>`);
  });

  test("an empty picked audience says so rather than rendering a blank line", () => {
    expect(meetingAnnouncement(meeting, [])).toContain("nobody yet");
  });

  test("includes a location when set", () => {
    expect(meetingAnnouncement({ ...meeting, location: "Zoom" }, people)).toContain("📍 Zoom");
  });
});

describe("role and person selectors compose into one invitee list", () => {
  const rows = audienceRows("draft-1").map((r) => r.toJSON() as {
    components: Array<{
      type: number;
      custom_id: string;
      label?: string;
      placeholder?: string;
      options?: Array<{ label: string; value: string; default?: boolean }>;
    }>;
  });

  test("three rows: roles, people, actions", () => {
    expect(rows).toHaveLength(3);
    expect(rows[0]!.components[0]!.custom_id).toBe("meet-roles:draft-1");
    expect(rows[1]!.components[0]!.custom_id).toBe("meet-users:draft-1");
    expect(rows[2]!.components.map((c) => c.custom_id)).toEqual([
      "meet-review:draft-1",
      "meet-discard:draft-1",
    ]);
  });

  test("the role menu names @Eboard and is optional", () => {
    const roles = rows[0]!.components[0]!;
    expect(roles.type).toBe(3); // string select
    expect(roles.options!.map((o) => o.label)).toContain("@Eboard");
    expect(roles.options!.map((o) => o.value)).toContain(EBOARD_ROLE_ID);
  });

  test("the person menu is a guild-wide user select, so outside collaborators are reachable", () => {
    const users = rows[1]!.components[0]!;
    // Type 5 = user select. A roster-derived menu could never offer someone
    // who has no binding yet, which is exactly the collaborator case.
    expect(users.type).toBe(5);
    expect(users.placeholder).toContain("individual");
  });

  test("prior selections re-render as defaults so neither half looks cleared", () => {
    const withRole = audienceRows("d", { roleIds: [EBOARD_ROLE_ID] })[0]!.toJSON() as {
      components: Array<{ options: Array<{ value: string; default?: boolean }> }>;
    };
    const option = withRole.components[0]!.options.find((o) => o.value === EBOARD_ROLE_ID)!;
    expect(option.default).toBe(true);
  });
});

describe("audienceLine tallies the composed audience", () => {
  test("role only", () => {
    expect(audienceLine({ audienceKind: "f26_roster", participants: [] })).toContain("@Eboard");
  });

  test("people only", () => {
    const out = audienceLine({
      audienceKind: "picked",
      participants: [{ displayName: "Ada" }, { displayName: "Bo" }],
    });
    expect(out).toContain("**2** individually");
    expect(out).toContain("Ada, Bo");
    expect(out).not.toContain("@Eboard");
  });

  test("role AND people is the whole point -- both are reported", () => {
    const out = audienceLine({
      audienceKind: "f26_roster",
      participants: [{ displayName: "Outside Collab" }],
    });
    expect(out).toContain("@Eboard");
    expect(out).toContain("Outside Collab");
    expect(out).toContain("plus");
  });

  test("nothing chosen yet says so rather than rendering an empty list", () => {
    expect(audienceLine({ audienceKind: "picked", participants: [] })).toContain("No one selected");
  });
});
