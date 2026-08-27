import { PermissionFlagsBits } from "discord.js";
import { getWorkspace, visibleWorkspaces } from "../config.ts";
import type { ChannelResolver } from "../context/namespace.ts";
import type { Namespace } from "../context/types.ts";
import { MAX_JOB_CHANNEL_IDS, type JobScope } from "../storage/jobs.ts";

export { MAX_JOB_CHANNEL_IDS };

const CHANNEL_MENTION_RE = /<#(\d+)>/g;

/** Channel ids from `<#id>` tokens and discord.js `mentions.channels`. */
export function mentionChannelIds(message: {
  content?: string | null;
  mentions?: { channels?: { keys(): Iterable<string> } | null } | null;
}): string[] {
  const ids = new Set<string>();
  const cache = message.mentions?.channels;
  if (cache) {
    for (const id of cache.keys()) ids.add(id);
  }
  const content = message.content ?? "";
  CHANNEL_MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHANNEL_MENTION_RE.exec(content))) {
    if (m[1]) ids.add(m[1]);
  }
  return [...ids];
}

function memberHasViewChannel(channel: unknown, member: unknown): boolean {
  if (!channel || !member || typeof channel !== "object") return false;
  const permsFor = (channel as { permissionsFor?: (m: unknown) => { has: (perm: bigint) => boolean } | null })
    .permissionsFor;
  if (typeof permsFor !== "function") return false;
  let perms: { has: (perm: bigint) => boolean } | null;
  try {
    perms = permsFor.call(channel, member);
  } catch {
    return false;
  }
  if (!perms || typeof perms.has !== "function") return false;
  try {
    return perms.has(PermissionFlagsBits.ViewChannel);
  } catch {
    return false;
  }
}

/**
 * ViewChannel via discord.js `permissionsFor`. Fail closed if the channel or
 * member is missing from cache.
 */
export function authorCanViewChannel(
  message: {
    member?: unknown;
    guild?: { channels?: { cache?: { get(id: string): unknown } } } | null;
    mentions?: { channels?: { get(id: string): unknown } | null } | null;
  },
  channelId: string,
): boolean {
  const member = message.member;
  if (!member) return false;
  const fromMentions = message.mentions?.channels?.get?.(channelId);
  const fromGuild = message.guild?.channels?.cache?.get?.(channelId);
  const channel = fromMentions ?? fromGuild;
  if (channel == null) return false;
  return memberHasViewChannel(channel, member);
}

export interface ResolveJobChannelScopeInput {
  namespace: Namespace;
  originatingChannelId: string;
  threadId: string | null;
  mentionedChannelIds: string[];
  canViewChannel: (channelId: string) => boolean;
  resolveChannel: ChannelResolver;
  /** Injectable for tests; production reads channels.yml. */
  resolveWorkspace?: (id: string) => { parent?: string } | undefined;
  /** Injectable for tests; production reads channels.yml. */
  visibleWorkspaces?: (root: string) => ReadonlySet<string>;
}

/**
 * A root workspace (no parent) owns its whole subtree, so its jobs are unrestricted
 * inside it. Anything else is channel-scoped. An unknown workspace falls through to
 * channel scope — fail closed, never unrestricted.
 */
export function resolveJobChannelScope(
  input: ResolveJobChannelScopeInput,
): { scope: JobScope; channelIds: string[] } {
  const resolveWorkspace = input.resolveWorkspace ?? getWorkspace;
  const workspace = resolveWorkspace(input.namespace);
  if (workspace && workspace.parent == null) {
    return { scope: "workspace", channelIds: [] };
  }

  const ids: string[] = [];
  const add = (id: string): void => {
    if (!id || ids.includes(id)) return;
    if (ids.length >= MAX_JOB_CHANNEL_IDS) return;
    ids.push(id);
  };

  add(input.originatingChannelId);
  if (input.threadId) add(input.threadId);

  const visible = (input.visibleWorkspaces ?? visibleWorkspaces)(input.namespace);
  for (const raw of input.mentionedChannelIds) {
    const id = raw.trim();
    if (!/^\d+$/.test(id)) continue;
    const ch = input.resolveChannel(id);
    if (!ch) continue;
    if (!visible.has(ch.workspace)) continue;
    if (!input.canViewChannel(id)) continue;
    add(id);
  }

  return { scope: "channel", channelIds: ids };
}
