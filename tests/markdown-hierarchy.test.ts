import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { withTempCwd, withTempDb } from "./helpers.ts";
import {
  appendBlock,
  channelFilePath,
  channelSlug,
  discordDir,
  legacyDir,
  removeLegacyNamespaceDirs,
  rerenderChannel,
  workspaceDir,
} from "../src/storage/markdown.ts";
import type { ChannelKey } from "../src/storage/markdown.ts";
import { getMessage, upsertMessage } from "../src/storage/messages.ts";
import { getSyncState } from "../src/storage/sync-state.ts";

const cwd = withTempCwd();
const db = withTempDb();
beforeAll(() => {});
afterAll(() => {
  db.cleanup();
  cwd.cleanup();
});

const guildId = "987654321098765432";
const DISCORD_DIR = discordDir();
const LEGACY_DIR = legacyDir();
const EBOARD_DIR = workspaceDir("eboard");
const LEADERSHIP_DIR = workspaceDir("leadership");

// ── Path structure ──────────────────────────────────────────────────────────

describe("markdown/hierarchy — channelFilePath", () => {
  test("no category: resolves directly under the workspace root", () => {
    const ch: ChannelKey = { id: "111", name: "eboard-chat", workspace: "eboard" };
    const slug = channelSlug("eboard-chat", "111");
    expect(channelFilePath(ch)).toBe(resolve(DISCORD_DIR, "eboard", slug, "main.md"));
  });

  test("with category: resolves under {workspace}/{category}/{slug}", () => {
    const ch: ChannelKey = {
      id: "222",
      name: "startup-week-team",
      category: "eboard-teams",
      workspace: "eboard",
    };
    const slug = channelSlug("startup-week-team", "222");
    expect(channelFilePath(ch)).toBe(resolve(DISCORD_DIR, "eboard", "eboard-teams", slug, "main.md"));
  });

  test("a different workspace gets a different root", () => {
    const ch: ChannelKey = {
      id: "333",
      name: "leadership-team",
      category: "eboard-teams",
      workspace: "leadership",
    };
    const slug = channelSlug("leadership-team", "333");
    expect(channelFilePath(ch)).toBe(resolve(DISCORD_DIR, "leadership", "eboard-teams", slug, "main.md"));
  });

  test("a nested workspace is still one flat directory, not a nested tree", () => {
    const ch: ChannelKey = { id: "444", name: "dev-chat", category: "programs", workspace: "programs-dev" };
    expect(channelFilePath(ch)).toBe(
      resolve(DISCORD_DIR, "programs-dev", "programs", channelSlug("dev-chat", "444"), "main.md"),
    );
  });
});

// ── appendBlock routing ──────────────────────────────────────────────────────

