import { afterEach, describe, expect, test } from "bun:test";
import { discordBotToken, loadEnv, resetEnvForTest } from "../src/config.ts";

const TOKEN_KEYS = ["DISCORD_BOT_TOKEN", "DISCORD_TOKEN", "DISCORD_GUILD_ID", "GROK_BOT_WEBHOOK_URL"] as const;
const saved: Record<string, string | undefined> = {};

function isolateEnv(): void {
  for (const k of TOKEN_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetEnvForTest();
}

function restoreEnv(): void {
  for (const k of TOKEN_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvForTest();
}

afterEach(() => {
  restoreEnv();
});

describe("discordBotToken", () => {
  test("accepts legacy DISCORD_TOKEN", () => {
    isolateEnv();
    process.env.DISCORD_TOKEN = "legacy-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    expect(discordBotToken(loadEnv())).toBe("legacy-token");
  });

  test("prefers DISCORD_BOT_TOKEN", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_TOKEN = "legacy-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    expect(discordBotToken(loadEnv())).toBe("bot-token");
  });
});

describe("GROK_BOT_WEBHOOK_URL", () => {
  test("optional — missing does not fail loadEnv", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    const env = loadEnv();
    expect(env.GROK_BOT_WEBHOOK_URL).toBeUndefined();
  });

  test("empty string is treated as unset", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env.GROK_BOT_WEBHOOK_URL = "";
    const env = loadEnv();
    expect(env.GROK_BOT_WEBHOOK_URL).toBeUndefined();
  });

  test("rejects http", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env.GROK_BOT_WEBHOOK_URL = "http://example.com/hook";
    expect(() => loadEnv()).toThrow(/https/);
  });
});
