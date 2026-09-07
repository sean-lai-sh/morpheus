import { afterAll, describe, expect, test } from "bun:test";
import { Events } from "discord.js";
import { getClient, shutdownClient } from "../src/bot/client.ts";

describe("bot/client", () => {
  afterAll(async () => {
    await shutdownClient();
  });

  test("listens for Events.ClientReady, not the deprecated ready string", () => {
    const client = getClient();
    expect(client.listenerCount(Events.ClientReady)).toBeGreaterThan(0);
  });
});
