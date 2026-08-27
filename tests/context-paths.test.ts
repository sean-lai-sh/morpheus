import { describe, expect, test } from "bun:test";
import {
  constrainIndexPath,
  decodeEncodedPath,
  isForbiddenOsPath,
  posixNormalize,
  sanitizeIndexPath,
} from "../src/context/paths.ts";

describe("path traversal: decode then normalize then prefix-check", () => {
  test("rejects encoded .. (%2e%2e and double-encoded)", () => {
    expect(decodeEncodedPath("%2e%2e")).toBe("..");
    expect(decodeEncodedPath("%2E%2E")).toBe("..");
    expect(decodeEncodedPath("%252e%252e")).toBe("..");
    expect(sanitizeIndexPath("%2e%2e")).toBeNull();
    expect(sanitizeIndexPath("/general/%2e%2e/%2e%2e/Users/sean")).toBeNull();
    expect(sanitizeIndexPath("/general/%252e%252e/Users/sean")).toBeNull();
    expect(constrainIndexPath("/general/%2e%2e/leadership", "general")).toBeNull();
    expect(sanitizeIndexPath("/general%2f..%2f..%2fUsers/sean")).toBeNull();
  });

  test("normalize-then-prefix: /general/../leadership is not general", () => {
    expect(posixNormalize("/general/../leadership")).toBe("/leadership");
    expect(constrainIndexPath("/general/../leadership", "general")).toBeNull();
    expect(constrainIndexPath("/general/../leadership", "leadership")).toBe("/leadership");
    expect(constrainIndexPath("/general%2f..%2fleadership", "general")).toBeNull();
    expect(constrainIndexPath("/general/%2e%2e/leadership", "general")).toBeNull();
    expect(sanitizeIndexPath("/general%2f..%2f..%2fUsers/sean")).toBeNull();
  });

  test("normalize-then-prefix: ../../../Users escapes and is rejected", () => {
    expect(sanitizeIndexPath("/general/foo/../../../Users/sean")).toBeNull();
    expect(constrainIndexPath("/general/foo/../../../Users/sean", "general")).toBeNull();
    expect(posixNormalize("/general/a/b/../c")).toBe("/general/a/c");
    expect(constrainIndexPath("/general/a/b/../c", "general")).toBe("/general/a/c");
  });

  test("denylist runs after slash-collapse: //Users normalizes then rejects", () => {
    expect(posixNormalize("//Users/sean")).toBe("/Users/sean");
    expect(isForbiddenOsPath("/Users/sean")).toBe(true);
    expect(sanitizeIndexPath("//Users/sean")).toBeNull();
    expect(sanitizeIndexPath("///Users/sean")).toBeNull();
    expect(constrainIndexPath("//Users/sean", "general")).toBeNull();
  });

  test("rejects /Users, ~, and absolute host paths", () => {
    expect(isForbiddenOsPath("/Users/sean")).toBe(true);
    expect(isForbiddenOsPath("/users/sean")).toBe(true);
    expect(isForbiddenOsPath("~/src")).toBe(true);
    expect(isForbiddenOsPath("/home/sean")).toBe(true);
    expect(isForbiddenOsPath("/etc/passwd")).toBe(true);
    expect(isForbiddenOsPath("//nas/share")).toBe(true);
    expect(isForbiddenOsPath("C:\\Users\\sean")).toBe(true);
    expect(sanitizeIndexPath("/Users/sean")).toBeNull();
    expect(sanitizeIndexPath("~/src")).toBeNull();
    expect(sanitizeIndexPath("/etc/passwd")).toBeNull();
    expect(sanitizeIndexPath("/data/discord/general")).toBeNull();
    expect(sanitizeIndexPath("../")).toBeNull();
    expect(constrainIndexPath("/Users/sean", "general")).toBeNull();
    expect(constrainIndexPath("~", "general")).toBeNull();
  });

  test("allows index paths under the token namespace", () => {
    expect(constrainIndexPath("/general", "general")).toBe("/general");
    expect(constrainIndexPath("/general/eboard-teams", "general")).toBe("/general/eboard-teams");
    expect(constrainIndexPath("/", "general")).toBe("/");
    expect(constrainIndexPath("/leadership", "general")).toBeNull();
    expect(constrainIndexPath("/leadership", "leadership")).toBe("/leadership");
  });
});
