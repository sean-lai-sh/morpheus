import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { reloadChannels, resetChannelsForTest, resetEnvForTest } from "../src/config.ts";
import {
  CANONICAL_CHANNELS_YML,
  WORKSPACE_TOKENS,
  clearWorkspaceTokenEnv,
  setWorkspaceTokenEnv,
  withTempCwd,
  withTempDb,
  writeCanonicalChannels,
} from "./helpers.ts";
import { handleRequest } from "../src/http/health.ts";
import { contextStore, indexFromRow } from "../src/context/store.ts";
import { scopeFor } from "../src/context/namespace.ts";
import { indexPathForRow } from "../src/context/paths.ts";
import { getMessage, markDeleted, upsertMessage } from "../src/storage/messages.ts";

const cwd = withTempCwd();
writeCanonicalChannels();
const db = withTempDb();
setWorkspaceTokenEnv();
resetEnvForTest();

const LEADERSHIP = WORKSPACE_TOKENS.leadership;
const EBOARD = WORKSPACE_TOKENS.eboard;
const PD = WORKSPACE_TOKENS["programs-dev"];

const E_MSG = "100000000000000001";
const L_MSG = "200000000000000002";
const L_THREAD_MSG = "200000000000000099";
const L_THREAD_ID = "200000000000000050";
const PM_MSG = "300000000000000003";
const PD_MSG = "400000000000000004";

beforeAll(() => {
  resetChannelsForTest();
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
});

afterAll(() => {
  resetChannelsForTest();
  clearWorkspaceTokenEnv();
  resetEnvForTest();
  db.cleanup();
  cwd.cleanup();
});

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function get(path: string, token?: string): Promise<Response> {
  return handleRequest(
    new Request(`http://127.0.0.1${path}`, {
      method: "GET",
      headers: token ? auth(token) : undefined,
    }),
  );
}

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  return handleRequest(
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? auth(token) : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

/** GET /v1/fs/tree with `raw` passed through verbatim (never pre-normalized by URL). */
async function tree(raw: string, token: string): Promise<Response> {
  return get(`/v1/fs/tree?path=${encodeURIComponent(raw)}`, token);
}

async function read(raw: string, token: string): Promise<Response> {
  return get(`/v1/fs/read?path=${encodeURIComponent(raw)}`, token);
}

async function nodesOf(res: Response): Promise<string[]> {
  const body = (await res.json()) as { nodes: Array<{ path: string }> };
  return body.nodes.map((n) => n.path);
}

async function hitsOf(res: Response): Promise<Array<{ id: string; path: string }>> {
  const body = (await res.json()) as { hits: Array<{ id: string; path: string }> };
  return body.hits;
}

/** Walk the poll cursor to exhaustion and return every document id seen. */
async function pollAll(token: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const qs = cursor ? `?limit=50&cursor=${encodeURIComponent(cursor)}` : "?limit=50";
    const res = await get(`/v1/poll${qs}`, token);
    expect(res.status).toBe(200);
    const page = (await res.json()) as { cursor: string; documents: Array<{ id: string }> };
    if (page.documents.length === 0) break;
    ids.push(...page.documents.map((d) => d.id));
    cursor = page.cursor;
  }
  return ids;
}

describe("GET /health", () => {
  test("no auth; includes fts_count; no message bodies or tokens", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.fts_count).toBe("number");
    expect(body.fts_count).toBeGreaterThan(0);
    const dumped = JSON.stringify(body);
    for (const tok of Object.values(WORKSPACE_TOKENS)) expect(dumped).not.toContain(tok);
    expect(dumped).not.toContain("test-token");
    expect(dumped).not.toContain("secret retreat");
    expect(dumped).not.toContain("sponsors budget");
  });
});

