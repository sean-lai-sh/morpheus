import { afterEach, describe, expect, test } from "bun:test";
import { loadEnv, resetEnvForTest } from "../src/config.ts";
import { resolveListenHost } from "../src/http/listen-host.ts";

const KEYS = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_TOKEN",
  "DISCORD_GUILD_ID",
  "HEALTH_HOST",
  "MORPHEUS_API_TOKEN_GENERAL",
  "MORPHEUS_API_TOKEN_LEADERSHIP",
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

  test("MORPHEUS_API_TOKEN_* are consumed via loadEnv/zod", () => {
    isolate();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env.MORPHEUS_API_TOKEN_GENERAL = "tok-g";
    process.env.MORPHEUS_API_TOKEN_LEADERSHIP = "tok-l";
    const env = loadEnv();
    expect(env.MORPHEUS_API_TOKEN_GENERAL).toBe("tok-g");
    expect(env.MORPHEUS_API_TOKEN_LEADERSHIP).toBe("tok-l");
    expect(env.HEALTH_HOST).toBe("127.0.0.1");
  });
});
