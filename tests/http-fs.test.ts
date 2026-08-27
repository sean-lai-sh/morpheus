import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resetChannelsForTest, resetEnvForTest } from "../src/config.ts";
import { withTempCwd, withTempDb } from "./helpers.ts";
import { handleRequest } from "../src/http/health.ts";
import { indexFromRow } from "../src/context/store.ts";
import { getMessage, upsertMessage } from "../src/storage/messages.ts";

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
process.env.MORPHEUS_API_TOKEN_GENERAL = "tok-general";
process.env.MORPHEUS_API_TOKEN_LEADERSHIP = "tok-leadership";
resetEnvForTest();

const GENERAL_MSG = "100000000000000001";
const LEADER_MSG = "200000000000000002";
const LEADER_THREAD_MSG = "200000000000000099";
const LEADER_THREAD_ID = "200000000000000050";

beforeAll(() => {
  resetChannelsForTest();
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
});

afterAll(() => {
  resetChannelsForTest();
  delete process.env.MORPHEUS_API_TOKEN_GENERAL;
  delete process.env.MORPHEUS_API_TOKEN_LEADERSHIP;
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

describe("GET /health", () => {
  test("no auth; includes fts_count; no message bodies or tokens", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.fts_count).toBe("number");
    expect(body.fts_count).toBeGreaterThan(0);
    expect(body.nia_dirty).toBeUndefined();
    expect(body.nia_last_sync_at).toBeUndefined();
    expect(body.nia_consecutive_failures).toBeUndefined();
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain("tok-general");
    expect(dumped).not.toContain("test-token");
    expect(dumped).not.toContain("secret retreat");
    expect(dumped).not.toContain("sponsors budget");
  });
});

describe("auth", () => {
  test("no token → 401 on every /v1/*", async () => {
    expect((await get("/v1/fs/tree?path=/general")).status).toBe(401);
    expect((await post("/v1/fs/search", { query: "sponsors" })).status).toBe(401);
    expect((await get("/v1/fs/read?path=/general")).status).toBe(401);
    expect((await get(`/v1/messages/${GENERAL_MSG}`)).status).toBe(401);
    expect((await get("/v1/poll")).status).toBe(401);
    expect((await get("/v1/jobs")).status).toBe(401);
  });

  test("DISCORD_BOT_TOKEN is not accepted as this bearer", async () => {
    const res = await get("/v1/fs/tree?path=/general", "test-token");
    expect(res.status).toBe(401);
  });

  test("client-supplied namespace=leadership with general token → 403", async () => {
    const q = await get("/v1/fs/tree?path=/general&namespace=leadership", "tok-general");
    expect(q.status).toBe(403);
    const s = await post(
      "/v1/fs/search",
      { query: "sponsors", namespace: "leadership" },
      "tok-general",
    );
    expect(s.status).toBe(403);
  });
});

describe("path isolation", () => {
  test("general token cannot tree/read a /leadership path", async () => {
    const tree = await get("/v1/fs/tree?path=/leadership/eboard-teams", "tok-general");
    expect(tree.status).toBe(404);
    const read = await get(
      "/v1/fs/read?path=/leadership/eboard-teams/leadership-team-2002",
      "tok-general",
    );
    expect(read.status).toBe(404);
  });

  test("general token + leadership message id → 404", async () => {
    const res = await get(`/v1/messages/${LEADER_MSG}`, "tok-general");
    expect(res.status).toBe(404);
    const thread = await get(`/v1/messages/${LEADER_THREAD_MSG}`, "tok-general");
    expect(thread.status).toBe(404);
  });

  test("path=/Users/sean or path=../ → 404", async () => {
    expect((await get("/v1/fs/tree?path=/Users/sean", "tok-general")).status).toBe(404);
    expect((await get("/v1/fs/read?path=/Users/sean", "tok-general")).status).toBe(404);
    expect((await get("/v1/fs/tree?path=../", "tok-general")).status).toBe(404);
    expect((await get("/v1/fs/read?path=../", "tok-general")).status).toBe(404);
    const search = await post(
      "/v1/fs/search",
      { query: "sponsors", pathPrefix: "/Users/sean" },
      "tok-general",
    );
    expect(search.status).toBe(404);
  });

  test("encoded .., ~, and host paths → 404", async () => {
    expect((await get("/v1/fs/tree?path=%2e%2e", "tok-general")).status).toBe(404);
    expect((await get("/v1/fs/tree?path=%252e%252e", "tok-general")).status).toBe(404);
    expect(
      (await get("/v1/fs/tree?path=/general/%2e%2e/%2e%2e/Users/sean", "tok-general")).status,
    ).toBe(404);
    expect((await get("/v1/fs/tree?path=/general/../leadership", "tok-general")).status).toBe(404);
    expect((await get("/v1/fs/read?path=~/src", "tok-general")).status).toBe(404);
    expect((await get("/v1/fs/read?path=/etc/passwd", "tok-general")).status).toBe(404);
    expect(
      (await post("/v1/fs/search", { query: "sponsors", pathPrefix: "%2e%2e" }, "tok-general")).status,
    ).toBe(404);
    expect(
      (await post(
        "/v1/fs/search",
        { query: "sponsors", pathPrefix: "/general/../leadership" },
        "tok-general",
      )).status,
    ).toBe(404);
  });
});

