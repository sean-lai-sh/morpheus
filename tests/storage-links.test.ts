import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import { extractLinks, linksForMessage, persistLinks, queryLinks } from "../src/storage/links.ts";
import { getDb } from "../src/storage/db.ts";
import { upsertMessage } from "../src/storage/messages.ts";

const t = withTempDb();
beforeAll(() => {});
afterAll(() => t.cleanup());

describe("storage/links: extraction", () => {
  test("extracts a docs.google.com URL with file id", () => {
    const links = extractLinks(
      "agenda is at https://docs.google.com/document/d/abc123def456ghi/edit",
    );
    expect(links.length).toBe(1);
    expect(links[0]?.kind).toBe("docs");
    expect(links[0]?.fileId).toBe("abc123def456ghi");
  });

  test("extracts multiple kinds in one message", () => {
    const links = extractLinks(
      "see https://drive.google.com/file/d/AAAAAAAAAAAAAAAAAAAA/view and https://forms.google.com/forms/d/BBBBBBBBBBBBBBBBBBBB/edit",
    );
    expect(links.map((l) => l.kind).sort()).toEqual(["drive", "forms"]);
  });

  test("classifies canonical docs.google.com paths by product", () => {
    const sheet = extractLinks("https://docs.google.com/spreadsheets/d/SSSSSSSSSSSSSSSSSSSS/edit#gid=0");
    expect(sheet[0]?.kind).toBe("sheets");
    expect(sheet[0]?.fileId).toBe("SSSSSSSSSSSSSSSSSSSS");
    const slides = extractLinks("https://docs.google.com/presentation/d/PPPPPPPPPPPPPPPPPPPP/edit");
    expect(slides[0]?.kind).toBe("slides");
    const form = extractLinks("https://docs.google.com/forms/d/FFFFFFFFFFFFFFFFFFFF/viewform");
    expect(form[0]?.kind).toBe("forms");
    const doc = extractLinks("https://docs.google.com/document/d/DDDDDDDDDDDDDDDDDDDD/edit");
    expect(doc[0]?.kind).toBe("docs");
    // drive.google.com never gets path-refined
    const drive = extractLinks("https://drive.google.com/file/d/LLLLLLLLLLLLLLLLLLLL/view");
    expect(drive[0]?.kind).toBe("drive");
  });

  test("ignores non-google URLs", () => {
    expect(extractLinks("see https://example.com/foo")).toEqual([]);
  });

  test("strips trailing punctuation", () => {
    const links = extractLinks(
      "see https://docs.google.com/document/d/abc123def456ghi/edit, please",
    );
    expect(links[0]?.url.endsWith(",")).toBe(false);
  });

  test("dedupes within a single message", () => {
    const url = "https://docs.google.com/document/d/abc123def456ghi/edit";
    const links = extractLinks(`${url} and also ${url}`);
    expect(links.length).toBe(1);
  });

  test("extracts ?id= form for drive open URLs", () => {
    const links = extractLinks("https://drive.google.com/open?id=ABCDEFGHIJKLMNOPQRST");
    expect(links[0]?.fileId).toBe("ABCDEFGHIJKLMNOPQRST");
  });

  test("returns null fileId for short ids", () => {
    const links = extractLinks("https://drive.google.com/file/d/short9/view");
    expect(links[0]?.fileId).toBeNull();
  });
});

describe("storage/links: persistence", () => {
  test("persistLinks is idempotent on (message_id, url)", () => {
    upsertMessage({
      id: "L1",
      channelId: "c1",
      authorId: "u1",
      authorName: "alice",
      content: "ignored",
      createdAt: 1_000,
    });
    const url = "https://docs.google.com/document/d/AAAAAAAAAAAAAAAAAAAA/edit";
    const links = extractLinks(url);
    persistLinks("L1", "c1", links, 1_000);
    persistLinks("L1", "c1", links, 1_000); // second call should not duplicate
    expect(linksForMessage("L1").length).toBe(1);
  });
});

describe("storage/links: queryLinks", () => {
  test("legacy rows stored as kind=docs are normalized by url at query time", () => {
    upsertMessage({
      id: "L2",
      channelId: "c2",
      authorId: "u1",
      authorName: "alice",
      content: "ignored",
      createdAt: 2_000,
    });
    const url = "https://docs.google.com/spreadsheets/d/LEGACYLEGACYLEGACY01/edit";
    // Simulate a row persisted before path-based classification.
    persistLinks("L2", "c2", [{ url, kind: "docs", fileId: "LEGACYLEGACYLEGACY01" }], 2_000);
    expect(linksForMessage("L2")[0]?.kind).toBe("docs");
    const sheets = queryLinks({ channelIds: ["c2"], kind: "sheets", limit: 10 });
    expect(sheets.map((l) => l.url)).toEqual([url]);
    expect(sheets[0]?.kind).toBe("sheets");
    expect(queryLinks({ channelIds: ["c2"], kind: "docs", limit: 10 })).toEqual([]);
  });

  test("dedupes by file_id before applying limit", () => {
    const shared = "https://docs.google.com/document/d/SHAREDSHAREDSHARED01/edit";
    const sharedLinks = extractLinks(shared);
    // 5 older unique files
    for (let i = 0; i < 5; i++) {
      const id = `U${i}`;
      const url = `https://drive.google.com/file/d/UNIQUEUNIQUEUNIQUE0${i}/view`;
      upsertMessage({ id, channelId: "c3", authorId: "u1", authorName: "alice", content: url, createdAt: 100 + i });
      persistLinks(id, "c3", extractLinks(url), 100 + i);
    }
    // 200+ newer messages resharing one file
    const db = getDb();
    db.transaction(() => {
      for (let i = 0; i < 220; i++) {
        const id = `S${i}`;
        upsertMessage({ id, channelId: "c3", authorId: "u1", authorName: "alice", content: shared, createdAt: 10_000 + i });
        persistLinks(id, "c3", sharedLinks, 10_000 + i);
      }
    })();
    const out = queryLinks({ channelIds: ["c3"], limit: 10 });
    expect(out.length).toBe(6);
    expect(out[0]?.message_id).toBe("S219");
    expect(out.filter((l) => l.file_id === "SHAREDSHAREDSHARED01").length).toBe(1);
    expect(out.slice(1).map((l) => l.message_id)).toEqual(["U4", "U3", "U2", "U1", "U0"]);
  });
});
