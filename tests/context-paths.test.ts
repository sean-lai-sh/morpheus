import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetChannelsForTest } from "../src/config.ts";
import { scopeFor } from "../src/context/namespace.ts";
import {
  constrainIndexPath,
  decodeEncodedPath,
  isForbiddenOsPath,
  parseIndexPath,
  pathPrefixMatches,
  posixNormalize,
  sanitizeIndexPath,
} from "../src/context/paths.ts";
import type { Scope } from "../src/context/types.ts";
import { withTempCwd, withTempDb, writeCanonicalChannels } from "./helpers.ts";

const cwd = withTempCwd();
writeCanonicalChannels();
const db = withTempDb();

let pd: Scope;
let eboard: Scope;
let leadership: Scope;

beforeAll(() => {
  resetChannelsForTest();
  pd = scopeFor("programs-dev")!;
  eboard = scopeFor("eboard")!;
  leadership = scopeFor("leadership")!;
});

afterAll(() => {
  resetChannelsForTest();
  db.cleanup();
  cwd.cleanup();
});

describe("decode then normalize", () => {
  test("percent-encoded .. is decoded to the death (single and double)", () => {
    expect(decodeEncodedPath("%2e%2e")).toBe("..");
    expect(decodeEncodedPath("%2E%2E")).toBe("..");
    expect(decodeEncodedPath("%252e%252e")).toBe("..");
    expect(sanitizeIndexPath("%2e%2e")).toBeNull();
    expect(sanitizeIndexPath("/programs-dev/%2e%2e/%2e%2e/Users/sean")).toBeNull();
    expect(sanitizeIndexPath("/programs-dev/%252e%252e/Users/sean")).toBeNull();
    expect(sanitizeIndexPath("/programs-dev%2f..%2f..%2fUsers/sean")).toBeNull();
  });

  test("posixNormalize resolves .. before any prefix check", () => {
    expect(posixNormalize("/programs-dev/../eboard")).toBe("/eboard");
    expect(posixNormalize("/eboard/a/b/../c")).toBe("/eboard/a/c");
    expect(posixNormalize("//Users/sean")).toBe("/Users/sean");
    expect(posixNormalize("/programs-dev/../..")).toBeNull();
  });
});

describe("constrainIndexPath: a narrow scope cannot climb the tree", () => {
  test("programs-dev cannot escape sideways or upward", () => {
    expect(constrainIndexPath("/programs-dev/../eboard", pd)).toBeNull();
    expect(constrainIndexPath("/programs-dev/%2e%2e/eboard", pd)).toBeNull();
    expect(constrainIndexPath("/programs-dev/%252e%252e/leadership", pd)).toBeNull();
    expect(constrainIndexPath("/programs-dev%2f..%2feboard", pd)).toBeNull();
    expect(constrainIndexPath("/eboard", pd)).toBeNull();
    expect(constrainIndexPath("/leadership", pd)).toBeNull();
    expect(constrainIndexPath("/programs-mentorship", pd)).toBeNull();
  });

  test("programs-dev keeps its own subtree", () => {
    expect(constrainIndexPath("/programs-dev", pd)).toBe("/programs-dev");
    expect(constrainIndexPath("/programs-dev/programs/dev-chat-4004", pd)).toBe(
      "/programs-dev/programs/dev-chat-4004",
    );
    expect(constrainIndexPath("/programs-dev/a/b/../c", pd)).toBe("/programs-dev/a/c");
  });

  test("eboard reaches descendants but not its parent", () => {
    expect(constrainIndexPath("/eboard", eboard)).toBe("/eboard");
    expect(constrainIndexPath("/programs-dev/programs/dev-chat-4004", eboard)).toBe(
      "/programs-dev/programs/dev-chat-4004",
    );
    expect(constrainIndexPath("/programs-mentorship", eboard)).toBe("/programs-mentorship");
    expect(constrainIndexPath("/leadership", eboard)).toBeNull();
    expect(constrainIndexPath("/leadership/eboard-teams/leadership-team-2002", eboard)).toBeNull();
    // `..` off a visible workspace normalizes into another VISIBLE workspace, so it
    // is allowed — the boundary is the resolved first segment, not the literal input.
    expect(constrainIndexPath("/eboard/../programs-dev/programs/dev-chat-4004", eboard)).toBe(
      "/programs-dev/programs/dev-chat-4004",
    );
    // The same trick aimed at a hidden workspace still fails.
    expect(constrainIndexPath("/eboard/../leadership", eboard)).toBeNull();
  });

  test("leadership sees the whole tree", () => {
    for (const p of ["/leadership", "/eboard", "/programs-dev", "/programs-mentorship"]) {
      expect(constrainIndexPath(p, leadership)).toBe(p);
    }
    expect(constrainIndexPath("/leadership/../programs-dev", leadership)).toBe("/programs-dev");
  });

  test("`/` is always allowed (the tree root lists only visible workspaces)", () => {
    expect(constrainIndexPath("/", pd)).toBe("/");
    expect(constrainIndexPath("/", eboard)).toBe("/");
    expect(constrainIndexPath("/", leadership)).toBe("/");
    expect(constrainIndexPath("", pd)).toBe("/");
  });
});

