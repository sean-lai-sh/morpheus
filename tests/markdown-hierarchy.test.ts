import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { withTempCwd, withTempDb } from "./helpers.ts";
import {
  GENERAL_DIR,
  LEADERSHIP_DIR,
  appendBlock,
  channelFilePath,
  channelSlug,
  rerenderChannel,
} from "../src/storage/markdown.ts";
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

// ── Path structure ──────────────────────────────────────────────────────────

describe("markdown/hierarchy — channelFilePath", () => {
  test("no category: resolves under general root", () => {
    const ch = { id: "111", name: "eboard-chat" };
    const path = channelFilePath(ch);
    const slug = channelSlug("eboard-chat", "111");
    expect(path).toBe(resolve(GENERAL_DIR, slug, "main.md"));
  });

  test("with category: resolves under general/{category}/{slug}", () => {
    const ch = { id: "222", name: "startup-week-team", category: "eboard-teams" };
    const path = channelFilePath(ch);
    const slug = channelSlug("startup-week-team", "222");
    expect(path).toBe(resolve(GENERAL_DIR, "eboard-teams", slug, "main.md"));
  });

  test("isolated channel resolves under leadership root", () => {
    const ch = { id: "333", name: "leadership-team", category: "eboard-teams", isolated: true };
    const path = channelFilePath(ch);
    const slug = channelSlug("leadership-team", "333");
    expect(path).toBe(resolve(LEADERSHIP_DIR, "eboard-teams", slug, "main.md"));
  });
});

// ── appendBlock routing ──────────────────────────────────────────────────────

describe("markdown/hierarchy — appendBlock routing", () => {
  const mainChannel = { id: "500", name: "events-team", category: "eboard-teams" };

  test("non-thread message writes to main.md and marks GENERAL_DIR dirty", () => {
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

    const state = getSyncState(GENERAL_DIR);
    expect(state.dirty).toBe(1);
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

    const mainPath = channelFilePath(mainChannel);
    const mainContent = readFileSync(mainPath, "utf8");
    expect(mainContent).not.toContain("reply in thread");

    const slug = channelSlug("Speaker Coordination", "thread-500");
    const threadPath = resolve(
      GENERAL_DIR,
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
      GENERAL_DIR,
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

  test("isolated channel writes to LEADERSHIP_DIR and marks it dirty", () => {
    const leadershipChannel = {
      id: "600",
      name: "leadership-team",
      category: "eboard-teams",
      isolated: true,
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

    const state = getSyncState(LEADERSHIP_DIR);
    expect(state.dirty).toBe(1);
  });

  test("isolated channel content does not appear under GENERAL_DIR", () => {
    // Read all files under GENERAL_DIR recursively and confirm no leadership content
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
    const generalContent = collectTexts(GENERAL_DIR);
    expect(generalContent).not.toContain("sensitive planning note");
  });
});

// ── rerenderChannel ─────────────────────────────────────────────────────────

describe("markdown/hierarchy — rerenderChannel", () => {
  const ch = { id: "700", name: "dev-team", category: "eboard-teams" };

  beforeAll(() => {
    // main channel message
    upsertMessage({
      id: "rc-main",
      channelId: "700",
      authorId: "u1",
      authorName: "Dev",
      content: "main channel post",
      createdAt: 1_000,
    });
    // thread message
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
      GENERAL_DIR,
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
    const written = rerenderChannel(ch, guildId);
    expect(written).toBe(2);
  });
});
