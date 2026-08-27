import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resetChannelsForTest } from "../src/config.ts";
import { withTempCwd, withTempDb, writeCanonicalChannels } from "./helpers.ts";
import { namespaceForRow, requireNamespace, rowInScope, scopeFor } from "../src/context/namespace.ts";
import {
  contextStore,
  documentFromRow,
  ftsCount,
  indexFromRow,
  rebuildFts,
  toFtsQueryLoose,
} from "../src/context/store.ts";
import { isForbiddenOsPath, parseIndexPath, sanitizeIndexPath } from "../src/context/paths.ts";
import type { Scope } from "../src/context/types.ts";
import { extractLinks, persistLinks } from "../src/storage/links.ts";
import { getMessage, markDeleted, setReactions, upsertMessage } from "../src/storage/messages.ts";
import { reindexAll } from "../src/tasks/reindex.ts";

const cwd = withTempCwd();
writeCanonicalChannels();
const db = withTempDb();

// Message ids, one per workspace in the canonical tree.
const E_MSG = "100000000000000001";
const L_MSG = "200000000000000002";
const L_THREAD_MSG = "200000000000000099";
const L_THREAD_ID = "200000000000000050";
const PM_MSG = "300000000000000003";
const PD_MSG = "400000000000000004";
/** A thread row whose parent channel is not in channels.yml — must never be attributed. */
const ORPHAN_THREAD_MSG = "900000000000000009";

let leadership: Scope;
let eboard: Scope;
let pm: Scope;
let pd: Scope;

beforeAll(() => {
  resetChannelsForTest();
  leadership = scopeFor("leadership")!;
  eboard = scopeFor("eboard")!;
  pm = scopeFor("programs-mentorship")!;
  pd = scopeFor("programs-dev")!;
  seed();
});

afterAll(() => {
  resetChannelsForTest();
  db.cleanup();
  cwd.cleanup();
});

function seed(): void {
  upsertMessage({
    id: E_MSG,
    channelId: "1001",
    authorId: "u1",
    authorName: "alice",
    content: "sponsors budget for startup week snacks",
    createdAt: 1_000,
  });
  indexFromRow(getMessage(E_MSG)!);

  upsertMessage({
    id: L_MSG,
    channelId: "2002",
    authorId: "u2",
    authorName: "bob",
    content: "leadership only secret retreat plan zebra-unique-9",
    createdAt: 1_100,
  });
  indexFromRow(getMessage(L_MSG)!);

  upsertMessage({
    id: L_THREAD_MSG,
    channelId: L_THREAD_ID,
    parentChannelId: "2002",
    authorId: "u2",
    authorName: "bob",
    content: "thread of a leadership parent about retreat seating",
    createdAt: 1_200,
    threadId: L_THREAD_ID,
    threadName: "Retreat seating",
  });
  indexFromRow(getMessage(L_THREAD_MSG)!);

  upsertMessage({
    id: PM_MSG,
    channelId: "3003",
    authorId: "u3",
    authorName: "carol",
    content: "mentorship pairing round two",
    createdAt: 1_300,
  });
  indexFromRow(getMessage(PM_MSG)!);

  upsertMessage({
    id: PD_MSG,
    channelId: "4004",
    authorId: "u4",
    authorName: "dave",
    content: "dev-chat-unique deploy notes",
    createdAt: 1_400,
  });
  indexFromRow(getMessage(PD_MSG)!);
}

describe("scopeFor", () => {
  test("unknown workspace has no scope at all", () => {
    expect(scopeFor("nope")).toBeNull();
    expect(scopeFor("general")).toBeNull();
    expect(scopeFor("")).toBeNull();
  });

  test("scope is root plus transitive descendants", () => {
    expect([...eboard.visible].sort()).toEqual(["eboard", "programs-dev", "programs-mentorship"]);
    expect([...pd.visible].sort()).toEqual(["programs-dev"]);
    expect(leadership.root).toBe("leadership");
    expect(leadership.visible.size).toBe(4);
  });
});

