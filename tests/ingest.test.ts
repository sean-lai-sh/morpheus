import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetChannelsForTest } from "../src/config.ts";
import { withTempCwd, withTempDb, writeCanonicalChannels } from "./helpers.ts";
import { scopeFor } from "../src/context/namespace.ts";
import type { Scope } from "../src/context/types.ts";

// Set up a fixture config BEFORE importing modules that read it.
const cwd = withTempCwd();
writeCanonicalChannels();
const db = withTempDb();

/** eboard channel (parent of programs-*); programs-dev channel (a leaf workspace). */
const EBOARD_CHANNEL = "1001";
const PD_CHANNEL = "4004";

let eboard: Scope;
let pd: Scope;

beforeAll(() => {
  resetChannelsForTest();
  eboard = scopeFor("eboard")!;
  pd = scopeFor("programs-dev")!;
});
afterAll(() => {
  resetChannelsForTest();
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
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(
      buildMessage({ id: "i1", channelId: EBOARD_CHANNEL, content: "hello world", authorBot: true }),
    );
    expect(r.action).toBe("dropped");
    expect(r.reason).toBe("bot-author");
  });

  test("drops messages with content < 6 chars after stripping mentions", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(buildMessage({ id: "i2", channelId: EBOARD_CHANNEL, content: "lol" }));
    expect(r.action).toBe("dropped");
    expect(r.reason).toBe("too-short");
  });

  test("keeps short messages that contain a GDrive URL", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(
      buildMessage({
        id: "i3",
        channelId: EBOARD_CHANNEL,
        content: "https://docs.google.com/document/d/AAAAAAAAAAAAAAAAAAAA/edit",
      }),
    );
    expect(r.action).toBe("inserted");
  });

  test("drops bare gif URL", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(
      buildMessage({ id: "i4a", channelId: EBOARD_CHANNEL, content: "https://example.com/reaction.gif" }),
    );
    expect(r.action).toBe("dropped");
    expect(r.reason).toBe("pure-media");
  });

  test("keeps pure emoji message (no longer filtered)", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(
      buildMessage({ id: "i4b", channelId: EBOARD_CHANNEL, content: "🔥🔥🔥" }),
    );
    expect(r.action).toBe("inserted");
  });

  test("keeps gif URL that has surrounding text", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const r = await ingestMessage(
      buildMessage({
        id: "i4c",
        channelId: EBOARD_CHANNEL,
        content: "us at the retreat https://example.com/funny.gif",
      }),
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
  test("channels mark messages operational immediately", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const { getMessage } = await import("../src/storage/messages.ts");
    const r = await ingestMessage(
      buildMessage({ id: "i5", channelId: EBOARD_CHANNEL, content: "deadline is friday" }),
    );
    expect(r.action).toBe("inserted");
    expect(getMessage("i5")?.classification).toBe("operational");
  });

  test("a leaf-workspace channel also writes operational immediately (no queue)", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const { getMessage } = await import("../src/storage/messages.ts");
    const r = await ingestMessage(
      buildMessage({ id: "i6", channelId: PD_CHANNEL, content: "shall we move the meeting" }),
    );
    expect(r.action).toBe("inserted");
    expect(getMessage("i6")?.classification).toBe("operational");
  });
});

describe("bot/ingest lands rows in the right workspace", () => {
  test("an ingested row is searchable from its own workspace and nowhere sideways", async () => {
    const { ingestMessage } = await import("../src/bot/ingest.ts");
    const { contextStore } = await import("../src/context/store.ts");
    const { namespaceForRow } = await import("../src/context/namespace.ts");
    const { getMessage } = await import("../src/storage/messages.ts");

    await ingestMessage(
      buildMessage({ id: "i7", channelId: PD_CHANNEL, content: "ingest-workspace-unique deploy plan" }),
    );
    expect(namespaceForRow(getMessage("i7")!)).toBe("programs-dev");
    expect(
      contextStore.search({ query: "ingest-workspace-unique", scope: pd }).map((h) => h.id),
    ).toContain("i7");
    // Visible from the parent workspace too, since programs-dev is a descendant.
    expect(
      contextStore.search({ query: "ingest-workspace-unique", scope: eboard }).map((h) => h.id),
    ).toContain("i7");
    expect(contextStore.readMessage("i7", pd)?.id).toBe("i7");

    // ... but an eboard row is invisible to the leaf scope.
    await ingestMessage(
      buildMessage({ id: "i8", channelId: EBOARD_CHANNEL, content: "eboard-only-unique sponsor list" }),
    );
    expect(contextStore.search({ query: "eboard-only-unique", scope: pd })).toEqual([]);
    expect(contextStore.readMessage("i8", pd)).toBeNull();
  });
});

