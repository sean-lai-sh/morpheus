import { describe, expect, test } from "bun:test";
import { assertSiblingSecretsDistinct, parseSdkDispatcherEnv } from "../src/sdk-dispatcher/env.ts";

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

  test("MORPHEUS_BASE_URL: arbitrary internet hosts are refused for http AND https", () => {
    for (const url of [
      "http://example.com:8080",
      "https://example.com:8080",
      "https://evil.ts.net.attacker.com:8080",
    ]) {
      expect(() => parseSdkDispatcherEnv({ MORPHEUS_BASE_URL: url })).toThrow(/loopback, Tailscale/);
    }
  });

  test("MORPHEUS_BASE_URL: credentials, query, and fragments are refused", () => {
    for (const url of [
      "http://user:pw@127.0.0.1:8080",
      "http://token@127.0.0.1:8080",
      "http://127.0.0.1:8080/?x=1",
      "http://127.0.0.1:8080/#frag",
    ]) {
      expect(() => parseSdkDispatcherEnv({ MORPHEUS_BASE_URL: url })).toThrow(/credentials\/query\/fragment|loopback/);
    }
  });

  test("MORPHEUS_BASE_URL: loopback, Tailscale addresses, and *.ts.net pass", () => {
    for (const url of [
      "http://127.0.0.1:8080",
      "http://100.64.1.2:8080",
      "https://mini.tailnet-1234.ts.net:8080",
      "http://[fd7a:115c:a1e0::1]:8080",
    ]) {
      expect(parseSdkDispatcherEnv({ MORPHEUS_BASE_URL: url }).morpheusBaseUrl).toBe(url);
    }
  });

  test("rejects short webhook secrets", () => {
    expect(() => parseSdkDispatcherEnv({ CURSOR_SDK_WEBHOOK_SECRET: "short" })).toThrow(/16/);
  });
});

describe("assertSiblingSecretsDistinct", () => {
  const bearers = ["tok-eboard-0123456789", "tok-leadership-0123456789"];

  test("webhook secret or api key equal to a workspace bearer is fatal (values never in the message)", () => {
    expect(() =>
      assertSiblingSecretsDistinct({ apiKey: "cur_key_x", webhookSecret: bearers[0]! }, bearers),
    ).toThrow(/CURSOR_SDK_WEBHOOK_SECRET must not equal a workspace bearer/);
    expect(() =>
      assertSiblingSecretsDistinct({ apiKey: bearers[1]!, webhookSecret: "sibling-secret-0123456789" }, bearers),
    ).toThrow(/CURSOR_API_KEY must not equal a workspace bearer/);
    try {
      assertSiblingSecretsDistinct({ apiKey: "cur_key_x", webhookSecret: bearers[0]! }, bearers);
    } catch (err) {
      expect((err as Error).message).not.toContain(bearers[0]!);
    }
  });

  test("api key and webhook secret must be distinct from each other", () => {
    expect(() =>
      assertSiblingSecretsDistinct({ apiKey: "same-value-0123456789", webhookSecret: "same-value-0123456789" }, []),
    ).toThrow(/must be distinct/);
  });

  test("distinct secrets pass", () => {
    expect(() =>
      assertSiblingSecretsDistinct(
        { apiKey: "cur_key_x", webhookSecret: "sibling-secret-0123456789" },
        bearers,
      ),
    ).not.toThrow();
  });
});
