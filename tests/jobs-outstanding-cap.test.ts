import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import { DEV_CHAT, EBOARD, SPONSORS, withWorkspaceConfig } from "./jobs-fixture.ts";
import { countOutstandingJobs, enqueueJob } from "../src/storage/jobs.ts";

const db = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;
beforeAll(() => {
  cfg = withWorkspaceConfig();
});
afterAll(() => {
  cfg.cleanup();
  db.cleanup?.();
});

function queue(id: string, namespace: string, channelId: string) {
  return enqueueJob({
    discordMessageId: id,
    discordChannelId: channelId,
    discordThreadId: null,
    authorId: "author-1",
    namespace,
    scope: "channel",
    channelIds: [channelId],
    content: "hi",
  } as Parameters<typeof enqueueJob>[0]);
}

describe("outstanding cap is per channel", () => {
  test("jobs in one channel do not count against another channel", () => {
    queue("m1", EBOARD, SPONSORS);
    queue("m2", EBOARD, SPONSORS);

    // Two outstanding in SPONSORS...
    expect(countOutstandingJobs("author-1", SPONSORS)).toBe(2);
    // ...but DEV_CHAT is untouched, which is the whole point of the change.
    expect(countOutstandingJobs("author-1", DEV_CHAT)).toBe(0);
    // The global count still sees both (legacy callers).
    expect(countOutstandingJobs("author-1")).toBe(2);
  });

  test("a different author is counted separately", () => {
    expect(countOutstandingJobs("author-2", SPONSORS)).toBe(0);
  });
});