describe("namespaceForRow / rowInScope", () => {
  test("unknown channel is null — never a default workspace", () => {
    upsertMessage({
      id: "900000000000000001",
      channelId: "9999",
      authorId: "u9",
      authorName: "eve",
      content: "orphan row",
      createdAt: 50,
    });
    const row = getMessage("900000000000000001")!;
    expect(namespaceForRow(row)).toBeNull();
    expect(() => requireNamespace(row)).toThrow(/unknown channel/);
    expect(rowInScope(row, leadership)).toBe(false);
  });

  test("indexFromRow throws for an unknown channel (fail closed)", () => {
    const row = getMessage("900000000000000001")!;
    expect(() => indexFromRow(row)).toThrow(/unknown channel/);
  });

  test("a thread whose PARENT is unlisted is out of every scope", () => {
    upsertMessage({
      id: ORPHAN_THREAD_MSG,
      channelId: "888888",
      parentChannelId: "9999",
      authorId: "u9",
      authorName: "eve",
      content: "thread under an unlisted parent",
      createdAt: 60,
      threadId: "888888",
      threadName: "Ghost thread",
    });
    const row = getMessage(ORPHAN_THREAD_MSG)!;
    expect(namespaceForRow(row)).toBeNull();
    expect(rowInScope(row, leadership)).toBe(false);
    expect(rowInScope(row, eboard)).toBe(false);
    expect(rowInScope(row, pd)).toBe(false);
  });

  test("a thread resolves through its parent channel's workspace", () => {
    const row = getMessage(L_THREAD_MSG)!;
    expect(namespaceForRow(row)).toBe("leadership");
    expect(row.channel_id).toBe(L_THREAD_ID);
    expect(row.parent_channel_id).toBe("2002");
    expect(rowInScope(row, leadership)).toBe(true);
    expect(rowInScope(row, eboard)).toBe(false);
  });

  test("main channels resolve to their declared workspace", () => {
    expect(namespaceForRow(getMessage(E_MSG)!)).toBe("eboard");
    expect(namespaceForRow(getMessage(PM_MSG)!)).toBe("programs-mentorship");
    expect(namespaceForRow(getMessage(PD_MSG)!)).toBe("programs-dev");
  });
});

describe("IndexDocument channelId vs parentChannelId", () => {
  test("thread row keeps thread id as channelId and parent as parentChannelId", () => {
    const doc = documentFromRow(getMessage(L_THREAD_MSG)!);
    expect(doc.namespace).toBe("leadership");
    expect(doc.channelId).toBe(L_THREAD_ID);
    expect(doc.parentChannelId).toBe("2002");
    expect(doc.permalink).toContain(`/${L_THREAD_ID}/${L_THREAD_MSG}`);
    expect(doc.permalink.startsWith("https://discord.com/channels/")).toBe(true);
  });
});

