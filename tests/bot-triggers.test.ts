import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { isMentionTrigger, isReplyToBot, threadParentId } from "../src/bot/triggers.ts";

const BOT = "123456789012345678";

describe("isMentionTrigger", () => {
  test("matches <@id>", () => {
    expect(isMentionTrigger(`hey <@${BOT}>`, BOT)).toBe(true);
  });

  test("matches <@!id> nickname mention", () => {
    expect(isMentionTrigger(`<@!${BOT}>`, BOT)).toBe(true);
  });

  test("bare mention is enough (ingest too-short must not matter)", () => {
    expect(isMentionTrigger(`<@${BOT}>`, BOT)).toBe(true);
  });

  test("matches mention cache even if content was stripped", () => {
    expect(isMentionTrigger("", BOT, [BOT])).toBe(true);
  });

  test("does not match another user", () => {
    expect(isMentionTrigger("<@999>", BOT, ["999"])).toBe(false);
  });
});

describe("isReplyToBot", () => {
  test("true when referenced message is this bot", () => {
    expect(
      isReplyToBot(
        {
          reference: { messageId: "m1" },
          referencedMessage: { author: { id: BOT, bot: true } },
        },
        BOT,
      ),
    ).toBe(true);
  });

  test("true via mentions.repliedUser when referencedMessage is uncached", () => {
    expect(
      isReplyToBot(
        {
          reference: { messageId: "m1" },
          repliedUser: { id: BOT, bot: true },
        },
        BOT,
      ),
    ).toBe(true);
  });

  test("false when reply is to a human", () => {
    expect(
      isReplyToBot(
        {
          reference: { messageId: "m1" },
          referencedMessage: { author: { id: "human", bot: false } },
        },
        BOT,
      ),
    ).toBe(false);
  });

  test("false without a reply reference", () => {
    expect(isReplyToBot({ referencedMessage: { author: { id: BOT } } }, BOT)).toBe(false);
  });
});

describe("threadParentId", () => {
  test("returns parent for public threads", () => {
    expect(
      threadParentId({
        channel: { type: ChannelType.PublicThread, parentId: "parent-1" },
      }),
    ).toBe("parent-1");
  });

  test("null for a guild text channel", () => {
    expect(threadParentId({ channel: { type: ChannelType.GuildText } })).toBeNull();
  });
});
