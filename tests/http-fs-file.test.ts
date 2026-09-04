import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { withTempDb } from "./helpers.ts";
import {
  DEV_TOKEN,
  EBOARD_TOKEN,
  LEADERSHIP_TEAM_PATH,
  LEADERSHIP_TOKEN,
  SPONSORS_PATH,
  withWorkspaceConfig,
} from "./jobs-fixture.ts";
import { handleHttpRequest } from "../src/http/health.ts";
import { discordDir } from "../src/storage/markdown.ts";

const db = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;

const BLOCKS = 300;

function writeExport(relDir: string, name: string, blocks: number): void {
  const dir = resolve(discordDir(), relDir);
  mkdirSync(dir, { recursive: true });
  const header = [`# #${name}`, "- channel_id: 1001", "- guild_id: 1", ""].join("\n");
  const body = Array.from(
    { length: blocks },
    (_, i) => `## [2026-01-01 00:00 UTC] @someone (msg:${1000 + i})\nblock ${i} ${"y".repeat(40)}`,
  ).join("\n\n");
  writeFileSync(resolve(dir, "main.md"), `${header}\n---\n${body}\n`);
}

beforeAll(() => {
  cfg = withWorkspaceConfig();
  writeExport("eboard/eboard-teams/sponsors-1001", "sponsors", BLOCKS);
  writeExport("leadership/eboard-teams/leadership-team-2002", "leadership-team", 10);
});

afterAll(() => {
  cfg.cleanup();
  db.cleanup?.();
});

function fileReq(
  path: string,
  opts: { token?: string | null; range?: string; method?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? EBOARD_TOKEN}`;
  if (opts.range) headers.range = opts.range;
  return new Request(`http://127.0.0.1/v1/fs/file?path=${encodeURIComponent(path)}`, {
    method: opts.method ?? "GET",
    headers,
  });
}

describe("GET /v1/fs/file", () => {
  test("serves the whole export with download headers", async () => {
    const res = await handleHttpRequest(fileReq(SPONSORS_PATH));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-disposition")).toContain("sponsors-1001.md");
    expect(res.headers.get("etag")).toBeTruthy();
    expect(res.headers.get("last-modified")).toBeTruthy();
    expect(res.headers.get("x-morpheus-index-path")).toBe(SPONSORS_PATH);

    const text = await res.text();
    expect(text).toContain("# #sponsors");
    expect(text).toContain("block 0 ");
    expect(text).toContain(`block ${BLOCKS - 1} `);
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(text)));
  });

  test("HEAD returns size and validators without a body", async () => {
    const res = await handleHttpRequest(fileReq(SPONSORS_PATH, { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("");
  });

  test("suffix range returns the newest bytes as 206", async () => {
    const head = await handleHttpRequest(fileReq(SPONSORS_PATH, { method: "HEAD" }));
    const size = Number(head.headers.get("content-length"));

    const res = await handleHttpRequest(fileReq(SPONSORS_PATH, { range: "bytes=-2000" }));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes ${size - 2000}-${size - 1}/${size}`);
    const text = await res.text();
    expect(Buffer.byteLength(text)).toBe(2000);
    // The tail is the newest content, which is the whole point.
    expect(text).toContain(`block ${BLOCKS - 1} `);
    expect(text).not.toContain("block 0 ");
  });

  test("explicit range window is honored", async () => {
    const res = await handleHttpRequest(fileReq(SPONSORS_PATH, { range: "bytes=0-99" }));
    expect(res.status).toBe(206);
    expect(Buffer.byteLength(await res.text())).toBe(100);
  });

  test("a range past EOF is 416 with a content-range of the true size", async () => {
    const res = await handleHttpRequest(fileReq(SPONSORS_PATH, { range: "bytes=99999999-" }));
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toMatch(/^bytes \*\/\d+$/);
  });
});

describe("/v1/fs/file authorization", () => {
  test("no token is 401", async () => {
    const res = await handleHttpRequest(fileReq(SPONSORS_PATH, { token: null }));
    expect(res.status).toBe(401);
  });

  test("a token that cannot see the workspace gets 404, not the file", async () => {
    // programs-dev is a descendant of eboard; it must not read an eboard file.
    const res = await handleHttpRequest(fileReq(SPONSORS_PATH, { token: DEV_TOKEN }));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("block 0");
  });

  test("eboard cannot read its ancestor leadership", async () => {
    const res = await handleHttpRequest(fileReq(LEADERSHIP_TEAM_PATH, { token: EBOARD_TOKEN }));
    expect(res.status).toBe(404);
  });

  test("leadership can read a descendant workspace's file", async () => {
    const res = await handleHttpRequest(fileReq(SPONSORS_PATH, { token: LEADERSHIP_TOKEN }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("# #sponsors");
  });

  test("directory, traversal, and unwritten paths are all a flat 404", async () => {
    for (const p of [
      "/",
      "/eboard",
      "/eboard/eboard-teams",
      "/eboard/../../etc/passwd",
      "/eboard/eboard-teams/never-written-9999",
    ]) {
      const res = await handleHttpRequest(fileReq(p));
      expect(res.status).toBe(404);
    }
  });

  test("a missing path parameter is 404", async () => {
    const res = await handleHttpRequest(
      new Request("http://127.0.0.1/v1/fs/file", {
        headers: { authorization: `Bearer ${EBOARD_TOKEN}` },
      }),
    );
    expect(res.status).toBe(404);
  });
});
