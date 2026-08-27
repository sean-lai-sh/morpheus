import { PermissionFlagsBits } from "discord.js";
import {
  MAX_JOB_CHANNEL_IDS,
  type ChannelResolver,
  type JobScope,
  type Namespace,
} from "../storage/jobs.ts";

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

export function resolveJobChannelScope(input: {
  namespace: Namespace;
  originatingChannelId: string;
  threadId: string | null;
  mentionedChannelIds: string[];
  canViewChannel: (channelId: string) => boolean;
  resolveChannel: ChannelResolver;
}): { scope: JobScope; channelIds: string[] } {
  if (input.namespace === "leadership") {
    return { scope: "leadership", channelIds: [] };
  }

  const ids: string[] = [];
  const add = (id: string): void => {
    if (!id || ids.includes(id)) return;
    if (ids.length >= MAX_JOB_CHANNEL_IDS) return;
    ids.push(id);
  };

  add(input.originatingChannelId);
  if (input.threadId) add(input.threadId);

  for (const raw of input.mentionedChannelIds) {
    const id = raw.trim();
    if (!/^\d+$/.test(id)) continue;
    const ch = input.resolveChannel(id);
    if (!ch) continue;
    const ns: Namespace = ch.isolated ? "leadership" : "general";
    if (ns !== input.namespace) continue;
    if (!input.canViewChannel(id)) continue;
    add(id);
  }

  return { scope: "channel", channelIds: ids };
}
