import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetChannelsForTest, resetEnvForTest } from "../src/config.ts";
import {
  WORKSPACE_TOKENS,
  clearWorkspaceTokenEnv,
  setWorkspaceTokenEnv,
  withTempCwd,
  withTempDb,
  writeCanonicalChannels,
} from "./helpers.ts";
import { handleRequest } from "../src/http/health.ts";
import { indexFromRow } from "../src/context/store.ts";
import { getMessage, markDeleted, upsertMessage, type MessageInput } from "../src/storage/messages.ts";
import { extractLinks, persistLinks } from "../src/storage/links.ts";

const cwd = withTempCwd();
writeCanonicalChannels();
const db = withTempDb();
setWorkspaceTokenEnv();
resetEnvForTest();

const LEADERSHIP = WORKSPACE_TOKENS.leadership;
const EBOARD = WORKSPACE_TOKENS.eboard;
const PD = WORKSPACE_TOKENS["programs-dev"];

const DOC_A = "https://docs.google.com/document/d/AAAAAAAAAAAAAAAAAAAA/edit";
const DOC_A_OLD = "https://docs.google.com/document/d/AAAAAAAAAAAAAAAAAAAA/view";
const SHEET_E = "https://sheets.google.com/spreadsheets/d/EEEEEEEEEEEEEEEEEEEE/edit";
const DRIVE_L = "https://drive.google.com/file/d/LLLLLLLLLLLLLLLLLLLL/view";
const DRIVE_T = "https://drive.google.com/file/d/TTTTTTTTTTTTTTTTTTTT/view";
const FORM_PD = "https://forms.google.com/forms/d/PPPPPPPPPPPPPPPPPPPP/viewform";
const SLIDES_DEL = "https://docs.google.com/presentation/d/DDDDDDDDDDDDDDDDDDDD/edit";

const E_MSG = "100000000000000001"; // eboard 1001: DOC_A (newest of the dup pair) + SHEET_E
const E_OLD_MSG = "100000000000000002"; // eboard 1001: DOC_A_OLD (older, same file_id)
const E_DEL_MSG = "100000000000000003"; // eboard 1001: SLIDES_DEL, deleted
const L_MSG = "200000000000000002"; // leadership 2002: DRIVE_L
const L_THREAD_ID = "200000000000000050";
const L_THREAD_MSG = "200000000000000099"; // thread under 2002: DRIVE_T
const PD_MSG = "400000000000000004"; // programs-dev 4004: FORM_PD

function seed(input: MessageInput, firstSeenAt: number): void {
  upsertMessage(input);
  const row = getMessage(input.id)!;
  indexFromRow(row);
  persistLinks(input.id, input.channelId, extractLinks(input.content), firstSeenAt);
}

beforeAll(() => {
  resetChannelsForTest();
  seed(
    { id: E_OLD_MSG, channelId: "1001", authorId: "u1", authorName: "alice", content: `old ${DOC_A_OLD}`, createdAt: 1_000 },
    1_000,
  );
  seed(
    { id: E_MSG, channelId: "1001", authorId: "u1", authorName: "alice", content: `budget ${DOC_A} and ${SHEET_E}`, createdAt: 2_000 },
    2_000,
  );
  seed(
    { id: E_DEL_MSG, channelId: "1001", authorId: "u1", authorName: "alice", content: `deck ${SLIDES_DEL}`, createdAt: 2_500 },
    2_500,
  );
  markDeleted(E_DEL_MSG, 2_600);
  indexFromRow(getMessage(E_DEL_MSG)!);
  seed(
    { id: L_MSG, channelId: "2002", authorId: "u2", authorName: "bob", content: `retreat ${DRIVE_L}`, createdAt: 3_000 },
    3_000,
  );
  seed(
    {
      id: L_THREAD_MSG,
      channelId: L_THREAD_ID,
      parentChannelId: "2002",
      authorId: "u2",
      authorName: "bob",
      content: `seating ${DRIVE_T}`,
      createdAt: 3_500,
      threadId: L_THREAD_ID,
      threadName: "Retreat seating",
    },
    3_500,
  );
  seed(
    { id: PD_MSG, channelId: "4004", authorId: "u4", authorName: "dave", content: `signup ${FORM_PD}`, createdAt: 4_000 },
    4_000,
  );
});

afterAll(() => {
  resetChannelsForTest();
  clearWorkspaceTokenEnv();
  resetEnvForTest();
  db.cleanup();
  cwd.cleanup();
});

