import { describe, expect, test } from "bun:test";
import { authorPassesRoleGate } from "../src/bot/enqueue.ts";
import { assertCoordinatorCreate } from "../src/coordinator/gates.ts";

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
