import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileEtag, parseByteRange, rawFilePathFor, readFileWindow } from "../src/context/files.ts";
import { discordDir } from "../src/storage/markdown.ts";
import { scopeFor } from "../src/context/namespace.ts";
import type { Scope } from "../src/context/types.ts";
import {
  EBOARD,
  LEADERSHIP_TEAM_PATH,
  SPONSORS_PATH,
  withWorkspaceConfig,
} from "./jobs-fixture.ts";

let fixture: ReturnType<typeof withWorkspaceConfig>;
beforeAll(() => {
  fixture = withWorkspaceConfig();
});
afterAll(() => {
  fixture.cleanup();
});

/**
 * Write an export file the way the crawler does — header, `---`, then blocks —
 * so window snapping has real boundaries to snap to.
 */
function writeExport(relDir: string, blocks: number): void {
  const dir = resolve(discordDir(), relDir);
  mkdirSync(dir, { recursive: true });
  const header = ["# #sponsors", "- channel_id: 1001", "- guild_id: 1", ""].join("\n");
  const body = Array.from(
    { length: blocks },
    (_, i) =>
      `## [2026-01-0${(i % 9) + 1} 00:00 UTC] @someone (msg:${1000 + i})\nmessage body number ${i} ${"x".repeat(60)}`,
  ).join("\n\n");
  writeFileSync(resolve(dir, "main.md"), `${header}\n---\n${body}\n`);
}

const SPONSORS_DIR = "eboard/eboard-teams/sponsors-1001";

describe("parseByteRange", () => {
  test("suffix form returns the newest bytes", () => {
    expect(parseByteRange("bytes=-500", 2_000)).toEqual({ start: 1_500, end: 1_999 });
  });

  test("suffix larger than the file clamps to the whole file", () => {
    expect(parseByteRange("bytes=-9999", 100)).toEqual({ start: 0, end: 99 });
  });

  test("open-ended and closed forms", () => {
    expect(parseByteRange("bytes=100-", 500)).toEqual({ start: 100, end: 499 });
    expect(parseByteRange("bytes=100-199", 500)).toEqual({ start: 100, end: 199 });
  });

  test("end past EOF clamps rather than failing", () => {
    expect(parseByteRange("bytes=400-9999", 500)).toEqual({ start: 400, end: 499 });
  });

  test("start past EOF is unsatisfiable", () => {
    expect(parseByteRange("bytes=500-", 500)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=-0", 500)).toBe("unsatisfiable");
  });

  test("absent or multi-range headers mean no range, not an error", () => {
    expect(parseByteRange(null, 500)).toBeNull();
    expect(parseByteRange("bytes=0-10,20-30", 500)).toBeNull();
    expect(parseByteRange("items=0-10", 500)).toBeNull();
  });
});

describe("rawFilePathFor", () => {
  test("resolves a channel path the scope can see", () => {
    writeExport(SPONSORS_DIR, 5);
    const ref = rawFilePathFor(SPONSORS_PATH, scopeFor(EBOARD)!);
    expect(ref).not.toBeNull();
    expect(ref!.absPath.endsWith("main.md")).toBe(true);
    expect(ref!.fileName).toBe("sponsors-1001.md");
    expect(ref!.size).toBeGreaterThan(0);
  });

  test("a workspace the scope cannot see is null, even though the file exists", () => {
    writeExport(SPONSORS_DIR, 5);
    // `eboard` never sees its ancestor `leadership`.
    expect(rawFilePathFor(LEADERSHIP_TEAM_PATH, scopeFor(EBOARD)!)).toBeNull();
    const narrow = { visible: new Set(["programs-dev"]) } as unknown as Scope;
    expect(rawFilePathFor(SPONSORS_PATH, narrow)).toBeNull();
  });

  test("directory-ish and traversal paths have no backing file", () => {
    const eboard = scopeFor(EBOARD)!;
    expect(rawFilePathFor("/", eboard)).toBeNull();
    expect(rawFilePathFor(`/${EBOARD}`, eboard)).toBeNull();
    expect(rawFilePathFor(`/${EBOARD}/eboard-teams`, eboard)).toBeNull();
    expect(rawFilePathFor("/eboard/../../etc/passwd", eboard)).toBeNull();
    expect(rawFilePathFor(`${SPONSORS_PATH}/../../../../etc/hosts`, eboard)).toBeNull();
  });

  test("a path with no written export is null, not a throw", () => {
    expect(rawFilePathFor(`/${EBOARD}/never-written-9999`, scopeFor(EBOARD)!)).toBeNull();
  });
});

describe("readFileWindow", () => {
  test("defaults to the newest bytes and flags that older content remains", () => {
    writeExport(SPONSORS_DIR, 200);
    const ref = rawFilePathFor(SPONSORS_PATH, scopeFor(EBOARD)!)!;
    const w = readFileWindow(ref, { bytes: 1_000 });

    expect(w.end).toBe(w.size);
    expect(w.hasOlder).toBe(true);
    // Newest block present, oldest absent — the recency fix.
    expect(w.body).toContain("message body number 199");
    expect(w.body).not.toContain("message body number 0 ");
    // Header rides along so a mid-file read still names its channel.
    expect(w.header).toContain("# #sponsors");
    // Snapped to a block boundary, never mid-message.
    expect(w.body.startsWith("## [")).toBe(true);
  });

  test("`before` pages backwards and eventually reaches the start of the file", () => {
    writeExport(SPONSORS_DIR, 200);
    const ref = rawFilePathFor(SPONSORS_PATH, scopeFor(EBOARD)!)!;

    const first = readFileWindow(ref, { bytes: 1_000 });
    const second = readFileWindow(ref, { bytes: 1_000, before: first.start });
    expect(second.end).toBe(first.start);
    expect(second.start).toBeLessThan(first.start);
    expect(second.body).not.toBe(first.body);

    let win = second;
    let guard = 0;
    while (win.hasOlder && guard++ < 500) {
      const next = readFileWindow(ref, { bytes: 1_000, before: win.start });
      if (next.start === win.start) break;
      win = next;
    }
    expect(win.hasOlder).toBe(false);
    expect(win.body).toContain("message body number 0 ");
  });

  test("a window larger than the file returns everything with no older content", () => {
    writeExport(SPONSORS_DIR, 3);
    const ref = rawFilePathFor(SPONSORS_PATH, scopeFor(EBOARD)!)!;
    const w = readFileWindow(ref, { bytes: 1_000_000 });
    expect(w.hasOlder).toBe(false);
    expect(w.body).toContain("message body number 0 ");
    expect(w.body).toContain("message body number 2");
  });
});

describe("fileEtag", () => {
  test("changes when size or mtime changes", () => {
    const a = fileEtag({ size: 100, mtimeMs: 1_000 });
    expect(a).toBe(fileEtag({ size: 100, mtimeMs: 1_000 }));
    expect(a).not.toBe(fileEtag({ size: 101, mtimeMs: 1_000 }));
    expect(a).not.toBe(fileEtag({ size: 100, mtimeMs: 2_000 }));
  });
});
