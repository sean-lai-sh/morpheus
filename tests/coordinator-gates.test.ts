import { describe, expect, test } from "bun:test";
import { authorPassesRoleGate } from "../src/bot/enqueue.ts";
import { assertCoordinatorCreate, assertMeetInvoke } from "../src/coordinator/gates.ts";
import {
  EBOARD_ROLE_ID,
  LEADERSHIP_ROLE_ID,
  SENIOR_ADV_ROLE_ID,
} from "../src/coordinator/roster-map.ts";

const ROLE = "role-eboard";
const CHANNEL = "1001";

describe("coordinator create gates", () => {
  const resolveChannel = (id: string) => (id === CHANNEL ? { workspace: "eboard" } : undefined);

  test("empty trigger role set fail-closes create", () => {
    expect(authorPassesRoleGate([ROLE], new Set())).toBe(false);
    const gate = assertCoordinatorCreate({
      roleIds: [ROLE],
      channelId: CHANNEL,
      triggerRoleIds: new Set(),
      resolveChannel,
    });
    expect(gate).toEqual({ ok: false, reason: "role-gate" });
  });

  test("author without a trigger role fail-closes create", () => {
    const gate = assertCoordinatorCreate({
      roleIds: ["other"],
      channelId: CHANNEL,
      triggerRoleIds: new Set([ROLE]),
      resolveChannel,
    });
    expect(gate).toEqual({ ok: false, reason: "role-gate" });
  });

  test("non-allowlisted channel fail-closes create", () => {
    const gate = assertCoordinatorCreate({
      roleIds: [ROLE],
      channelId: "9999",
      triggerRoleIds: new Set([ROLE]),
      resolveChannel,
    });
    expect(gate).toEqual({ ok: false, reason: "channel-not-allowlisted" });
  });

  test("role + allowlisted channel passes", () => {
    const gate = assertCoordinatorCreate({
      roleIds: [ROLE],
      channelId: CHANNEL,
      triggerRoleIds: new Set([ROLE]),
      resolveChannel,
    });
    expect(gate).toEqual({ ok: true });
  });

  test("thread parent is the allowlist id", () => {
    const gate = assertCoordinatorCreate({
      roleIds: [ROLE],
      channelId: "thread-1",
      parentChannelId: CHANNEL,
      triggerRoleIds: new Set([ROLE]),
      resolveChannel,
    });
    expect(gate).toEqual({ ok: true });
  });
});

describe("meet invoke gate", () => {
  const resolveChannel = (id: string) => (id === CHANNEL ? { workspace: "eboard" } : undefined);

  test("Eboard, Leadership, or Senior Adv can invoke /meet", () => {
    for (const role of [EBOARD_ROLE_ID, LEADERSHIP_ROLE_ID, SENIOR_ADV_ROLE_ID]) {
      expect(
        assertMeetInvoke({
          roleIds: [role],
          channelId: CHANNEL,
          resolveChannel,
        }),
      ).toEqual({ ok: true });
    }
  });

  test("a member with none of those roles fail-closes", () => {
    expect(
      assertMeetInvoke({
        roleIds: ["999"],
        channelId: CHANNEL,
        resolveChannel,
      }),
    ).toEqual({ ok: false, reason: "role-gate" });
    expect(
      assertMeetInvoke({
        roleIds: [],
        channelId: CHANNEL,
        resolveChannel,
      }),
    ).toEqual({ ok: false, reason: "role-gate" });
  });

  test("empty override set fail-closes even if the author has Eboard", () => {
    expect(
      assertMeetInvoke({
        roleIds: [EBOARD_ROLE_ID],
        channelId: CHANNEL,
        triggerRoleIds: new Set(),
        resolveChannel,
      }),
    ).toEqual({ ok: false, reason: "role-gate" });
  });
});
