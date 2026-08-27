import { describe, expect, test } from "bun:test";
import { parseSdkDispatcherEnv } from "../src/sdk-dispatcher/env.ts";

describe("parseSdkDispatcherEnv", () => {
  test("refuses to start when the Discord bot token is present (product lock)", () => {
    expect(() => parseSdkDispatcherEnv({ DISCORD_BOT_TOKEN: "some-bot-token" })).toThrow(
      /must never hold the Discord bot token/,
    );
    expect(() => parseSdkDispatcherEnv({ DISCORD_TOKEN: "legacy-bot-token" })).toThrow(
      /must never hold the Discord bot token/,
    );
  });

  test("flag defaults to false; sane defaults everywhere else", () => {
    const env = parseSdkDispatcherEnv({});
    expect(env.enabled).toBe(false);
    expect(env.apiKey).toBeNull();
    expect(env.webhookSecret).toBeNull();
    expect(env.listenHost).toBe("127.0.0.1");
    expect(env.listenPort).toBe(8790);
    expect(env.model).toBe("composer-2.5");
    expect(env.morpheusBaseUrl).toBe("http://127.0.0.1:8080");
    expect(env.agentCwd).toBe(process.cwd());
  });

  test("parses a fully configured environment; trailing slash trimmed from base URL", () => {
    const env = parseSdkDispatcherEnv({
      CURSOR_SDK_DISPATCH: "true",
      CURSOR_API_KEY: "cur_test_key_value",
      CURSOR_SDK_WEBHOOK_SECRET: "sibling-secret-0123456789",
      CURSOR_SDK_LISTEN_HOST: "100.100.1.2",
      CURSOR_SDK_LISTEN_PORT: "9100",
      CURSOR_SDK_MODEL: "composer-2.5",
      CURSOR_SDK_CWD: "/srv/morpheus",
      MORPHEUS_BASE_URL: "https://mini.ts.net:8080/",
    });
    expect(env.enabled).toBe(true);
    expect(env.apiKey).toBe("cur_test_key_value");
    expect(env.webhookSecret).toBe("sibling-secret-0123456789");
    expect(env.listenHost).toBe("100.100.1.2");
    expect(env.listenPort).toBe(9100);
    expect(env.agentCwd).toBe("/srv/morpheus");
    expect(env.morpheusBaseUrl).toBe("https://mini.ts.net:8080");
  });

  test("rejects binding outside loopback/Tailscale", () => {
    expect(() => parseSdkDispatcherEnv({ CURSOR_SDK_LISTEN_HOST: "0.0.0.0" })).toThrow(/loopback/);
    expect(() => parseSdkDispatcherEnv({ CURSOR_SDK_LISTEN_HOST: "192.168.1.10" })).toThrow(/loopback/);
  });

  test("rejects plain-http MORPHEUS_BASE_URL off loopback/Tailscale", () => {
    expect(() => parseSdkDispatcherEnv({ MORPHEUS_BASE_URL: "http://example.com:8080" })).toThrow(
      /loopback\/Tailscale/,
    );
  });

  test("rejects short webhook secrets", () => {
    expect(() => parseSdkDispatcherEnv({ CURSOR_SDK_WEBHOOK_SECRET: "short" })).toThrow(/16/);
  });
});
