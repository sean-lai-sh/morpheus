import { describe, expect, test } from "bun:test";
import { PermissionFlagsBits } from "discord.js";
import {
  authorCanViewChannel,
  mentionChannelIds,
  resolveJobChannelScope,
} from "../src/bot/job-scope.ts";
import type { ChannelResolver } from "../src/context/namespace.ts";
import {
  DEV_CHAT,
  EBOARD,
  GENERAL_CHAT,
  LEADERSHIP,
  LEADERSHIP_TEAM,
  MENTORSHIP_CHAT,
  PROGRAMS_DEV,
  PROGRAMS_MENTORSHIP,
  SPONSORS,
} from "./jobs-fixture.ts";

const UNKNOWN = "999999999999999999";

/** The canonical tree, injected — this suite never reads channels.yml. */
const WORKSPACES: Record<string, { parent?: string }> = {
  [LEADERSHIP]: {},
  [EBOARD]: { parent: LEADERSHIP },
  [PROGRAMS_MENTORSHIP]: { parent: EBOARD },
  [PROGRAMS_DEV]: { parent: EBOARD },
};
const resolveWorkspace = (id: string) => WORKSPACES[id];
const visibleWorkspaces = (root: string): ReadonlySet<string> => {
  const out = new Set<string>();
  if (!(root in WORKSPACES)) return out;
  const queue = [root];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const [id, w] of Object.entries(WORKSPACES)) if (w.parent === cur) queue.push(id);
  }
  return out;
};

const CHANNELS: Record<string, { workspace: string; include_threads?: boolean }> = {
  [SPONSORS]: { workspace: EBOARD },
  [GENERAL_CHAT]: { workspace: EBOARD },
  [LEADERSHIP_TEAM]: { workspace: LEADERSHIP, include_threads: true },
  [MENTORSHIP_CHAT]: { workspace: PROGRAMS_MENTORSHIP },
  [DEV_CHAT]: { workspace: PROGRAMS_DEV, include_threads: true },
};
const resolveChannel: ChannelResolver = (id) => CHANNELS[id];

function scopeFor(namespace: string, over: Partial<Parameters<typeof resolveJobChannelScope>[0]> = {}) {
  return resolveJobChannelScope({
    namespace,
    originatingChannelId: SPONSORS,
    threadId: null,
    mentionedChannelIds: [],
    canViewChannel: () => false,
    resolveChannel,
    resolveWorkspace,
    visibleWorkspaces,
    ...over,
  });
}

describe("mentionChannelIds", () => {
  test("parses <#id> and mentions.channels keys", () => {
    const mentions = new Map([[DEV_CHAT, {}]]);
    expect(
      mentionChannelIds({
        content: `see <#${SPONSORS}> and <#${DEV_CHAT}>`,
        mentions: { channels: mentions },
      }),
    ).toEqual(expect.arrayContaining([SPONSORS, DEV_CHAT]));
  });
});

describe("authorCanViewChannel", () => {
  test("fail closed when member or channel cache is missing", () => {
    expect(authorCanViewChannel({ member: { id: "m" } }, SPONSORS)).toBe(false);
    expect(
      authorCanViewChannel(
        {
          member: undefined,
          guild: { channels: { cache: { get: () => ({ permissionsFor: () => ({ has: () => true }) }) } } },
        },
        SPONSORS,
      ),
    ).toBe(false);
  });

  test("true when permissionsFor has ViewChannel", () => {
    const channel = {
      permissionsFor: () => ({
        has: (perm: bigint) => perm === PermissionFlagsBits.ViewChannel,
      }),
    };
    expect(
      authorCanViewChannel(
        {
          member: { id: "m" },
          guild: { channels: { cache: { get: (id: string) => (id === DEV_CHAT ? channel : undefined) } } },
        },
        DEV_CHAT,
      ),
    ).toBe(true);
  });
});

describe("resolveJobChannelScope", () => {
  test("a root workspace is unrestricted inside its subtree", () => {
    expect(
      scopeFor(LEADERSHIP, {
        originatingChannelId: LEADERSHIP_TEAM,
        mentionedChannelIds: [SPONSORS],
        canViewChannel: () => true,
      }),
    ).toEqual({ scope: "workspace", channelIds: [] });
  });

  test("a non-root workspace is channel-scoped, originating only by default", () => {
    expect(scopeFor(EBOARD)).toEqual({ scope: "channel", channelIds: [SPONSORS] });
  });

  test("an unknown workspace falls back to channel scope (fail closed)", () => {
    expect(scopeFor("does-not-exist")).toEqual({ scope: "channel", channelIds: [SPONSORS] });
  });

  test("thread trigger includes parent + thread", () => {
    const thread = "555555555555555555";
    expect(scopeFor(EBOARD, { threadId: thread }).channelIds).toEqual([SPONSORS, thread]);
  });

  test("same-workspace mention with ViewChannel is added", () => {
    expect(
      scopeFor(EBOARD, {
        mentionedChannelIds: [GENERAL_CHAT],
        canViewChannel: (id) => id === GENERAL_CHAT,
      }).channelIds,
    ).toEqual([SPONSORS, GENERAL_CHAT]);
  });

  test("a descendant-workspace mention is visible to an eboard job", () => {
    expect(
      scopeFor(EBOARD, {
        mentionedChannelIds: [DEV_CHAT, MENTORSHIP_CHAT],
        canViewChannel: () => true,
      }).channelIds,
    ).toEqual([SPONSORS, DEV_CHAT, MENTORSHIP_CHAT]);
  });

  test("a sibling workspace is NOT visible to a programs-mentorship job", () => {
    expect(
      scopeFor(PROGRAMS_MENTORSHIP, {
        originatingChannelId: MENTORSHIP_CHAT,
        mentionedChannelIds: [DEV_CHAT, SPONSORS],
        canViewChannel: () => true,
      }).channelIds,
    ).toEqual([MENTORSHIP_CHAT]);
  });

  test("a parent-workspace mention is not added to a child job", () => {
    expect(
      scopeFor(EBOARD, {
        mentionedChannelIds: [LEADERSHIP_TEAM],
        canViewChannel: () => true,
      }).channelIds,
    ).toEqual([SPONSORS]);
  });

  test("mention without ViewChannel is ignored", () => {
    expect(
      scopeFor(EBOARD, { mentionedChannelIds: [GENERAL_CHAT], canViewChannel: () => false }).channelIds,
    ).toEqual([SPONSORS]);
  });

  test("unknown / non-indexed mention is not added", () => {
    expect(
      scopeFor(EBOARD, { mentionedChannelIds: [UNKNOWN], canViewChannel: () => true }).channelIds,
    ).toEqual([SPONSORS]);
  });
});
