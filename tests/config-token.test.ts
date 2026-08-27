import { afterEach, describe, expect, test } from "bun:test";
import {
  discordBotToken,
  httpBindHostname,
  jobTriggerRoleIds,
  loadEnv,
  loadWorkspaceTokens,
  resetEnvForTest,
} from "../src/config.ts";
import { EBOARD_TOKEN, LEADERSHIP_TOKEN, withWorkspaceConfig } from "./jobs-fixture.ts";

const TOKEN_KEYS = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_TOKEN",
  "DISCORD_GUILD_ID",
  "GROK_BOT_WEBHOOK_URL",
  "GROK_BOT_WEBHOOK_SECRET",
  "GROK_DISPATCH_WORKSPACES",
  "GITHUB_ISSUES_WORKSPACES",
  "HEALTH_HOST",
  "JOB_TRIGGER_ROLE_IDS",
] as const;
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

  test("rejects :1340 gateway URLs", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env.GROK_BOT_WEBHOOK_URL = "https://example.com:1340/hook";
    expect(() => loadEnv()).toThrow(/1340/);
  });

  test("rejects Discord incoming webhook URLs", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env.GROK_BOT_WEBHOOK_URL = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwx";
    expect(() => loadEnv()).toThrow(/webhook/i);
  });

  test("GROK_BOT_WEBHOOK_SECRET empty is unset (optional)", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env.GROK_BOT_WEBHOOK_SECRET = "";
    const env = loadEnv();
    expect(env.GROK_BOT_WEBHOOK_SECRET).toBeUndefined();
  });
});

describe("HEALTH_HOST", () => {
  test("defaults to 127.0.0.1", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    expect(loadEnv().HEALTH_HOST).toBe("127.0.0.1");
  });

  test("rejects 0.0.0.0", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env.HEALTH_HOST = "0.0.0.0";
    expect(() => loadEnv()).toThrow(/loopback|Tailscale/);
  });

  test("rejects LAN unicast", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env.HEALTH_HOST = "192.168.1.5";
    expect(() => loadEnv()).toThrow(/loopback|Tailscale/);
  });

  test("blank HEALTH_HOST binds loopback", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    expect(httpBindHostname(loadEnv())).toBe("127.0.0.1");
  });
});

describe("job roles", () => {
  test("empty JOB_TRIGGER_ROLE_IDS is an empty set (fail closed)", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env.JOB_TRIGGER_ROLE_IDS = "";
    expect(jobTriggerRoleIds(loadEnv()).size).toBe(0);
  });

  test("GROK_DISPATCH_WORKSPACES defaults to [] (default deny)", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    expect(loadEnv().GROK_DISPATCH_WORKSPACES).toEqual([]);
  });

  test("GROK_DISPATCH_WORKSPACES parses a comma list", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env.GROK_DISPATCH_WORKSPACES = "eboard, programs-dev";
    expect(loadEnv().GROK_DISPATCH_WORKSPACES).toEqual(["eboard", "programs-dev"]);
  });

  test("empty GROK_DISPATCH_WORKSPACES is an empty list", () => {
    isolateEnv();
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    process.env.DISCORD_GUILD_ID = "123456789012345678";
    process.env.GROK_DISPATCH_WORKSPACES = "";
    expect(loadEnv().GROK_DISPATCH_WORKSPACES).toEqual([]);
  });
});

describe("loadWorkspaceTokens", () => {
  let cfg: ReturnType<typeof withWorkspaceConfig> | undefined;

  function withConfig(): void {
    cfg = withWorkspaceConfig({ tokens: false });
  }

  afterEach(() => {
    cfg?.cleanup();
    cfg = undefined;
  });

  function baseEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      DISCORD_BOT_TOKEN: "discord-bot-token-value",
      DISCORD_GUILD_ID: "123456789012345678",
      ...over,
    };
  }

  test("one entry per declared-and-set token_env; unset workspaces are skipped", () => {
    withConfig();
    const tokens = loadWorkspaceTokens(
      baseEnv({
        MORPHEUS_API_TOKEN_LEADERSHIP: LEADERSHIP_TOKEN,
        MORPHEUS_API_TOKEN_EBOARD: EBOARD_TOKEN,
      }),
    );
    expect(tokens.map((t) => t.workspace).sort()).toEqual(["eboard", "leadership"]);
    expect(tokens.find((t) => t.workspace === "eboard")?.envName).toBe("MORPHEUS_API_TOKEN_EBOARD");
  });

  test("duplicate token values are refused", () => {
    withConfig();
    const same = "same-token-for-both-aaaaaaaa";
    expect(() =>
      loadWorkspaceTokens(
        baseEnv({
          MORPHEUS_API_TOKEN_LEADERSHIP: same,
          MORPHEUS_API_TOKEN_EBOARD: same,
        }),
      ),
    ).toThrow(/distinct/);
  });

  test("a token equal to DISCORD_BOT_TOKEN is refused", () => {
    withConfig();
    const bot = "discord-bot-token-value";
    expect(() => loadWorkspaceTokens(baseEnv({ MORPHEUS_API_TOKEN_EBOARD: bot }))).toThrow(
      /bot token/,
    );
  });

  test("a token shorter than 16 chars is refused", () => {
    withConfig();
    expect(() => loadWorkspaceTokens(baseEnv({ MORPHEUS_API_TOKEN_EBOARD: "too-short" }))).toThrow(
      /16/,
    );
  });
});