describe("OS and host paths are never index paths", () => {
  test("denylist runs after slash-collapse", () => {
    expect(isForbiddenOsPath("/Users/sean")).toBe(true);
    expect(sanitizeIndexPath("//Users/sean")).toBeNull();
    expect(sanitizeIndexPath("///Users/sean")).toBeNull();
    expect(constrainIndexPath("//Users/sean", leadership)).toBeNull();
  });

  test("rejects /Users, ~, drive letters and absolute host paths", () => {
    expect(isForbiddenOsPath("/users/sean")).toBe(true);
    expect(isForbiddenOsPath("~/src")).toBe(true);
    expect(isForbiddenOsPath("/home/sean")).toBe(true);
    expect(isForbiddenOsPath("/etc/passwd")).toBe(true);
    expect(isForbiddenOsPath("//nas/share")).toBe(true);
    expect(isForbiddenOsPath("C:\\Users\\sean")).toBe(true);
    expect(sanitizeIndexPath("/Users/sean")).toBeNull();
    expect(sanitizeIndexPath("~/src")).toBeNull();
    expect(sanitizeIndexPath("/etc/passwd")).toBeNull();
    expect(sanitizeIndexPath("/data/discord/eboard")).toBeNull();
    expect(sanitizeIndexPath("../")).toBeNull();
    expect(constrainIndexPath("/Users/sean", leadership)).toBeNull();
    expect(constrainIndexPath("~", leadership)).toBeNull();
    expect(parseIndexPath("/Users/sean")).toBeNull();
    expect(parseIndexPath("../")).toBeNull();
  });
});

describe("parseIndexPath: first segment must be a workspace", () => {
  test("pre-workspace namespace names no longer parse", () => {
    expect(parseIndexPath("/general")).toBeNull();
    expect(parseIndexPath("/general/eboard-teams")).toBeNull();
    expect(parseIndexPath("/_legacy")).toBeNull();
    expect(parseIndexPath("/_legacy/general-20260827")).toBeNull();
  });

  test("a category is not a workspace", () => {
    expect(parseIndexPath("/programs")).toBeNull();
    expect(parseIndexPath("/eboard-teams")).toBeNull();
  });

  test("real workspace paths parse", () => {
    expect(parseIndexPath("/")).toEqual({ kind: "root" });
    expect(parseIndexPath("/programs-dev")).toEqual({
      kind: "namespace",
      namespace: "programs-dev",
    });
    const cat = parseIndexPath("/programs-dev/programs");
    expect(cat?.kind).toBe("category");
    const ch = parseIndexPath("/programs-dev/programs/dev-chat-4004");
    expect(ch?.kind).toBe("channel");
    // Uncategorized channel sits directly under its workspace.
    expect(parseIndexPath("/eboard/general-chat-5005")?.kind).toBe("channel");
  });
});

describe("pathPrefixMatches", () => {
  test("`/` is a no-op prefix: every absolute index path matches", () => {
    expect(pathPrefixMatches("/eboard/eboard-teams/sponsors-1001/1", "/")).toBe(true);
    expect(pathPrefixMatches("/programs-dev", "/")).toBe(true);
    expect(pathPrefixMatches("/", "/")).toBe(true);
    expect(pathPrefixMatches("/eboard/general-chat-5005", "/eboard")).toBe(true);
    expect(pathPrefixMatches("/eboard", "/eboard")).toBe(true);
    expect(pathPrefixMatches("/eboard-other", "/eboard")).toBe(false);
  });
});