describe("auth", () => {
  test("no token → 401 on every /v1/*", async () => {
    expect((await get("/v1/fs/tree?path=/eboard")).status).toBe(401);
    expect((await post("/v1/fs/search", { query: "sponsors" })).status).toBe(401);
    expect((await get("/v1/fs/read?path=/eboard")).status).toBe(401);
    expect((await get(`/v1/messages/${E_MSG}`)).status).toBe(401);
    expect((await get("/v1/poll")).status).toBe(401);
    expect((await get("/v1/jobs")).status).toBe(401);
  });

  test("the Discord bot token is never a /v1 bearer", async () => {
    expect((await get("/v1/fs/tree?path=/eboard", "test-token")).status).toBe(401);
    expect((await post("/v1/fs/search", { query: "sponsors" }, "test-token")).status).toBe(401);
    expect((await get(`/v1/messages/${E_MSG}`, "test-token")).status).toBe(401);
    expect((await get("/v1/poll", "test-token")).status).toBe(401);
  });

  test("an unknown bearer is 401", async () => {
    expect((await get("/v1/poll", "tok-nobody-0123456789")).status).toBe(401);
  });

  test("responses are never cached", async () => {
    const res = await tree("/", PD);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const denied = await tree("/eboard", PD);
    expect(denied.headers.get("cache-control")).toBe("no-store");
  });
});

describe("tree root shows exactly the token's subtree", () => {
  test("programs-dev sees only itself", async () => {
    const res = await tree("/", PD);
    expect(res.status).toBe(200);
    expect(await nodesOf(res)).toEqual(["/programs-dev"]);
  });

  test("eboard sees itself and its two children, never leadership", async () => {
    const res = await tree("/", EBOARD);
    expect(res.status).toBe(200);
    expect(await nodesOf(res)).toEqual(["/eboard", "/programs-dev", "/programs-mentorship"]);
  });

  test("leadership sees all four", async () => {
    const res = await tree("/", LEADERSHIP);
    expect(res.status).toBe(200);
    expect(await nodesOf(res)).toEqual([
      "/eboard",
      "/leadership",
      "/programs-dev",
      "/programs-mentorship",
    ]);
  });
});

describe("path isolation: sideways and upward are both 404", () => {
  test("programs-dev cannot tree a sibling workspace", async () => {
    expect((await tree("/programs-mentorship", PD)).status).toBe(404);
    expect((await tree("/programs-mentorship/programs/mentorship-chat-3003", PD)).status).toBe(404);
  });

  test("programs-dev cannot read a sibling's message", async () => {
    expect((await get(`/v1/messages/${PM_MSG}`, PD)).status).toBe(404);
    expect(
      (await read("/programs-mentorship/programs/mentorship-chat-3003", PD)).status,
    ).toBe(404);
  });

  test("eboard cannot tree its parent workspace", async () => {
    expect((await tree("/leadership", EBOARD)).status).toBe(404);
    expect((await tree("/leadership/eboard-teams", EBOARD)).status).toBe(404);
    expect((await read("/leadership/eboard-teams/leadership-team-2002", EBOARD)).status).toBe(404);
  });

  test("eboard cannot read a leadership message or its thread", async () => {
    expect((await get(`/v1/messages/${L_MSG}`, EBOARD)).status).toBe(404);
    expect((await get(`/v1/messages/${L_THREAD_MSG}`, EBOARD)).status).toBe(404);
  });

  test("traversal out of programs-dev is 404 on tree, read and search", async () => {
    const escapes = [
      "/programs-dev/../eboard",
      "/programs-dev/%2e%2e/eboard",
      "/programs-dev/%252e%252e/leadership",
    ];
    for (const raw of escapes) {
      expect((await tree(raw, PD)).status).toBe(404);
      expect((await read(raw, PD)).status).toBe(404);
      expect(
        (await post("/v1/fs/search", { query: "sponsors", pathPrefix: raw }, PD)).status,
      ).toBe(404);
    }
  });

  test("pre-workspace names and bare categories are 404 even for leadership", async () => {
    for (const raw of ["/_legacy", "/general", "/programs", "/eboard-teams"]) {
      expect((await tree(raw, LEADERSHIP)).status).toBe(404);
      expect((await read(raw, LEADERSHIP)).status).toBe(404);
    }
  });

  test("OS paths, ~, encoded .. and host paths → 404", async () => {
    for (const raw of ["/Users/sean", "../", "~/src", "/etc/passwd", "//Users/sean", "%2e%2e", "%252e%252e"]) {
      expect((await tree(raw, EBOARD)).status).toBe(404);
      expect((await read(raw, EBOARD)).status).toBe(404);
    }
    expect(
      (await post("/v1/fs/search", { query: "sponsors", pathPrefix: "/Users/sean" }, EBOARD)).status,
    ).toBe(404);
    expect(
      (await post("/v1/fs/search", { query: "sponsors", pathPrefix: "%2e%2e" }, EBOARD)).status,
    ).toBe(404);
  });

  test("a client-supplied namespace is not authorization", async () => {
    // Matching the token root is fine, but the path is still checked: 404.
    expect(
      (await get(`/v1/fs/tree?path=${encodeURIComponent("/eboard")}&namespace=programs-dev`, PD)).status,
    ).toBe(404);
    // Claiming a different workspace than the token's root is 403.
    expect(
      (await get(`/v1/fs/tree?path=${encodeURIComponent("/programs-dev")}&namespace=eboard`, PD)).status,
    ).toBe(403);
    expect(
      (await post("/v1/fs/search", { query: "sponsors", namespace: "leadership" }, EBOARD)).status,
    ).toBe(403);
  });

  test("`..` that lands inside the scope is allowed", async () => {
    // constrainIndexPath normalizes first: this resolves to /programs-dev/... which
    // IS visible from an eboard token, so it is served rather than refused.
    const res = await read("/eboard/../programs-dev/programs/dev-chat-4004", EBOARD);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; documents: Array<{ id: string }> };
    expect(body.path).toBe("/programs-dev/programs/dev-chat-4004");
    expect(body.documents.map((d) => d.id)).toContain(PD_MSG);
  });
});