describe("ContextStore search isolation", () => {
  test("a leaf scope never sees a sibling or ancestor, even on an exact unique token", () => {
    for (const query of ["zebra-unique-9", "retreat seating", "sponsors budget", "mentorship pairing"]) {
      expect(contextStore.search({ query, scope: pd })).toEqual([]);
    }
    expect(contextStore.search({ query: "dev-chat-unique", scope: pd }).map((h) => h.id)).toEqual([
      PD_MSG,
    ]);
  });

  test("eboard sees its descendants but not leadership", () => {
    expect(contextStore.search({ query: "zebra-unique-9", scope: eboard })).toEqual([]);
    expect(contextStore.search({ query: "retreat seating", scope: eboard })).toEqual([]);
    expect(contextStore.search({ query: "mentorship pairing", scope: eboard }).map((h) => h.id)).toContain(
      PM_MSG,
    );
    expect(contextStore.search({ query: "dev-chat-unique", scope: eboard }).map((h) => h.id)).toContain(
      PD_MSG,
    );
  });

  test("leadership finds the isolated thread", () => {
    const hits = contextStore.search({ query: "retreat seating", scope: leadership });
    expect(hits.map((h) => h.id)).toContain(L_THREAD_MSG);
    const hit = hits.find((h) => h.id === L_THREAD_MSG)!;
    expect(hit.channelId).toBe(L_THREAD_ID);
    expect(hit.parentChannelId).toBe("2002");
    expect(hit.path.startsWith("/leadership/")).toBe(true);
    expect(hit.path).toContain("/threads/");
  });

  test("paths are workspace-rooted", () => {
    const hits = contextStore.search({ query: "sponsors budget", scope: eboard });
    expect(hits.map((h) => h.id)).toContain(E_MSG);
    expect(hits[0]?.path.startsWith("/eboard/eboard-teams/")).toBe(true);
    const pmHits = contextStore.search({ query: "mentorship pairing", scope: pm });
    expect(pmHits[0]?.path.startsWith("/programs-mentorship/programs/")).toBe(true);
  });

  test("pathPrefix narrows within the scope", () => {
    const hits = contextStore.search({
      query: "mentorship pairing",
      scope: eboard,
      pathPrefix: "/programs-mentorship",
    });
    expect(hits.map((h) => h.id)).toEqual([PM_MSG]);
    expect(
      contextStore.search({ query: "mentorship pairing", scope: eboard, pathPrefix: "/programs-dev" }),
    ).toEqual([]);
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
      contextStore.search({ query: "unique-delete-token", scope: eboard }).map((h) => h.id),
    ).toContain("100000000000000088");
    markDeleted("100000000000000088", 2_000);
    expect(contextStore.search({ query: "unique-delete-token", scope: eboard })).toEqual([]);
    expect(
      contextStore
        .search({ query: "unique-delete-token", scope: eboard, includeDeleted: true })
        .map((h) => h.id),
    ).toContain("100000000000000088");
  });

  test("readMessage is scope-checked", () => {
    expect(contextStore.readMessage(L_MSG, eboard)).toBeNull();
    expect(contextStore.readMessage(L_THREAD_MSG, eboard)).toBeNull();
    expect(contextStore.readMessage(PM_MSG, pd)).toBeNull();
    expect(contextStore.readMessage(E_MSG, pd)).toBeNull();
    expect(contextStore.readMessage(L_MSG, leadership)?.id).toBe(L_MSG);
    expect(contextStore.readMessage(PD_MSG, eboard)?.id).toBe(PD_MSG);
  });
});

describe("readChannelWindow", () => {
  test("a channel outside the scope yields nothing", () => {
    expect(contextStore.readChannelWindow({ scope: pd, channelId: "1001" })).toEqual([]);
    expect(contextStore.readChannelWindow({ scope: pd, channelId: "2002" })).toEqual([]);
    expect(contextStore.readChannelWindow({ scope: eboard, channelId: "2002" })).toEqual([]);
    expect(contextStore.readChannelWindow({ scope: pd, channelId: "9999" })).toEqual([]);
  });

  test("a visible channel yields its messages", () => {
    expect(
      contextStore.readChannelWindow({ scope: pd, channelId: "4004" }).map((d) => d.id),
    ).toContain(PD_MSG);
    expect(
      contextStore.readChannelWindow({ scope: eboard, channelId: "4004" }).map((d) => d.id),
    ).toContain(PD_MSG);
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

    const firstPage = contextStore.poll(eboard, null, 50);
    const seen = firstPage.documents.find((d) => d.id === id);
    expect(seen).toBeDefined();
    const cursorAfterInsert = `${seen!.seq}:${seen!.id}`;

    const later = contextStore.poll(eboard, cursorAfterInsert, 50);
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

    const afterEdit = contextStore.poll(eboard, cursorAfterInsert, 50);
    const editedHit = afterEdit.documents.find((d) => d.id === id);
    expect(editedHit).toBeDefined();
    expect(editedHit?.content).toContain("edited poll body");
    expect(editedHit?.seq).toBe(edited.seq);

    const cursorAfterEdit = `${editedHit!.seq}:${editedHit!.id}`;
    markDeleted(id, 10_000);
    const deleted = getMessage(id)!;
    indexFromRow(deleted);
    expect(deleted.seq).toBeGreaterThan(edited.seq);

    const afterDelete = contextStore.poll(eboard, cursorAfterEdit, 50);
    const deletedHit = afterDelete.documents.find((d) => d.id === id);
    expect(deletedHit).toBeDefined();
    expect(deletedHit?.deletedAt).toBe(10_000);
    expect(deletedHit?.content).toBe("");
  });

  test("setReactions bumps seq so poll sees it", () => {
    const id = E_MSG;
    const before = getMessage(id)!.seq;
    setReactions(id, { "👍": 2 });
    const after = getMessage(id)!;
    expect(after.seq).toBeGreaterThan(before);
    const page = contextStore.poll(eboard, `${before}:${id}`, 50);
    expect(page.documents.map((d) => d.id)).toContain(id);
  });

  test("a leaf scope's poll stream contains only its own workspace", () => {
    const seenIds: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: { cursor: string; documents: { id: string }[] } = contextStore.poll(pd, cursor, 50);
      if (page.documents.length === 0) break;
      seenIds.push(...page.documents.map((d) => d.id));
      cursor = page.cursor;
    }
    expect([...new Set(seenIds)]).toEqual([PD_MSG]);
  });

  test("eboard's poll stream covers its subtree but never leadership", () => {
    const seenIds = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: { cursor: string; documents: { id: string }[] } = contextStore.poll(eboard, cursor, 50);
      if (page.documents.length === 0) break;
      for (const d of page.documents) seenIds.add(d.id);
      cursor = page.cursor;
    }
    expect(seenIds.has(E_MSG)).toBe(true);
    expect(seenIds.has(PM_MSG)).toBe(true);
    expect(seenIds.has(PD_MSG)).toBe(true);
    expect(seenIds.has(L_MSG)).toBe(false);
    expect(seenIds.has(L_THREAD_MSG)).toBe(false);
    expect(seenIds.has(ORPHAN_THREAD_MSG)).toBe(false);
  });
});

