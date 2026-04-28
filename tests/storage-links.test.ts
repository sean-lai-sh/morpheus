import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import { extractLinks, linksForMessage, persistLinks } from "../src/storage/links.ts";
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
