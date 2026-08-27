import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseChannelsConfig, resetChannelsForTest, visibleWorkspaces } from "../src/config.ts";
import { CANONICAL_CHANNELS_YML, writeCanonicalChannels } from "./helpers.ts";

/**
 * `parseChannelsConfig` takes a plain document, so most cases need no module
 * cache dance — only the `visibleWorkspaces` block (which reads the module-level
 * cache via `loadChannels`) writes a fixture to disk and cds into it.
 */
function parseYml(body: string): unknown {
  return parseYaml(body);
}

function parse(body: string) {
  return parseChannelsConfig(parseYml(body));
}

const VALID = `
workspaces:
  leadership: { token_env: MORPHEUS_API_TOKEN_LEADERSHIP }
  eboard: { parent: leadership, token_env: MORPHEUS_API_TOKEN_EBOARD }
channels:
  - { id: "1001", name: sponsors, category: eboard-teams, workspace: eboard }
`;

describe("config/channels.yml validation", () => {
  test("parses a valid file", () => {
    const cfg = parse(VALID);
    expect(cfg.channels.length).toBe(1);
    expect(cfg.channels[0]!.classify).toBe(true);
    expect(cfg.channels[0]!.workspace).toBe("eboard");
    expect(Object.keys(cfg.workspaces).sort()).toEqual(["eboard", "leadership"]);
    expect(cfg.workspaces.eboard!.parent).toBe("leadership");
  });

  test("parses the canonical fixture", () => {
    const cfg = parse(CANONICAL_CHANNELS_YML);
    expect(cfg.channels.map((c) => c.id)).toEqual(["1001", "2002", "3003", "4004", "5005"]);
    expect(Object.keys(cfg.workspaces).sort()).toEqual([
      "eboard",
      "leadership",
      "programs-dev",
      "programs-mentorship",
    ]);
    // Uncategorized channel keeps category undefined.
    expect(cfg.channels.find((c) => c.id === "5005")!.category).toBeUndefined();
  });

  test("rejects empty channels list", () => {
    expect(() =>
      parse(`
workspaces:
  eboard: {}
channels: []
`),
    ).toThrow();
  });

  test("rejects a missing workspaces block", () => {
    expect(() =>
      parse(`
channels:
  - { id: "1001", name: sponsors, workspace: eboard }
`),
    ).toThrow(/workspaces/);
  });

  test("legacy `isolated:` is a hard error", () => {
    expect(() =>
      parse(`
workspaces:
  eboard: {}
  leadership: {}
channels:
  - { id: "1001", name: sponsors, workspace: leadership, isolated: true }
`),
    ).toThrow(/isolated was removed/);
  });

  test("unknown channel workspace names the offending channel", () => {
    expect(() =>
      parse(`
workspaces:
  eboard: {}
channels:
  - { id: "1001", name: sponsors, workspace: nope }
`),
    ).toThrow(/channels\.0\.workspace/);
  });

  test("unknown parent workspace", () => {
    expect(() =>
      parse(`
workspaces:
  eboard: { parent: ghost }
channels:
  - { id: "1001", name: sponsors, workspace: eboard }
`),
    ).toThrow(/unknown parent/);
  });

  test("self-parent is a cycle", () => {
    expect(() =>
      parse(`
workspaces:
  eboard: { parent: eboard }
channels:
  - { id: "1001", name: sponsors, workspace: eboard }
`),
    ).toThrow(/cycle/);
  });

  test("three-workspace cycle a -> b -> c -> a", () => {
    expect(() =>
      parse(`
workspaces:
  a: { parent: b }
  b: { parent: c }
  c: { parent: a }
channels:
  - { id: "1001", name: sponsors, workspace: a }
`),
    ).toThrow(/cycle/);
  });

  test("duplicate token_env across workspaces", () => {
    expect(() =>
      parse(`
workspaces:
  leadership: { token_env: MORPHEUS_API_TOKEN_SHARED }
  eboard: { parent: leadership, token_env: MORPHEUS_API_TOKEN_SHARED }
channels:
  - { id: "1001", name: sponsors, workspace: eboard }
`),
    ).toThrow(/token_env must be unique/);
  });

  test("workspace id must be a single lowercase slug segment", () => {
    expect(() =>
      parse(`
workspaces:
  Programs_Dev: {}
channels:
  - { id: "1001", name: sponsors, workspace: Programs_Dev }
`),
    ).toThrow();
  });

  test("token_env must be UPPER_SNAKE", () => {
    expect(() =>
      parse(`
workspaces:
  eboard: { token_env: morpheus_api_token_eboard }
channels:
  - { id: "1001", name: sponsors, workspace: eboard }
`),
    ).toThrow(/UPPER_SNAKE|token_env/);
  });
});

describe("visibleWorkspaces", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "morpheus-cfg-"));
  writeCanonicalChannels(dir);

  function withCanonicalCwd<T>(fn: () => T): T {
    const original = process.cwd();
    process.chdir(dir);
    resetChannelsForTest();
    try {
      return fn();
    } finally {
      process.chdir(original);
      resetChannelsForTest();
    }
  }

  test("root sees itself plus every transitive descendant", () => {
    withCanonicalCwd(() => {
      expect([...visibleWorkspaces("leadership")].sort()).toEqual([
        "eboard",
        "leadership",
        "programs-dev",
        "programs-mentorship",
      ]);
      expect([...visibleWorkspaces("eboard")].sort()).toEqual([
        "eboard",
        "programs-dev",
        "programs-mentorship",
      ]);
      expect([...visibleWorkspaces("programs-dev")].sort()).toEqual(["programs-dev"]);
      // Unknown root gets no access at all — never a default workspace.
      expect([...visibleWorkspaces("nope")]).toEqual([]);
    });
  });
});
