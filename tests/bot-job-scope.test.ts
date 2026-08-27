import { describe, expect, test } from "bun:test";
import { PermissionFlagsBits } from "discord.js";
import {
  authorCanViewChannel,
  mentionChannelIds,
  resolveJobChannelScope,
} from "../src/bot/job-scope.ts";
import type { ChannelResolver } from "../src/storage/jobs.ts";

const GENERAL = "111111111111111111";
const MARKETING = "333333333333333333";
const LEADERSHIP = "222222222222222222";
const UNKNOWN = "999999999999999999";

const resolveChannel: ChannelResolver = (id) => {
  if (id === GENERAL || id === MARKETING) return { isolated: false, include_threads: true };
  if (id === LEADERSHIP) return { isolated: true };
  return undefined;
};

describe("mentionChannelIds", () => {
  test("parses <#id> and mentions.channels keys", () => {
    const mentions = new Map([[MARKETING, {}]]);
    expect(
      mentionChannelIds({
        content: `see <#${GENERAL}> and <#${MARKETING}>`,
        mentions: { channels: mentions },
      }),
    ).toEqual(expect.arrayContaining([GENERAL, MARKETING]));
  });
});

describe("authorCanViewChannel", () => {
  test("fail closed when member or channel cache is missing", () => {
    expect(authorCanViewChannel({ member: { id: "m" } }, GENERAL)).toBe(false);
    expect(
      authorCanViewChannel(
        {
          member: undefined,
          guild: { channels: { cache: { get: () => ({ permissionsFor: () => ({ has: () => true }) }) } } },
        },
        GENERAL,
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
          guild: { channels: { cache: { get: (id: string) => (id === MARKETING ? channel : undefined) } } },
        },
        MARKETING,
      ),
    ).toBe(true);
  });
});

describe("resolveJobChannelScope", () => {
  test("leadership is unrestricted", () => {
    expect(
      resolveJobChannelScope({
        namespace: "leadership",
        originatingChannelId: LEADERSHIP,
        threadId: null,
        mentionedChannelIds: [GENERAL],
        canViewChannel: () => true,
        resolveChannel,
      }),
    ).toEqual({ scope: "leadership", channelIds: [] });
  });

  test("general defaults to originating only", () => {
    expect(
      resolveJobChannelScope({
        namespace: "general",
        originatingChannelId: GENERAL,
        threadId: null,
        mentionedChannelIds: [],
        canViewChannel: () => false,
        resolveChannel,
      }),
    ).toEqual({ scope: "channel", channelIds: [GENERAL] });
  });

  test("thread trigger includes parent + thread", () => {
    const thread = "555555555555555555";
    expect(
      resolveJobChannelScope({
        namespace: "general",
        originatingChannelId: GENERAL,
        threadId: thread,
        mentionedChannelIds: [],
        canViewChannel: () => false,
        resolveChannel,
      }).channelIds,
    ).toEqual([GENERAL, thread]);
  });

  test("same-namespace mention with ViewChannel is added", () => {
    expect(
      resolveJobChannelScope({
        namespace: "general",
        originatingChannelId: GENERAL,
        threadId: null,
        mentionedChannelIds: [MARKETING],
        canViewChannel: (id) => id === MARKETING,
        resolveChannel,
      }).channelIds,
    ).toEqual([GENERAL, MARKETING]);
  });

  test("mention without ViewChannel is ignored", () => {
    expect(
      resolveJobChannelScope({
        namespace: "general",
        originatingChannelId: GENERAL,
        threadId: null,
        mentionedChannelIds: [MARKETING],
        canViewChannel: () => false,
        resolveChannel,
      }).channelIds,
    ).toEqual([GENERAL]);
  });

  test("isolated mention is not added to a general job", () => {
    expect(
      resolveJobChannelScope({
        namespace: "general",
        originatingChannelId: GENERAL,
        threadId: null,
        mentionedChannelIds: [LEADERSHIP],
        canViewChannel: () => true,
        resolveChannel,
      }).channelIds,
    ).toEqual([GENERAL]);
  });

  test("unknown / non-indexed mention is not added", () => {
    expect(
      resolveJobChannelScope({
        namespace: "general",
        originatingChannelId: GENERAL,
        threadId: null,
        mentionedChannelIds: [UNKNOWN],
        canViewChannel: () => true,
        resolveChannel,
      }).channelIds,
    ).toEqual([GENERAL]);
  });
});