describe("virtual paths", () => {
  test("rejects OS paths and ..", () => {
    expect(isForbiddenOsPath("/Users/sean")).toBe(true);
    expect(isForbiddenOsPath("~/src")).toBe(true);
    expect(isForbiddenOsPath("/data/discord/eboard")).toBe(true);
    expect(sanitizeIndexPath("../")).toBeNull();
    expect(parseIndexPath("/Users/sean")).toBeNull();
    expect(parseIndexPath("../")).toBeNull();
  });

  test("tree root lists visible workspaces flat and sorted", () => {
    expect(contextStore.tree("/", eboard)).toEqual([
      { path: "/eboard", kind: "dir", name: "eboard" },
      { path: "/programs-dev", kind: "dir", name: "programs-dev" },
      { path: "/programs-mentorship", kind: "dir", name: "programs-mentorship" },
    ]);
    expect(contextStore.tree("/", pd)).toEqual([
      { path: "/programs-dev", kind: "dir", name: "programs-dev" },
    ]);
    expect(contextStore.tree("/", leadership).map((n) => n.path)).toEqual([
      "/eboard",
      "/leadership",
      "/programs-dev",
      "/programs-mentorship",
    ]);
  });

  test("tree walks workspace → category → channel, never Mini disk", () => {
    const ns = contextStore.tree("/eboard", eboard);
    expect(ns.some((n) => n.path === "/eboard/eboard-teams")).toBe(true);
    expect(ns.some((n) => n.path === "/eboard/general-chat-5005")).toBe(true);
    expect(ns.every((n) => n.path.startsWith("/eboard"))).toBe(true);
    const cat = contextStore.tree("/eboard/eboard-teams", eboard);
    expect(cat.some((n) => n.name === "sponsors-1001")).toBe(true);
    expect(cat.some((n) => n.name.startsWith("leadership-team"))).toBe(false);
  });

  test("tree of a workspace outside the scope is empty", () => {
    expect(contextStore.tree("/leadership", eboard)).toEqual([]);
    expect(contextStore.tree("/eboard", pd)).toEqual([]);
    expect(contextStore.tree("/programs-mentorship", pd)).toEqual([]);
  });

  test("readPath of an out-of-scope path is null", () => {
    expect(contextStore.readPath("/leadership/eboard-teams", eboard)).toBeNull();
    expect(contextStore.readPath("/programs-mentorship/programs", pd)).toBeNull();
    expect(contextStore.readPath("/general", leadership)).toBeNull();
  });
});

