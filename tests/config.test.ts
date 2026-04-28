import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * config.ts caches loaded values in module-scoped state. To validate parsing
 * against multiple inputs we re-import via dynamic import + cache-busting query
 * isn't possible in Bun, so we exercise the schema by writing fixtures and
 * cd-ing into them. Each test runs in its own subdir.
 */
function setupFixture(yamlBody: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), "morpheus-cfg-"));
  mkdirSync(resolve(dir, "config"), { recursive: true });
  writeFileSync(resolve(dir, "config/channels.yml"), yamlBody, "utf8");
  return dir;
}

describe("config/channels.yml validation", () => {
  test("parses a valid file", async () => {
    const dir = setupFixture(`
channels:
  - id: "111111111111111111"
    name: "eboard"
    classify: true
defaults:
  confidence_threshold: 0.5
  reconcile_lookback: 200
  reconcile_interval_hours: 6
`);
    const original = process.cwd();
    process.chdir(dir);
    try {
      // Force a fresh module instance so the cached _channels is empty.
      const mod = await import(`../src/config.ts?cb=${Math.random()}`);
      const cfg = mod.loadChannels();
      expect(cfg.channels.length).toBe(1);
      expect(cfg.channels[0].classify).toBe(true);
    } finally {
      process.chdir(original);
    }
  });

  test("rejects empty channels list", async () => {
    const dir = setupFixture(`
channels: []
`);
    const original = process.cwd();
    process.chdir(dir);
    try {
      const mod = await import(`../src/config.ts?cb=${Math.random()}`);
      expect(() => mod.loadChannels()).toThrow();
    } finally {
      process.chdir(original);
    }
  });
});
