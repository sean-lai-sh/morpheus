import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { withTempCwd, withTempDb } from "./helpers.ts";
import {
  appendBlock,
  channelFilePath,
  channelSlug,
  renderBlock,
  rerenderChannel,
} from "../src/storage/markdown.ts";
import { upsertMessage, getMessage } from "../src/storage/messages.ts";
import { extractLinks, persistLinks, linksForMessage } from "../src/storage/links.ts";

const cwd = withTempCwd();
const db = withTempDb();
beforeAll(() => {});
afterAll(() => {
  db.cleanup();
  cwd.cleanup();
});

const channel = { id: "999888777666555444", name: "Eboard - General" };
const guildId = "111";

describe("markdown/channelSlug", () => {
  test("normalizes name and suffixes last 4 of id", () => {
    expect(channelSlug("Eboard - General", "999888777666555444")).toBe("eboard-general-5444");
  });

  test("falls back to 'channel' for empty/punctuation-only names", () => {
    expect(channelSlug("!!!", "1234")).toBe("channel-1234");
  });

  test("does not collide on rename within same channel id last4", () => {
    expect(channelSlug("Logistics", "12340000")).not.toBe(channelSlug("logistics-v2", "12340000"));
  });
});

describe("markdown/renderBlock", () => {
  test("create variant contains author and message id", () => {
    upsertMessage({
      id: "r1",
      channelId: channel.id,
      authorId: "u1",
      authorName: "alice",
      content: "test",
      createdAt: Date.parse("2026-04-28T14:32:00Z"),
    });
    const block = renderBlock({ msg: getMessage("r1")!, links: [], variant: "create" });
    expect(block).toContain("@alice");
    expect(block).toContain("(msg:r1)");
    expect(block).not.toContain("Classification");
  });

  test("edit variant header includes EDIT marker", () => {
    const block = renderBlock({ msg: getMessage("r1")!, links: [], variant: "edit" });
    expect(block).toContain("EDIT (edit of msg:r1)");
  });

  test("delete variant emits tombstone", () => {
    const block = renderBlock({ msg: getMessage("r1")!, links: [], variant: "delete" });
    expect(block).toContain("DELETED (tombstone for msg:r1)");
    expect(block).toContain("[content removed]");
  });

  test("links line included when links present", () => {
    upsertMessage({
      id: "r2",
      channelId: channel.id,
      authorId: "u1",
      authorName: "alice",
      content: "see https://docs.google.com/document/d/AAAAAAAAAAAAAAAAAAAA/edit",
      createdAt: Date.parse("2026-04-28T14:32:00Z"),
    });
    const links = extractLinks(getMessage("r2")!.content);
    persistLinks("r2", channel.id, links);
    const block = renderBlock({ msg: getMessage("r2")!, links: linksForMessage("r2"), variant: "create" });
    expect(block).toContain("**Links**:");
    expect(block).toContain("docs.google.com/document/d/AAAAAAAAAAAAAAAAAAAA");
  });
});

describe("markdown/appendBlock", () => {
  test("creates file with header on first append", () => {
    const path = channelFilePath(channel);
    appendBlock(channel, guildId, getMessage("r2")!, "create");
    const body = readFileSync(path, "utf8");
    expect(body).toContain(`# #${channel.name}`);
    expect(body).toContain(`channel_id: ${channel.id}`);
    expect(body).toContain(`guild_id: ${guildId}`);
  });

  test("appends without rewriting prior content", () => {
    const path = channelFilePath(channel);
    const before = readFileSync(path, "utf8");
    appendBlock(channel, guildId, getMessage("r2")!, "edit");
    const after = readFileSync(path, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("EDIT (edit of msg:r2)");
  });
});

describe("markdown/rerenderChannel", () => {
  test("includes all messages regardless of classification", () => {
    upsertMessage({
      id: "r3",
      channelId: channel.id,
      authorId: "u3",
      authorName: "carol",
      content: "lol same",
      createdAt: Date.parse("2026-04-28T14:35:00Z"),
    });
    const written = rerenderChannel(channel, guildId);
    // r1, r2, r3 — all written
    expect(written).toBe(3);
    const body = readFileSync(channelFilePath(channel), "utf8");
    expect(body).toContain("lol same");
  });
});
