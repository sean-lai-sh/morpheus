import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resetChannelsForTest } from "../src/config.ts";
import { withTempCwd, withTempDb } from "./helpers.ts";
import { namespaceForRow, requireNamespace } from "../src/context/namespace.ts";
import { contextStore, documentFromRow, ftsCount, indexFromRow, rebuildFts } from "../src/context/store.ts";
import { isForbiddenOsPath, parseIndexPath, sanitizeIndexPath } from "../src/context/paths.ts";
import { getMessage, markDeleted, setReactions, upsertMessage } from "../src/storage/messages.ts";
import { reindexAll } from "../src/tasks/reindex.ts";

function writeChannelsFixture(): void {
  mkdirSync(resolve(process.cwd(), "config"), { recursive: true });
  writeFileSync(
    resolve(process.cwd(), "config/channels.yml"),
    `
guild_id: "987654321098765432"
channels:
  - id: "1001"
    name: "sponsors"
    category: "eboard-teams"
    classify: true
    include_threads: true
  - id: "2002"
    name: "leadership-team"
    category: "eboard-teams"
    classify: true
    include_threads: true
    isolated: true
  - id: "3003"
    name: "general-chat"
    classify: true
    include_threads: false
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

beforeAll(() => {
  resetChannelsForTest();
  seed();
});
afterAll(() => {
  resetChannelsForTest();
  db.cleanup();
  cwd.cleanup();
});

const GENERAL_MSG = "100000000000000001";
const LEADER_MSG = "200000000000000002";
const LEADER_THREAD_MSG = "200000000000000099";
const LEADER_THREAD_ID = "200000000000000050";

function seed(): void {
  upsertMessage({
    id: GENERAL_MSG,
    channelId: "1001",
    authorId: "u1",
    authorName: "alice",
    content: "sponsors budget for startup week snacks",
    createdAt: 1_000,
  });
  indexFromRow(getMessage(GENERAL_MSG)!);

  upsertMessage({
    id: LEADER_MSG,
    channelId: "2002",
    authorId: "u2",
    authorName: "bob",
    content: "leadership only secret retreat plan",
    createdAt: 1_100,
  });
  indexFromRow(getMessage(LEADER_MSG)!);

  upsertMessage({
    id: LEADER_THREAD_MSG,
    channelId: LEADER_THREAD_ID,
    parentChannelId: "2002",
    authorId: "u2",
    authorName: "bob",
    content: "thread of isolated parent about retreat seating",
    createdAt: 1_200,
    threadId: LEADER_THREAD_ID,
    threadName: "Retreat seating",
  });
  indexFromRow(getMessage(LEADER_THREAD_MSG)!);
}

describe("namespaceForRow", () => {
  test("unknown parent is null (does not fail-open to general)", () => {
    upsertMessage({
      id: "900000000000000009",
      channelId: "9999",
      authorId: "u9",
      authorName: "eve",
      content: "orphan row",
      createdAt: 50,
    });
    const row = getMessage("900000000000000009")!;
    expect(namespaceForRow(row)).toBeNull();
    expect(() => requireNamespace(row)).toThrow(/unknown channel/);
  });

  test("thread of isolated:true parent → leadership", () => {
    seed();
    const row = getMessage(LEADER_THREAD_MSG)!;
    expect(namespaceForRow(row)).toBe("leadership");
    expect(row.channel_id).toBe(LEADER_THREAD_ID);
    expect(row.parent_channel_id).toBe("2002");
  });

  test("main general channel → general", () => {
    const row = getMessage(GENERAL_MSG)!;
    expect(namespaceForRow(row)).toBe("general");
  });
});

describe("IndexDocument channelId vs parentChannelId", () => {
  test("thread row keeps thread id as channelId and parent as parentChannelId", () => {
    const row = getMessage(LEADER_THREAD_MSG)!;
    const doc = documentFromRow(row);
    expect(doc.channelId).toBe(LEADER_THREAD_ID);
    expect(doc.parentChannelId).toBe("2002");
    expect(doc.permalink).toContain(`/${LEADER_THREAD_ID}/${LEADER_THREAD_MSG}`);
    expect(doc.permalink.startsWith("https://discord.com/channels/")).toBe(true);
  });
});

describe("ContextStore search isolation", () => {
  test("leadership thread is absent from general search even on exact match", () => {
    const hits = contextStore.search({
      query: "retreat seating",
      namespace: "general",
    });
    expect(hits.map((h) => h.id)).not.toContain(LEADER_THREAD_MSG);
    expect(hits.map((h) => h.id)).not.toContain(LEADER_MSG);
  });

  test("leadership search finds the isolated thread", () => {
    const hits = contextStore.search({
      query: "retreat seating",
      namespace: "leadership",
    });
    expect(hits.map((h) => h.id)).toContain(LEADER_THREAD_MSG);
    expect(hits[0]?.channelId).toBe(LEADER_THREAD_ID);
    expect(hits[0]?.parentChannelId).toBe("2002");
    expect(hits[0]?.path).toContain("/leadership/");
    expect(hits[0]?.path).toContain("/threads/");
  });

  test("general search finds general channel content", () => {
    const hits = contextStore.search({ query: "sponsors budget", namespace: "general" });
    expect(hits.map((h) => h.id)).toContain(GENERAL_MSG);
    expect(hits[0]?.path.startsWith("/general/eboard-teams/")).toBe(true);
  });

  test("deleted messages are excluded by default", () => {
    upsertMessage({
      id: "100000000000000088",
      channelId: "1001",
      authorId: "u1",
      authorName: "alice",
      content: "unique-delete-token snacks",
      createdAt: 1_500,
    });
    indexFromRow(getMessage("100000000000000088")!);
    expect(
      contextStore.search({ query: "unique-delete-token", namespace: "general" }).map((h) => h.id),
    ).toContain("100000000000000088");
    markDeleted("100000000000000088", 2_000);
    expect(contextStore.search({ query: "unique-delete-token", namespace: "general" })).toEqual([]);
    expect(
      contextStore.search({
        query: "unique-delete-token",
        namespace: "general",
        includeDeleted: true,
      }).map((h) => h.id),
    ).toContain("100000000000000088");
  });

  test("readMessage(general) returns null for a leadership id", () => {
    expect(contextStore.readMessage(LEADER_MSG, "general")).toBeNull();
    expect(contextStore.readMessage(LEADER_THREAD_MSG, "general")).toBeNull();
    expect(contextStore.readMessage(LEADER_MSG, "leadership")?.id).toBe(LEADER_MSG);
  });
});

describe("seq poll (not created_at)", () => {
  test("edit and delete appear after a cursor that passed the original created_at", () => {
    const id = "100000000000000077";
    upsertMessage({
      id,
      channelId: "1001",
      authorId: "u1",
      authorName: "alice",
      content: "original poll body unique-seq-token",
      createdAt: 5_000,
    });
    const inserted = getMessage(id)!;
    indexFromRow(inserted);
    expect(inserted.seq).toBeGreaterThan(0);

    const firstPage = contextStore.poll("general", null, 50);
    const seen = firstPage.documents.find((d) => d.id === id);
    expect(seen).toBeDefined();
    const cursorAfterInsert = `${seen!.seq}:${seen!.id}`;

    const later = contextStore.poll("general", cursorAfterInsert, 50);
    expect(later.documents.map((d) => d.id)).not.toContain(id);

    upsertMessage({
      id,
      channelId: "1001",
      authorId: "u1",
      authorName: "alice",
      content: "edited poll body unique-seq-token",
      createdAt: 5_000,
      editedAt: 9_000,
    });
    const edited = getMessage(id)!;
    indexFromRow(edited);
    expect(edited.seq).toBeGreaterThan(inserted.seq);
    expect(edited.created_at).toBe(5_000);

    const afterEdit = contextStore.poll("general", cursorAfterInsert, 50);
    const editedHit = afterEdit.documents.find((d) => d.id === id);
    expect(editedHit).toBeDefined();
    expect(editedHit?.content).toContain("edited poll body");
    expect(editedHit?.seq).toBe(edited.seq);

    const cursorAfterEdit = `${editedHit!.seq}:${editedHit!.id}`;
    markDeleted(id, 10_000);
    const deleted = getMessage(id)!;
    indexFromRow(deleted);
    expect(deleted.seq).toBeGreaterThan(edited.seq);

    const afterDelete = contextStore.poll("general", cursorAfterEdit, 50);
    const deletedHit = afterDelete.documents.find((d) => d.id === id);
    expect(deletedHit).toBeDefined();
    expect(deletedHit?.deletedAt).toBe(10_000);
    expect(deletedHit?.content).toBe("");
  });

  test("setReactions bumps seq so poll sees it", () => {
    const id = GENERAL_MSG;
    const before = getMessage(id)!.seq;
    const page = contextStore.poll("general", `${before}:${id}`, 50);
    setReactions(id, { "👍": 2 });
    const after = getMessage(id)!;
    expect(after.seq).toBeGreaterThan(before);
    const page2 = contextStore.poll("general", `${before}:${id}`, 50);
    expect(page2.documents.map((d) => d.id)).toContain(id);
    void page;
  });
});

describe("virtual paths", () => {
  test("rejects OS paths and ..", () => {
    expect(isForbiddenOsPath("/Users/sean")).toBe(true);
    expect(isForbiddenOsPath("~/src")).toBe(true);
    expect(isForbiddenOsPath("/data/discord/general")).toBe(true);
    expect(sanitizeIndexPath("../")).toBeNull();
    expect(parseIndexPath("/Users/sean")).toBeNull();
    expect(parseIndexPath("../")).toBeNull();
  });

  test("tree lists namespace → category → channel, never Mini disk", () => {
    const root = contextStore.tree("/", "general");
    expect(root).toEqual([{ path: "/general", kind: "dir", name: "general" }]);
    const ns = contextStore.tree("/general", "general");
    expect(ns.some((n) => n.path === "/general/eboard-teams")).toBe(true);
    expect(ns.every((n) => n.path.startsWith("/general"))).toBe(true);
    const cat = contextStore.tree("/general/eboard-teams", "general");
    expect(cat.some((n) => n.name.startsWith("sponsors-"))).toBe(true);
    expect(contextStore.tree("/leadership", "general")).toEqual([]);
  });

  test("readPath of a leadership path with general namespace is empty/null", () => {
    expect(contextStore.readPath("/leadership/eboard-teams", "general")).toBeNull();
  });
});

describe("bun run reindex rebuilds FTS", () => {
  test("rebuildFts is idempotent and restores search", () => {
    rebuildFts();
    expect(ftsCount()).toBeGreaterThan(0);
    const hits = contextStore.search({ query: "sponsors budget", namespace: "general" });
    expect(hits.map((h) => h.id)).toContain(GENERAL_MSG);
  });

  test("reindexAll rebuilds FTS from messages", () => {
    reindexAll();
    expect(ftsCount()).toBeGreaterThan(0);
    expect(
      contextStore.search({ query: "secret retreat", namespace: "leadership" }).map((h) => h.id),
    ).toContain(LEADER_MSG);
  });
});

describe("Nia is not the retrieval engine", () => {
  test("src/nia is gone", () => {
    expect(existsSync(resolve(import.meta.dir, "../src/nia"))).toBe(false);
  });

  test("FTS search works with zero NIA_* secrets", () => {
    delete process.env.NIA_API_KEY;
    delete process.env.NIA_BASE_URL;
    delete process.env.NIA_DISCORD_SOURCE_ID;
    delete process.env.NIA_DISCORD_LEADERSHIP_SOURCE_ID;
    const hits = contextStore.search({ query: "sponsors budget", namespace: "general" });
    expect(hits.map((h) => h.id)).toContain(GENERAL_MSG);
  });
});