describe("search HTTP", () => {
  test("includeDeleted true → 400 everywhere", async () => {
    expect((await post("/v1/fs/search", { query: "sponsors", includeDeleted: true }, EBOARD)).status).toBe(400);
    expect((await get(`/v1/messages/${E_MSG}?includeDeleted=true`, EBOARD)).status).toBe(400);
    expect((await get("/v1/fs/read?path=/eboard&includeDeleted=true", EBOARD)).status).toBe(400);
    expect((await get("/v1/poll?includeDeleted=true", EBOARD)).status).toBe(400);
    expect((await get("/v1/fs/tree?path=/&includeDeleted=true", PD)).status).toBe(400);
  });

  test("eboard cannot reach leadership content by exact token", async () => {
    const zebra = await post("/v1/fs/search", { query: "zebra-unique-9" }, EBOARD);
    expect(zebra.status).toBe(200);
    expect(await hitsOf(zebra)).toEqual([]);
    const retreat = await post("/v1/fs/search", { query: "retreat seating" }, EBOARD);
    expect(retreat.status).toBe(200);
    expect(await hitsOf(retreat)).toEqual([]);
  });

  test("leadership finds its own unique token", async () => {
    const res = await post("/v1/fs/search", { query: "zebra-unique-9" }, LEADERSHIP);
    expect(res.status).toBe(200);
    const hits = await hitsOf(res);
    expect(hits.length).toBe(1);
    expect(hits[0]!.id).toBe(L_MSG);
    expect(hits[0]!.path.startsWith("/leadership/")).toBe(true);
  });

  test("leadership finds the thread under an isolated parent", async () => {
    const res = await post("/v1/fs/search", { query: "retreat seating" }, LEADERSHIP);
    const body = (await res.json()) as {
      hits: Array<{ id: string; channelId: string; parentChannelId: string | null }>;
    };
    const hit = body.hits.find((h) => h.id === L_THREAD_MSG);
    expect(hit).toBeDefined();
    expect(hit!.channelId).toBe(L_THREAD_ID);
    expect(hit!.parentChannelId).toBe("2002");
  });

  test("programs-dev sees nothing from its parent", async () => {
    const res = await post("/v1/fs/search", { query: "sponsors" }, PD);
    expect(res.status).toBe(200);
    expect(await hitsOf(res)).toEqual([]);
  });

  test("eboard can search a descendant via pathPrefix", async () => {
    const res = await post(
      "/v1/fs/search",
      { query: "mentorship", pathPrefix: "/programs-mentorship" },
      EBOARD,
    );
    expect(res.status).toBe(200);
    const hits = await hitsOf(res);
    expect(hits.map((h) => h.id)).toEqual([PM_MSG]);
    expect(hits[0]!.path.startsWith("/programs-mentorship/programs/")).toBe(true);
  });

  test("threadId body filter narrows to the thread (never silently ignored)", async () => {
    // "retreat" matches both the main-channel plan (L_MSG) and the thread message.
    const all = await post("/v1/fs/search", { query: "retreat" }, LEADERSHIP);
    expect((await hitsOf(all)).map((h) => h.id).sort()).toEqual([L_MSG, L_THREAD_MSG].sort());
    const threaded = await post("/v1/fs/search", { query: "retreat", threadId: L_THREAD_ID }, LEADERSHIP);
    expect((await hitsOf(threaded)).map((h) => h.id)).toEqual([L_THREAD_MSG]);
    expect((await post("/v1/fs/search", { query: "retreat", threadId: 123 }, LEADERSHIP)).status).toBe(400);
  });

  test("sinceMs / untilMs body filters bound createdAt (never silently ignored)", async () => {
    // L_MSG createdAt 1100; L_THREAD_MSG createdAt 1200.
    const since = await post("/v1/fs/search", { query: "retreat", sinceMs: 1_150 }, LEADERSHIP);
    expect((await hitsOf(since)).map((h) => h.id)).toEqual([L_THREAD_MSG]);
    const until = await post("/v1/fs/search", { query: "retreat", untilMs: 1_150 }, LEADERSHIP);
    expect((await hitsOf(until)).map((h) => h.id)).toEqual([L_MSG]);
    const none = await post("/v1/fs/search", { query: "retreat", sinceMs: 99_999 }, LEADERSHIP);
    expect(await hitsOf(none)).toEqual([]);
    expect((await post("/v1/fs/search", { query: "retreat", sinceMs: "abc" }, LEADERSHIP)).status).toBe(400);
    expect((await post("/v1/fs/search", { query: "retreat", untilMs: "later" }, LEADERSHIP)).status).toBe(400);
  });

  test("channelHint body filter narrows by id or unique name; unknown name → no hits", async () => {
    const byId = await post("/v1/fs/search", { query: "retreat", channelHint: "2002" }, LEADERSHIP);
    expect((await hitsOf(byId)).map((h) => h.id).sort()).toEqual([L_MSG, L_THREAD_MSG].sort());
    const byName = await post("/v1/fs/search", { query: "retreat", channelHint: "leadership-team" }, LEADERSHIP);
    expect((await hitsOf(byName)).map((h) => h.id).sort()).toEqual([L_MSG, L_THREAD_MSG].sort());
    const wrongChannel = await post("/v1/fs/search", { query: "retreat", channelHint: "1001" }, LEADERSHIP);
    expect(await hitsOf(wrongChannel)).toEqual([]);
    const unknown = await post("/v1/fs/search", { query: "retreat", channelHint: "no-such-channel" }, LEADERSHIP);
    expect(unknown.status).toBe(200);
    expect(await hitsOf(unknown)).toEqual([]);
    expect((await post("/v1/fs/search", { query: "retreat", channelHint: 42 }, LEADERSHIP)).status).toBe(400);
  });

  test("present-but-invalid body filters are 400, including explicit null (never silently dropped)", async () => {
    const cases: Array<[string, unknown]> = [
      ["channelHint", null],
      ["channelHint", 42],
      ["channelHint", ""],
      ["threadId", null],
      ["threadId", 42],
      ["threadId", ""],
      ["sinceMs", null],
      ["sinceMs", "abc"],
      ["sinceMs", true],
      ["untilMs", null],
      ["untilMs", "later"],
      ["untilMs", {}],
    ];
    for (const [key, value] of cases) {
      const res = await post("/v1/fs/search", { query: "retreat", [key]: value }, LEADERSHIP);
      expect(`${key}=${JSON.stringify(value)} → ${res.status}`).toBe(`${key}=${JSON.stringify(value)} → 400`);
      expect(((await res.json()) as { error: string }).error).toContain(key);
    }
    // Absent filters still search unfiltered.
    const absent = await post("/v1/fs/search", { query: "retreat" }, LEADERSHIP);
    expect(absent.status).toBe(200);
    expect((await hitsOf(absent)).length).toBeGreaterThan(0);
  });

  test("channelHint name shared by two visible channels → 400 over HTTP, no hits in-store", async () => {
    // Duplicate eboard's general-chat name into programs-dev.
    writeCanonicalChannels(
      process.cwd(),
      CANONICAL_CHANNELS_YML.replace(
        '- { id: "5005", name: general-chat, workspace: eboard }',
        '- { id: "5005", name: general-chat, workspace: eboard }\n  - { id: "6006", name: general-chat, workspace: programs-dev }',
      ),
    );
    reloadChannels();
    try {
      const res = await post("/v1/fs/search", { query: "retreat", channelHint: "general-chat" }, EBOARD);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("ambiguous");
      // In-store, an ambiguous hint fails closed to no hits (never first-match).
      const eboardScope = scopeFor("eboard")!;
      expect(contextStore.search({ query: "retreat", scope: eboardScope, channelHint: "general-chat" })).toEqual([]);
      // The snowflake id keeps working.
      expect((await post("/v1/fs/search", { query: "retreat", channelHint: "5005" }, EBOARD)).status).toBe(200);
    } finally {
      writeCanonicalChannels();
      reloadChannels();
    }
  });

  test("eboard grep of its own content returns workspace-rooted paths", async () => {
    const res = await post("/v1/fs/search", { query: "sponsors budget" }, EBOARD);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ id: string; path: string; permalink: string }> };
    expect(body.hits.map((h) => h.id)).toContain(E_MSG);
    expect(body.hits[0]!.path.startsWith("/eboard/")).toBe(true);
    expect(body.hits[0]!.permalink).toContain(`/${E_MSG}`);
  });
});

