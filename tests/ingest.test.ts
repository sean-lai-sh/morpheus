import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempCwd, withTempDb } from "./helpers.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Set up a fixture config BEFORE importing modules that read it.
function writeChannelsFixture(): void {
  mkdirSync(resolve(process.cwd(), "config"), { recursive: true });
  writeFileSync(
    resolve(process.cwd(), "config/channels.yml"),
    `
guild_id: "987654321098765432"
channels:
  - id: "111"
    name: "eboard"
    classify: false
  - id: "222"
    name: "logistics"
    classify: true
defaults:
  confidence_threshold: 0.5
  reconcile_lookback: 200
  reconcile_interval_hours: 6
`,
    "utf8",
  );
}

const cwd = withTempCwd();
writeChannelsFixture();
const db = withTempDb();

beforeAll(() => {});
afterAll(() => {
  db.cleanup();
  cwd.cleanup();
});

/** Build a minimal Message-like object that satisfies the ingest pipeline. */
function buildMessage(opts: {
  id: string;
  channelId: string;
  content: string;
  authorBot?: boolean;
  createdTimestamp?: number;
  editedTimestamp?: number | null;
  authorName?: string;
}): any {
  return {
    id: opts.id,
    channelId: opts.channelId,
    content: opts.content,
    createdTimestamp: opts.createdTimestamp ?? 1_000,
    editedTimestamp: opts.editedTimestamp ?? null,
    author: {
      id: "u1",
      username: opts.authorName ?? "alice",
      globalName: opts.authorName ?? "alice",
      bot: opts.authorBot ?? false,
    },
    member: { displayName: opts.authorName ?? "alice" },
  };
}

describe("bot/ingest hard filters", () => {
  test("drops messages from bot authors", async () => {
    const { ingestMessage, setClassifierBypass } = await import("../src/bot/ingest.ts");
    setClassifierBypass(true);
    const r = await ingestMessage(
      buildMessage({ id: "i1", channelId: "111", content: "hello world", authorBot: true }),
    );
    expect(r.action).toBe("dropped");
    expect(r.reason).toBe("bot-author");
  });

  test("drops messages with content < 6 chars after stripping mentions", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(buildMessage({ id: "i2", channelId: "111", content: "lol" }));
    expect(r.action).toBe("dropped");
    expect(r.reason).toBe("too-short");
  });

  test("keeps short messages that contain a GDrive URL", async () => {
    const { ingestMessage, setClassifierBypass } = await import("../src/bot/ingest.ts");
    setClassifierBypass(true);
    const r = await ingestMessage(
      buildMessage({
        id: "i3",
        channelId: "111",
        content: "https://docs.google.com/document/d/AAAAAAAAAAAAAAAAAAAA/edit",
      }),
    );
    expect(r.action).toBe("inserted");
  });

  test("drops bare gif URL", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(
      buildMessage({ id: "i4a", channelId: "111", content: "https://example.com/reaction.gif" }),
    );
    expect(r.action).toBe("dropped");
    expect(r.reason).toBe("pure-media");
  });

  test("drops pure emoji message", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(
      buildMessage({ id: "i4b", channelId: "111", content: "🔥🔥🔥" }),
    );
    expect(r.action).toBe("dropped");
    expect(r.reason).toBe("pure-emoji");
  });

  test("keeps gif URL that has surrounding text", async () => {
    const { ingestMessage, setClassifierBypass } = await import("../src/bot/ingest.ts");
    setClassifierBypass(true);
    const r = await ingestMessage(
      buildMessage({ id: "i4c", channelId: "111", content: "us at the retreat https://example.com/funny.gif" }),
    );
    expect(r.action).toBe("inserted");
  });

  test("skips messages from non-allowlisted channels", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(
      buildMessage({ id: "i4d", channelId: "999", content: "long enough message" }),
    );
    expect(r.action).toBe("skipped");
    expect(r.reason).toBe("channel-not-allowlisted");
  });
});

describe("bot/ingest classification routing", () => {
  test("classify:false channels mark messages operational + write markdown", async () => {
    const { ingestMessage, setClassifierBypass } = await import("../src/bot/ingest.ts");
    const { getMessage } = await import("../src/storage/messages.ts");
    setClassifierBypass(false); // even with classifier on, classify:false channel skips it
    const r = await ingestMessage(
      buildMessage({ id: "i5", channelId: "111", content: "deadline is friday" }),
    );
    expect(r.action).toBe("inserted");
    expect(getMessage("i5")?.classification).toBe("operational");
  });

  test("classify:true channels enqueue messages for classifier (no markdown yet)", async () => {
    const { ingestMessage, setClassifierBypass } = await import("../src/bot/ingest.ts");
    const { getMessage } = await import("../src/storage/messages.ts");
    const { queueDepth } = await import("../src/storage/queue.ts");
    setClassifierBypass(false);
    const before = queueDepth();
    const r = await ingestMessage(
      buildMessage({ id: "i6", channelId: "222", content: "shall we move the meeting" }),
    );
    expect(r.action).toBe("inserted");
    // Classification should be null until worker runs
    expect(getMessage("i6")?.classification).toBeNull();
    expect(queueDepth()).toBe(before + 1);
  });

  test("classifier bypass writes operational on classify:true channels too", async () => {
    const { ingestMessage, setClassifierBypass } = await import("../src/bot/ingest.ts");
    const { getMessage } = await import("../src/storage/messages.ts");
    setClassifierBypass(true);
    await ingestMessage(
      buildMessage({ id: "i7", channelId: "222", content: "another long enough message" }),
    );
    expect(getMessage("i7")?.classification).toBe("operational");
  });
});
