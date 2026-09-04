import { getChannel, jobTriggerRoleIds } from "../config.ts";
import { authorPassesRoleGate } from "../bot/enqueue.ts";
import { MEET_INVOKE_ROLE_IDS } from "./roster-map.ts";

export type CoordinatorCreateDeny = "role-gate" | "channel-not-allowlisted";

export type CoordinatorCreateGate = { ok: true } | { ok: false; reason: CoordinatorCreateDeny };

export interface CoordinatorCreateInput {
  roleIds: string[];
  channelId: string;
  parentChannelId?: string | null;
  triggerRoleIds?: Set<string>;
  resolveChannel?: (id: string) => { workspace?: string } | undefined;
}

/**
 * /task create and /meet create share the job trigger gate: empty role set
 * fail-closes, and the parent/channel must be allowlisted in channels.yml.
 */
export function assertCoordinatorCreate(input: CoordinatorCreateInput): CoordinatorCreateGate {
  const roles = input.triggerRoleIds ?? jobTriggerRoleIds();
  if (!authorPassesRoleGate(input.roleIds, roles)) {
    return { ok: false, reason: "role-gate" };
  }
  const resolve = input.resolveChannel ?? getChannel;
  const id = input.parentChannelId ?? input.channelId;
  if (!id || !resolve(id)) {
    return { ok: false, reason: "channel-not-allowlisted" };
  }
  return { ok: true };
}

/**
 * /meet create|cancel|seed and mention-booking. Fail-closed on the three
 * Eboard / Leadership / Senior Adv snowflakes — not the full JOB_TRIGGER set.
 */
export function assertMeetInvoke(input: CoordinatorCreateInput): CoordinatorCreateGate {
  const roles = input.triggerRoleIds ?? MEET_INVOKE_ROLE_IDS;
  if (!authorPassesRoleGate(input.roleIds, roles)) {
    return { ok: false, reason: "role-gate" };
  }
  const resolve = input.resolveChannel ?? getChannel;
  const id = input.parentChannelId ?? input.channelId;
  if (!id || !resolve(id)) {
    return { ok: false, reason: "channel-not-allowlisted" };
  }
  return { ok: true };
}