describe("tree / read / poll", () => {
  test("tree lists virtual index children, capped", async () => {
    const res = await tree("/eboard", EBOARD);
    expect(res.status).toBe(200);
    const nodes = await nodesOf(res);
    expect(nodes).toContain("/eboard/eboard-teams");
    expect(nodes).toContain("/eboard/general-chat-5005");
    expect(nodes.length).toBeLessThanOrEqual(100);
  });

  test("read an eboard message path", async () => {
    const search = await post("/v1/fs/search", { query: "sponsors budget" }, EBOARD);
    const hits = await hitsOf(search);
    const path = hits[0]?.path;
    expect(path).toBeTruthy();
    const res = await read(path!, EBOARD);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { document: { id: string; channelId: string; permalink: string } };
    expect(body.document.id).toBe(E_MSG);
    expect(body.document.channelId).toBe("1001");
    expect(body.document.permalink).toContain("/1001/");
  });

  test("GET /v1/messages/:id as the leadership token", async () => {
    const res = await get(`/v1/messages/${L_THREAD_MSG}`, LEADERSHIP);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      document: { channelId: string; parentChannelId: string | null };
    };
    expect(body.document.channelId).toBe(L_THREAD_ID);
    expect(body.document.parentChannelId).toBe("2002");
  });

  test("programs-dev's poll stream is only its own workspace", async () => {
    const ids = await pollAll(PD);
    expect([...new Set(ids)]).toEqual([PD_MSG]);
  });

  test("eboard's poll stream covers the subtree but never leadership", async () => {
    const ids = new Set(await pollAll(EBOARD));
    expect(ids.has(E_MSG)).toBe(true);
    expect(ids.has(PM_MSG)).toBe(true);
    expect(ids.has(PD_MSG)).toBe(true);
    expect(ids.has(L_MSG)).toBe(false);
    expect(ids.has(L_THREAD_MSG)).toBe(false);
  });

  test("poll uses seq and sees an edit", async () => {
    const id = "100000000000000066";
    upsertMessage({
      id,
      channelId: "1001",
      authorId: "u1",
      authorName: "alice",
      content: "poll-http original unique-http-seq",
      createdAt: 8_000,
    });
    indexFromRow(getMessage(id)!);
    const before = await get("/v1/poll?limit=50", EBOARD);
    const page = (await before.json()) as { cursor: string; documents: Array<{ id: string; seq: number }> };
    const row = page.documents.find((d) => d.id === id);
    expect(row).toBeDefined();
    const cursor = `${row!.seq}:${row!.id}`;

    upsertMessage({
      id,
      channelId: "1001",
      authorId: "u1",
      authorName: "alice",
      content: "poll-http edited unique-http-seq",
      createdAt: 8_000,
      editedAt: 8_500,
    });
    indexFromRow(getMessage(id)!);

    const after = await get(`/v1/poll?cursor=${encodeURIComponent(cursor)}&limit=50`, EBOARD);
    expect(after.status).toBe(200);
    const page2 = (await after.json()) as { documents: Array<{ id: string; content: string }> };
    expect(page2.documents.find((d) => d.id === id)?.content).toContain("edited");
  });

  test("deleted messages are 404 on cat and omit content on poll", async () => {
    const id = "100000000000000077";
    upsertMessage({
      id,
      channelId: "1001",
      authorId: "u1",
      authorName: "alice",
      content: "http-deleted-body-secret unique-del-http",
      createdAt: 9_000,
    });
    indexFromRow(getMessage(id)!);
    const path = indexPathForRow(getMessage(id)!)!;
    const live = await get(`/v1/messages/${id}`, EBOARD);
    expect(live.status).toBe(200);
    expect(((await live.json()) as { document: { content: string } }).document.content).toContain(
      "http-deleted-body-secret",
    );

    const before = getMessage(id)!.seq;
    markDeleted(id, 9_500);
    indexFromRow(getMessage(id)!);

    expect((await get(`/v1/messages/${id}`, EBOARD)).status).toBe(404);
    expect((await read(path, EBOARD)).status).toBe(404);

    const poll = await get(`/v1/poll?cursor=${encodeURIComponent(`${before}:${id}`)}&limit=50`, EBOARD);
    expect(poll.status).toBe(200);
    const page = (await poll.json()) as {
      documents: Array<{ id: string; content: string; deletedAt: number | null }>;
    };
    const hit = page.documents.find((d) => d.id === id);
    expect(hit?.deletedAt).toBe(9_500);
    expect(hit?.content).toBe("");
  });
});

describe("config reload is fail-closed", () => {
  test("dropping a channel from channels.yml hides it immediately", async () => {
    const withoutPdChannel = CANONICAL_CHANNELS_YML.replace(
      /^\s*- \{ id: "4004".*$\n/m,
      "",
    );
    expect(withoutPdChannel).not.toContain("4004");
    writeCanonicalChannels(process.cwd(), withoutPdChannel);
    reloadChannels();
    try {
      expect((await tree("/programs-dev/programs/dev-chat-4004", PD)).status).toBe(404);
      expect((await read("/programs-dev/programs/dev-chat-4004", PD)).status).toBe(404);
      expect((await get(`/v1/messages/${PD_MSG}`, PD)).status).toBe(404);
      expect(await pollAll(PD)).toEqual([]);
      const search = await post("/v1/fs/search", { query: "dev-chat-unique" }, PD);
      expect(search.status).toBe(200);
      expect(await hitsOf(search)).toEqual([]);
    } finally {
      writeCanonicalChannels();
      reloadChannels();
    }
    // Restored.
    expect((await tree("/programs-dev/programs/dev-chat-4004", PD)).status).toBe(200);
  });
});
