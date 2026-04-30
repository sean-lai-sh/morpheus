import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import { getDisplayName, upsertUser } from "../src/storage/users.ts";

const t = withTempDb();
beforeAll(() => {});
afterAll(() => t.cleanup());

describe("storage/users — upsertUser", () => {
  test("inserts a new user row", () => {
    upsertUser("u1", "jen_xyz", "Jennifer", "jen", 1_000);
    expect(getDisplayName("u1")).toBe("Jennifer");
  });

  test("updates an existing user row on conflict", () => {
    upsertUser("u1", "jen_xyz", "Jen Chen", "jen", 2_000);
    expect(getDisplayName("u1")).toBe("Jen Chen");
  });

  test("returns null for unknown user", () => {
    expect(getDisplayName("no-such-user")).toBeNull();
  });
});

describe("storage/users — getDisplayName fallback priority", () => {
  test("prefers display_name over global_name and username", () => {
    upsertUser("u2", "ellieraw", "Ellie M", "ellie_global", 1_000);
    expect(getDisplayName("u2")).toBe("Ellie M");
  });

  test("falls back to global_name when display_name is null", () => {
    upsertUser("u3", "seanraw", null, "sean_global", 1_000);
    expect(getDisplayName("u3")).toBe("sean_global");
  });

  test("falls back to username when both display_name and global_name are null", () => {
    upsertUser("u4", "rawname", null, null, 1_000);
    expect(getDisplayName("u4")).toBe("rawname");
  });

  test("returns null when all name fields are null", () => {
    upsertUser("u5", null, null, null, 1_000);
    expect(getDisplayName("u5")).toBeNull();
  });
});