describe("search HTTP", () => {
  test("includeDeleted true → 400", async () => {
    const res = await post(
      "/v1/fs/search",
      { query: "sponsors", includeDeleted: true },
      "tok-general",
    );
    expect(res.status).toBe(400);
  });

  test("leadership thread is not in general search", async () => {
    const res = await post("/v1/fs/search", { query: "retreat seating" }, "tok-general");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ id: string; path: string }> };
    expect(body.hits.map((h) => h.id)).not.toContain(LEADER_THREAD_MSG);
    expect(body.hits.map((h) => h.id)).not.toContain(LEADER_MSG);
  });

  test("general token can grep general content", async () => {
    const res = await post("/v1/fs/search", { query: "sponsors budget" }, "tok-general");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ id: string; path: string; permalink: string }> };
    expect(body.hits.map((h) => h.id)).toContain(GENERAL_MSG);
    expect(body.hits[0]?.path.startsWith("/general/")).toBe(true);
    expect(body.hits[0]?.permalink).toContain(`/${GENERAL_MSG}`);
  });

  test("leadership token finds isolated thread", async () => {
    const res = await post("/v1/fs/search", { query: "retreat seating" }, "tok-leadership");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hits: Array<{ id: string; channelId: string; parentChannelId: string | null }> };
    expect(body.hits.map((h) => h.id)).toContain(LEADER_THREAD_MSG);
    const hit = body.hits.find((h) => h.id === LEADER_THREAD_MSG);
    expect(hit?.channelId).toBe(LEADER_THREAD_ID);
    expect(hit?.parentChannelId).toBe("2002");
  });
});

describe("tree / read / poll", () => {
  test("tree lists virtual index children, capped", async () => {
    const res = await get("/v1/fs/tree?path=/general", "tok-general");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: Array<{ path: string; kind: string }> };
    expect(body.nodes.some((n) => n.path === "/general/eboard-teams")).toBe(true);
    expect(body.nodes.length).toBeLessThanOrEqual(100);
  });

  test("read a general message path", async () => {
    const search = await post("/v1/fs/search", { query: "sponsors budget" }, "tok-general");
    const { hits } = (await search.json()) as { hits: Array<{ path: string; id: string }> };
    const path = hits[0]?.path;
    expect(path).toBeTruthy();
    const res = await get(`/v1/fs/read?path=${encodeURIComponent(path!)}`, "tok-general");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { document: { id: string; channelId: string; permalink: string } };
    expect(body.document.id).toBe(GENERAL_MSG);
    expect(body.document.channelId).toBe("1001");
    expect(body.document.permalink).toContain("/1001/");
  });

  test("GET /v1/messages/:id as leadership token", async () => {
    const res = await get(`/v1/messages/${LEADER_THREAD_MSG}`, "tok-leadership");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      document: { channelId: string; parentChannelId: string | null };
    };
    expect(body.document.channelId).toBe(LEADER_THREAD_ID);
    expect(body.document.parentChannelId).toBe("2002");
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
    const before = await get("/v1/poll?limit=50", "tok-general");
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

    const after = await get(`/v1/poll?cursor=${encodeURIComponent(cursor)}&limit=50`, "tok-general");
    expect(after.status).toBe(200);
    const page2 = (await after.json()) as { documents: Array<{ id: string; content: string }> };
    expect(page2.documents.find((d) => d.id === id)?.content).toContain("edited");
  });
});