describe("markdown/hierarchy — appendBlock routing", () => {
  const mainChannel: ChannelKey = {
    id: "500",
    name: "events-team",
    category: "eboard-teams",
    workspace: "eboard",
  };

  test("non-thread message writes to main.md and marks the workspace dir dirty", () => {
    upsertMessage({
      id: "msg-main-1",
      channelId: "500",
      authorId: "u1",
      authorName: "Alice",
      content: "hello from main",
      createdAt: 1_000,
    });
    const msg = getMessage("msg-main-1")!;
    appendBlock(mainChannel, guildId, msg, "create");

    const path = channelFilePath(mainChannel);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("hello from main");

    expect(getSyncState(workspaceDir("eboard")).dirty).toBe(1);
  });

  test("thread message writes to threads/{slug}.md, not main.md", () => {
    upsertMessage({
      id: "msg-thread-1",
      channelId: "thread-500",
      parentChannelId: "500",
      authorId: "u1",
      authorName: "Alice",
      content: "reply in thread",
      createdAt: 2_000,
      threadId: "thread-500",
      threadName: "Speaker Coordination",
    });
    const msg = getMessage("msg-thread-1")!;
    appendBlock(mainChannel, guildId, msg, "create");

    const mainContent = readFileSync(channelFilePath(mainChannel), "utf8");
    expect(mainContent).not.toContain("reply in thread");

    const slug = channelSlug("Speaker Coordination", "thread-500");
    const threadPath = resolve(
      EBOARD_DIR,
      "eboard-teams",
      channelSlug("events-team", "500"),
      "threads",
      `${slug}.md`,
    );
    expect(existsSync(threadPath)).toBe(true);
    expect(readFileSync(threadPath, "utf8")).toContain("reply in thread");
  });

  test("thread file header contains starter_message_id equal to thread_id", () => {
    const slug = channelSlug("Speaker Coordination", "thread-500");
    const threadPath = resolve(
      EBOARD_DIR,
      "eboard-teams",
      channelSlug("events-team", "500"),
      "threads",
      `${slug}.md`,
    );
    const content = readFileSync(threadPath, "utf8");
    expect(content).toContain("starter_message_id: thread-500");
    expect(content).toContain("thread_id: thread-500");
    expect(content).toContain("parent_channel_id: 500");
  });

  test("a leadership channel writes under its own workspace dir and marks it dirty", () => {
    const leadershipChannel: ChannelKey = {
      id: "600",
      name: "leadership-team",
      category: "eboard-teams",
      workspace: "leadership",
    };
    upsertMessage({
      id: "msg-leadership-1",
      channelId: "600",
      authorId: "u2",
      authorName: "Bob",
      content: "sensitive planning note",
      createdAt: 3_000,
    });
    const msg = getMessage("msg-leadership-1")!;
    appendBlock(leadershipChannel, guildId, msg, "create");

    const path = channelFilePath(leadershipChannel);
    expect(path.startsWith(LEADERSHIP_DIR)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("sensitive planning note");

    expect(getSyncState(workspaceDir("leadership")).dirty).toBe(1);
  });

  test("leadership content never lands under another workspace's dir", () => {
    const { readdirSync, statSync } = require("node:fs");
    function collectTexts(dir: string): string {
      if (!existsSync(dir)) return "";
      let out = "";
      for (const name of readdirSync(dir) as string[]) {
        const full = resolve(dir, name);
        if (statSync(full).isDirectory()) out += collectTexts(full);
        else if (name.endsWith(".md")) out += readFileSync(full, "utf8");
      }
      return out;
    }
    expect(collectTexts(EBOARD_DIR)).not.toContain("sensitive planning note");
  });
});

// ── rerenderChannel ─────────────────────────────────────────────────────────

describe("markdown/hierarchy — rerenderChannel", () => {
  const ch: ChannelKey = { id: "700", name: "dev-team", category: "eboard-teams", workspace: "eboard" };

  beforeAll(() => {
    upsertMessage({
      id: "rc-main",
      channelId: "700",
      authorId: "u1",
      authorName: "Dev",
      content: "main channel post",
      createdAt: 1_000,
    });
    upsertMessage({
      id: "rc-thread",
      channelId: "thread-700",
      parentChannelId: "700",
      authorId: "u1",
      authorName: "Dev",
      content: "thread discussion",
      createdAt: 2_000,
      threadId: "thread-700",
      threadName: "Feature Planning",
    });
  });

  test("rerenderChannel writes main.md with only non-thread messages", () => {
    rerenderChannel(ch, guildId);
    const mainContent = readFileSync(channelFilePath(ch), "utf8");
    expect(mainContent).toContain("main channel post");
    expect(mainContent).not.toContain("thread discussion");
  });

  test("rerenderChannel writes thread file with thread messages", () => {
    const slug = channelSlug("Feature Planning", "thread-700");
    const threadPath = resolve(
      EBOARD_DIR,
      "eboard-teams",
      channelSlug("dev-team", "700"),
      "threads",
      `${slug}.md`,
    );
    expect(existsSync(threadPath)).toBe(true);
    const content = readFileSync(threadPath, "utf8");
    expect(content).toContain("thread discussion");
    expect(content).toContain("starter_message_id: thread-700");
  });

  test("rerenderChannel returns total message count (main + thread)", () => {
    expect(rerenderChannel(ch, guildId)).toBe(2);
  });
});

// ── legacy namespace dirs ───────────────────────────────────────────────────

describe("markdown/hierarchy — removeLegacyNamespaceDirs", () => {
  test("moves a stale pre-workspace dir aside and keeps a live workspace dir", () => {
    // `general` is no longer a workspace id; `leadership` still is.
    mkdirSync(resolve(DISCORD_DIR, "general"), { recursive: true });
    writeFileSync(resolve(DISCORD_DIR, "general", "x.md"), "old export body", "utf8");
    mkdirSync(LEADERSHIP_DIR, { recursive: true });

    const moved = removeLegacyNamespaceDirs(["leadership", "eboard"], new Date("2026-08-27"));

    const dest = resolve(LEGACY_DIR, "general-20260827");
    expect(moved).toEqual([dest]);
    expect(existsSync(resolve(DISCORD_DIR, "general"))).toBe(false);
    expect(readFileSync(resolve(dest, "x.md"), "utf8")).toBe("old export body");
    // Never deleted, never touched: `leadership` is a configured workspace.
    expect(existsSync(LEADERSHIP_DIR)).toBe(true);
    expect(existsSync(resolve(LEGACY_DIR, "leadership-20260827"))).toBe(false);
  });

  test("is a no-op when there is nothing left to move", () => {
    expect(removeLegacyNamespaceDirs(["leadership", "eboard"], new Date("2026-08-27"))).toEqual([]);
  });
});