interface LinkOut {
  url: string;
  kind: string;
  fileId: string | null;
  messageId: string;
  channelId: string;
  parentChannelId: string | null;
  threadId: string | null;
  threadName: string | null;
  path: string;
  authorName: string;
  createdAt: number;
  firstSeenAt: number;
  permalink: string;
}

async function get(path: string, token?: string): Promise<Response> {
  return handleRequest(
    new Request(`http://127.0.0.1${path}`, {
      method: "GET",
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    }),
  );
}

async function links(qs: string, token: string): Promise<LinkOut[]> {
  const res = await get(`/v1/links${qs}`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { links: LinkOut[] }).links;
}

describe("GET /v1/links", () => {
  test("401 without token; bot token is not a bearer", async () => {
    expect((await get("/v1/links")).status).toBe(401);
    expect((await get("/v1/links", "test-token")).status).toBe(401);
  });

  test("includeDeleted is rejected", async () => {
    expect((await get("/v1/links?includeDeleted=true", EBOARD)).status).toBe(400);
  });

  test("eboard sees eboard + descendant links, never leadership", async () => {
    const out = await links("", EBOARD);
    const urls = out.map((l) => l.url);
    expect(urls).toContain(DOC_A);
    expect(urls).toContain(SHEET_E);
    expect(urls).toContain(FORM_PD);
    expect(urls).not.toContain(DRIVE_L);
    expect(urls).not.toContain(DRIVE_T);
    // newest first
    expect(out[0]!.url).toBe(FORM_PD);
    const a = out.find((l) => l.url === DOC_A)!;
    expect(a.path.startsWith("/eboard/")).toBe(true);
    expect(a.permalink).toContain(`/1001/${E_MSG}`);
    expect(a.kind).toBe("docs");
    expect(a.fileId).toBe("AAAAAAAAAAAAAAAAAAAA");
    expect(a.authorName).toBe("alice");
  });

  test("programs-dev sees only its own", async () => {
    expect((await links("", PD)).map((l) => l.url)).toEqual([FORM_PD]);
  });

  test("a thread link is returned for the parent's workspace", async () => {
    const out = await links("", LEADERSHIP);
    const t = out.find((l) => l.url === DRIVE_T);
    expect(t).toBeDefined();
    expect(t!.channelId).toBe(L_THREAD_ID);
    expect(t!.parentChannelId).toBe("2002");
    expect(t!.threadId).toBe(L_THREAD_ID);
    expect(t!.threadName).toBe("Retreat seating");
    expect(t!.path.startsWith("/leadership/")).toBe(true);
    // channel filter by name/id catches thread links under that parent
    expect((await links("?channel=leadership-team", LEADERSHIP)).map((l) => l.url)).toEqual([DRIVE_T, DRIVE_L]);
    expect((await links("?channel=2002", LEADERSHIP)).map((l) => l.url)).toEqual([DRIVE_T, DRIVE_L]);
    // out-of-scope channel resolves to nothing
    expect(await links("?channel=2002", EBOARD)).toEqual([]);
  });

  test("links on deleted messages are excluded", async () => {
    for (const tok of [EBOARD, LEADERSHIP]) {
      expect((await links("", tok)).map((l) => l.url)).not.toContain(SLIDES_DEL);
    }
  });

  test("kind filter and invalid kind", async () => {
    expect((await links("?kind=sheets", EBOARD)).map((l) => l.url)).toEqual([SHEET_E]);
    expect((await links("?kind=forms", EBOARD)).map((l) => l.url)).toEqual([FORM_PD]);
    expect((await get("/v1/links?kind=dropbox", EBOARD)).status).toBe(400);
  });

  test("since / until filter on first_seen_at", async () => {
    expect((await links("?since=4000", EBOARD)).map((l) => l.url)).toEqual([FORM_PD]);
    expect((await links("?until=1500", EBOARD)).map((l) => l.url)).toEqual([DOC_A_OLD]);
    expect((await get("/v1/links?since=abc", EBOARD)).status).toBe(400);
  });

  test("limit is clamped", async () => {
    expect((await links("?limit=1", EBOARD)).length).toBe(1);
    expect((await links("?limit=0", EBOARD)).length).toBe(1);
    expect((await links("?limit=999", EBOARD)).length).toBeLessThanOrEqual(100);
  });

  test("dedupe by file_id keeps the newest", async () => {
    const out = await links("", EBOARD);
    const a = out.filter((l) => l.fileId === "AAAAAAAAAAAAAAAAAAAA");
    expect(a.length).toBe(1);
    expect(a[0]!.url).toBe(DOC_A);
    expect(a[0]!.messageId).toBe(E_MSG);
  });
});
