import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadEnv, loadWorkspaceTokens, resetChannelsForTest, resetEnvForTest } from "../src/config.ts";
import { resolveListenHost } from "../src/http/listen-host.ts";
import {
  WORKSPACE_TOKENS,
  WORKSPACE_TOKEN_ENV,
  clearWorkspaceTokenEnv,
  setWorkspaceTokenEnv,
  writeCanonicalChannels,
} from "./helpers.ts";

const KEYS = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_TOKEN",
  "DISCORD_GUILD_ID",
  "HEALTH_HOST",
  ...Object.values(WORKSPACE_TOKEN_ENV),
] as const;
const saved: Record<string, string | undefined> = {};

function isolate(): void {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetEnvForTest();
}

function restore(): void {
  resetChannelsForTest();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvForTest();
}

afterEach(() => {
  restore();
});

describe("resolveListenHost", () => {
  test("HEALTH_HOST wins when set to a Tailscale address", () => {
    isolate();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env.HEALTH_HOST = "100.64.1.2";
    expect(loadEnv().HEALTH_HOST).toBe("100.64.1.2");
    expect(resolveListenHost()).toBe("100.64.1.2");
  });

  test("::1 is allowed", () => {
    isolate();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env.HEALTH_HOST = "::1";
    expect(resolveListenHost()).toBe("::1");
  });

  test("wildcard and LAN/WAN unicasts are refused", () => {
    isolate();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env.HEALTH_HOST = "0.0.0.0";
    expect(() => loadEnv()).toThrow(/loopback|Tailscale/);
    resetEnvForTest();
    process.env.HEALTH_HOST = "::0";
    expect(() => loadEnv()).toThrow(/loopback|Tailscale/);
    resetEnvForTest();
    process.env.HEALTH_HOST = "192.168.1.5";
    expect(() => loadEnv()).toThrow(/loopback|Tailscale/);
    resetEnvForTest();
    process.env.HEALTH_HOST = "8.8.8.8";
    expect(() => loadEnv()).toThrow(/loopback|Tailscale/);
  });

  test("unset HEALTH_HOST defaults to 127.0.0.1 and never 0.0.0.0", () => {
    isolate();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    expect(loadEnv().HEALTH_HOST).toBe("127.0.0.1");
    expect(resolveListenHost()).toBe("127.0.0.1");
  });

  test("scoped bearers come from channels.yml token_env, not a fixed env list", () => {
    isolate();
    clearWorkspaceTokenEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    setWorkspaceTokenEnv();

    const dir = mkdtempSync(resolve(tmpdir(), "morpheus-tokens-"));
    writeCanonicalChannels(dir);
    const original = process.cwd();
    process.chdir(dir);
    resetChannelsForTest();
    try {
      const tokens = loadWorkspaceTokens();
      expect(
        Object.fromEntries(tokens.map((t) => [t.workspace, t.token])),
      ).toEqual(WORKSPACE_TOKENS as unknown as Record<string, string>);
      expect(tokens.map((t) => t.envName).sort()).toEqual(Object.values(WORKSPACE_TOKEN_ENV).sort());
      expect(loadEnv().HEALTH_HOST).toBe("127.0.0.1");
    } finally {
      process.chdir(original);
      resetChannelsForTest();
      clearWorkspaceTokenEnv();
    }
  });

  test("a workspace whose token_env is unset simply has no HTTP access", () => {
    isolate();
    clearWorkspaceTokenEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env[WORKSPACE_TOKEN_ENV["programs-dev"]] = WORKSPACE_TOKENS["programs-dev"];

    const dir = mkdtempSync(resolve(tmpdir(), "morpheus-tokens-"));
    writeCanonicalChannels(dir);
    const original = process.cwd();
    process.chdir(dir);
    resetChannelsForTest();
    try {
      expect(loadWorkspaceTokens().map((t) => t.workspace)).toEqual(["programs-dev"]);
    } finally {
      process.chdir(original);
      resetChannelsForTest();
      clearWorkspaceTokenEnv();
    }
  });

  test("a scoped bearer may never equal the Discord bot token", () => {
    isolate();
    clearWorkspaceTokenEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token-0123456789";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env[WORKSPACE_TOKEN_ENV.eboard] = "bot-token-0123456789";

    const dir = mkdtempSync(resolve(tmpdir(), "morpheus-tokens-"));
    writeCanonicalChannels(dir);
    const original = process.cwd();
    process.chdir(dir);
    resetChannelsForTest();
    try {
      expect(() => loadWorkspaceTokens()).toThrow(/must not equal the Discord bot token/);
    } finally {
      process.chdir(original);
      resetChannelsForTest();
      clearWorkspaceTokenEnv();
    }
  });
});
