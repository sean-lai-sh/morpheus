import { describe, expect, test } from "bun:test";
import {
  MEET_COMMAND,
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

describe("meetingAnnouncement", () => {
  const meeting = {
    title: "Eboard sync",
    startsAt: START,
    endsAt: START + 90 * 60_000,
    location: null,
    id: "m-42",
    audienceKind: "picked" as const,
  };

  test("derives duration from the stored window", () => {
    expect(meetingAnnouncement(meeting, 3)).toContain("1h30m");
  });

  test("carries the meeting id so /meet cancel is possible", () => {
    expect(meetingAnnouncement(meeting, 3)).toContain("`m-42`");
  });

  test("does not expand the role for an f26 audience", () => {
    const out = meetingAnnouncement({ ...meeting, audienceKind: "f26_roster" }, 29);
    expect(out).toContain("role is not expanded");
    expect(out).not.toContain("29 attendee");
  });

  test("reports the attendee count for a picked audience", () => {
    expect(meetingAnnouncement(meeting, 3)).toContain("3 attendee(s)");
  });

  test("includes a location when set", () => {
    expect(meetingAnnouncement({ ...meeting, location: "Zoom" }, 1)).toContain("📍 Zoom");
  });
});

describe("audience controls offer both a role path and an individual path", () => {
  const rows = audienceRows("draft-1").map((r) => r.toJSON() as {
    components: Array<{ type: number; custom_id: string; label?: string; placeholder?: string }>;
  });

  test("row one is the mentionable select, so anyone in the guild can be added", () => {
    const select = rows[0]!.components[0]!;
    expect(select.custom_id).toBe("meet-audience:draft-1");
    // Type 7 = mentionable select. Kept deliberately: a collaborator from
    // outside the eboard has no roster binding yet but must still be pickable.
    expect(select.type).toBe(7);
    expect(select.placeholder).toContain("individual");
  });

  test("row two offers @Eboard by name as a one-click button", () => {
    const buttons = rows[1]!.components;
    expect(buttons.map((b) => b.custom_id)).toEqual([
      "meet-roster-all:draft-1",
      "meet-discard:draft-1",
    ]);
    expect(buttons[0]!.label).toBe("Invite @Eboard");
  });

  test("exactly two rows -- no paged roster menus", () => {
    expect(rows).toHaveLength(2);
  });
});