describe("refusing to index when namespaceForRow is null", () => {
  test("a row whose channel is not allowlisted is never attributed or indexed", async () => {
    const { contextStore, indexFromRow } = await import("../src/context/store.ts");
    const { namespaceForRow } = await import("../src/context/namespace.ts");
    const { getMessage, upsertMessage } = await import("../src/storage/messages.ts");

    // Bypass ingest (which would have skipped it) to reach the index guard directly.
    upsertMessage({
      id: "orphan-1",
      channelId: "999",
      authorId: "u9",
      authorName: "eve",
      content: "orphan-index-unique should never be searchable",
      createdAt: 42,
    });
    const row = getMessage("orphan-1")!;
    expect(namespaceForRow(row)).toBeNull();
    expect(() => indexFromRow(row)).toThrow(/unknown channel/);
    for (const scope of [eboard, pd]) {
      expect(contextStore.search({ query: "orphan-index-unique", scope })).toEqual([]);
      expect(contextStore.readMessage("orphan-1", scope)).toBeNull();
    }
  });

  test("a thread whose parent is not allowlisted is refused too", async () => {
    const { contextStore, indexFromRow } = await import("../src/context/store.ts");
    const { namespaceForRow } = await import("../src/context/namespace.ts");
    const { getMessage, upsertMessage } = await import("../src/storage/messages.ts");

    upsertMessage({
      id: "orphan-thread-1",
      channelId: "888",
      parentChannelId: "999",
      authorId: "u9",
      authorName: "eve",
      content: "orphan-thread-unique hidden thread body",
      createdAt: 43,
      threadId: "888",
      threadName: "Ghost thread",
    });
    const row = getMessage("orphan-thread-1")!;
    expect(namespaceForRow(row)).toBeNull();
    expect(() => indexFromRow(row)).toThrow(/unknown channel/);
    expect(contextStore.search({ query: "orphan-thread-unique", scope: eboard })).toEqual([]);
  });
});

describe("ingestDeleteById (reconcile path)", () => {
  test("markDeleted runs before markdown/FTS so the row leaves search", async () => {
    const { ingestMessage, ingestDeleteById } = await import("../src/bot/ingest.ts");
    const { getMessage } = await import("../src/storage/messages.ts");
    const { contextStore } = await import("../src/context/store.ts");

    const id = "900000000000000001";
    const inserted = await ingestMessage(
      buildMessage({
        id,
        channelId: EBOARD_CHANNEL,
        content: "reconcile-delete-unique-token snacks",
      }),
    );
    expect(inserted.action).toBe("inserted");
    const live = getMessage(id)!;
    expect(live.deleted_at).toBeNull();
    const beforeSeq = live.seq;
    expect(
      contextStore.search({ query: "reconcile-delete-unique-token", scope: eboard }).some((h) => h.id === id),
    ).toBe(true);

    const deleted = await ingestDeleteById(id);
    expect(deleted.action).toBe("edited");
    const row = getMessage(id)!;
    expect(row.deleted_at).not.toBeNull();
    expect(row.seq).toBeGreaterThan(beforeSeq);
    expect(
      contextStore.search({ query: "reconcile-delete-unique-token", scope: eboard }).some((h) => h.id === id),
    ).toBe(false);
    expect(contextStore.readMessage(id, eboard)).toBeNull();

    const page = contextStore.poll(eboard, `${beforeSeq}:${id}`, 50);
    const hit = page.documents.find((d) => d.id === id);
    expect(hit?.deletedAt).toBeTruthy();
    expect(hit?.content).toBe("");
  });
});