describe("bun run reindex rebuilds FTS", () => {
  test("rebuildFts is idempotent and restores search", () => {
    rebuildFts();
    expect(ftsCount()).toBeGreaterThan(0);
    const hits = contextStore.search({ query: "sponsors budget", scope: eboard });
    expect(hits.map((h) => h.id)).toContain(E_MSG);
  });

  test("reindexAll rebuilds FTS from messages", () => {
    reindexAll();
    expect(ftsCount()).toBeGreaterThan(0);
    expect(
      contextStore.search({ query: "secret retreat", scope: leadership }).map((h) => h.id),
    ).toContain(L_MSG);
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
    const hits = contextStore.search({ query: "sponsors budget", scope: eboard });
    expect(hits.map((h) => h.id)).toContain(E_MSG);
  });
});

describe("ContextStore search recall (issue #50)", () => {
  const FALL_MSG = "100000000000000201";
  const SEATING_MSG = "200000000000000202";
  const LINK_MSG = "100000000000000203";
  const DOC_URL = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit";

  beforeAll(() => {
    upsertMessage({
      id: FALL_MSG,
      channelId: "1001",
      authorId: "u1",
      authorName: "alice",
      content: "Fall '25 Prep: marketing apps + IG, events rooms/Engage, program leads forms/timeline",
      createdAt: 2_100,
    });
    indexFromRow(getMessage(FALL_MSG)!);
    upsertMessage({
      id: SEATING_MSG,
      channelId: "2002",
      authorId: "u2",
      authorName: "bob",
      content: "seating chart draft for the retreat",
      createdAt: 2_200,
    });
    indexFromRow(getMessage(SEATING_MSG)!);
    upsertMessage({
      id: LINK_MSG,
      channelId: "1001",
      authorId: "u1",
      authorName: "alice",
      content: `sponsor-deck-unique draft here ${DOC_URL}`,
      createdAt: 2_300,
    });
    indexFromRow(getMessage(LINK_MSG)!);
    persistLinks(LINK_MSG, "1001", extractLinks(getMessage(LINK_MSG)!.content), 2_300);
  });

  test("toFtsQueryLoose is an OR of AND-pairs and needs at least 3 terms", () => {
    expect(toFtsQueryLoose("zebra")).toBe("");
    expect(toFtsQueryLoose("zebra unique")).toBe("");
    expect(toFtsQueryLoose("foo bar baz")).toBe(
      '("foo" AND "bar") OR ("foo" AND "baz") OR ("bar" AND "baz")',
    );
    // A quoted phrase is one term.
    expect(toFtsQueryLoose('"retreat seating" plan')).toBe("");
    expect(toFtsQueryLoose('"retreat seating" plan zebra')).toContain('("retreat seating" AND "plan")');
    // Capped at 8 terms → 28 pairs.
    const many = toFtsQueryLoose("t1 t2 t3 t4 t5 t6 t7 t8 t9 t10");
    expect(many.split(" OR ").length).toBe(28);
    expect(many).not.toContain('"t9"');
  });

  test("a natural-language question falls back to the loose pass", () => {
    const strictMiss = contextStore.search({ query: "fall 2026 tasks before school starts", scope: eboard });
    expect(strictMiss.map((h) => h.id)).not.toContain(FALL_MSG);

    const loose = contextStore.search({ query: "fall 2026 prep tasks before school starts", scope: eboard });
    const looseHit = loose.find((h) => h.id === FALL_MSG);
    expect(looseHit).toBeDefined();
    expect(looseHit!.match).toBe("loose");

    const strict = contextStore.search({ query: "fall prep", scope: eboard });
    const strictHit = strict.find((h) => h.id === FALL_MSG);
    expect(strictHit).toBeDefined();
    expect(strictHit!.match).toBe("strict");
  });

  test("an all-stopword query does not throw", () => {
    expect(Array.isArray(contextStore.search({ query: "what is it", scope: eboard }))).toBe(true);
    expect(Array.isArray(contextStore.search({ query: "the a an", scope: leadership }))).toBe(true);
  });

  test("a punctuation-only query returns []", () => {
    expect(contextStore.search({ query: "?!... --- ///", scope: leadership })).toEqual([]);
    expect(contextStore.search({ query: "   ", scope: leadership })).toEqual([]);
  });

  test("a quoted phrase matches only the phrase", () => {
    const unquoted = contextStore.search({ query: "retreat seating", scope: leadership }).map((h) => h.id);
    expect(unquoted).toContain(L_THREAD_MSG);
    expect(unquoted).toContain(SEATING_MSG);
    const quoted = contextStore.search({ query: '"retreat seating"', scope: leadership }).map((h) => h.id);
    expect(quoted).toEqual([L_THREAD_MSG]);
  });

  test("pathPrefix is applied before the rank limit (no starvation)", () => {
    for (let i = 0; i < 48; i++) {
      const id = `100000000000000${String(300 + i)}`;
      upsertMessage({
        id,
        channelId: "1001",
        authorId: "u1",
        authorName: "alice",
        content: "starvation-token repeated in the busy channel",
        createdAt: 3_000 + i,
      });
      indexFromRow(getMessage(id)!);
    }
    const LONE = "100000000000000399";
    upsertMessage({
      id: LONE,
      channelId: "5005",
      authorId: "u5",
      authorName: "erin",
      content: "starvation-token repeated in the busy channel",
      createdAt: 3_999,
    });
    indexFromRow(getMessage(LONE)!);

    const hits = contextStore.search({
      query: "starvation-token repeated",
      scope: eboard,
      pathPrefix: "/eboard/general-chat-5005",
      limit: 10,
    });
    expect(hits.map((h) => h.id)).toEqual([LONE]);

    // A category prefix still covers the busy channel and nothing else.
    const cat = contextStore.search({
      query: "starvation-token repeated",
      scope: eboard,
      pathPrefix: "/eboard/eboard-teams/",
      limit: 10,
    });
    expect(cat.length).toBe(10);
    expect(cat.every((h) => h.channelId === "1001")).toBe(true);

    // An out-of-scope or unparseable prefix yields nothing.
    expect(
      contextStore.search({ query: "starvation-token repeated", scope: pd, pathPrefix: "/eboard" }),
    ).toEqual([]);
    expect(
      contextStore.search({ query: "starvation-token repeated", scope: eboard, pathPrefix: "/eboard/nope" }),
    ).toEqual([]);
  });

  test("hits carry links from the links table", () => {
    const hits = contextStore.search({ query: "sponsor-deck-unique", scope: eboard });
    const hit = hits.find((h) => h.id === LINK_MSG);
    expect(hit).toBeDefined();
    expect(hit!.links).toEqual([DOC_URL]);
    const other = hits.find((h) => h.id !== LINK_MSG);
    if (other) expect(other.links).toEqual([]);
  });

  test("thread pathPrefix is narrowed in SQL before the limit (no starvation)", () => {
    const THREAD_PATH = "/leadership/eboard-teams/leadership-team-2002/threads/retreat-seating-0050";
    const THREAD_HIT = "200000000000000200";
    // Add a matching message inside the target thread.
    upsertMessage({
      id: THREAD_HIT,
      channelId: L_THREAD_ID,
      parentChannelId: "2002",
      authorId: "u2",
      authorName: "bob",
      content: "thread-starvation-token unique to the retreat thread",
      createdAt: 6_000,
      threadId: L_THREAD_ID,
      threadName: "Retreat seating",
    });
    indexFromRow(getMessage(THREAD_HIT)!);
    // Flood the parent channel with matching messages so the pre-fix code would
    // fill the FTS window before reaching the thread row.
    for (let i = 0; i < 50; i++) {
      const id = `2000000000000000${String(i).padStart(2, "0")}`;
      upsertMessage({
        id,
        channelId: "2002",
        authorId: "u2",
        authorName: "bob",
        content: "thread-starvation-token unique to the retreat thread",
        createdAt: 5_000 + i,
      });
      indexFromRow(getMessage(id)!);
    }
    const hits = contextStore.search({
      query: "thread-starvation-token unique",
      scope: leadership,
      pathPrefix: THREAD_PATH,
      limit: 10,
    });
    expect(hits.map((h) => h.id)).toEqual([THREAD_HIT]);
    expect(hits.every((h) => h.path.startsWith(THREAD_PATH))).toBe(true);
  });
});
