import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import { DEV_CHAT, EBOARD, SPONSORS, withWorkspaceConfig } from "./jobs-fixture.ts";
import { countJobsSince, countOutstandingJobs, enqueueJob } from "../src/storage/jobs.ts";

const db = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;
beforeAll(() => {
  cfg = withWorkspaceConfig();
});
afterAll(() => {
  cfg.cleanup();
  db.cleanup?.();
});

function queue(
  id: string,
  channelId: string,
  lane: "interactive" | "background",
  authorId = "author-lane",
) {
  return enqueueJob({
    discordMessageId: id,
    discordChannelId: channelId,
    discordThreadId: null,
    authorId,
    namespace: EBOARD,
    scope: "channel",
    channelIds: [channelId],
    content: "hi",
    lane,
  });
}

describe("caps count the interactive (local SDK) lane only", () => {
  test("background jobs never consume an interactive outstanding slot", () => {
    queue("bg-1", SPONSORS, "background");
    queue("bg-2", SPONSORS, "background");
    queue("bg-3", SPONSORS, "background");

    // Three outstanding background jobs in this channel...
    expect(countOutstandingJobs("author-lane", SPONSORS, "background")).toBe(3);
    // ...and the interactive lane is still completely free.
    expect(countOutstandingJobs("author-lane", SPONSORS, "interactive")).toBe(0);
    // Unfiltered still sees everything, for callers that want the total.
    expect(countOutstandingJobs("author-lane", SPONSORS)).toBe(3);
  });

  test("interactive jobs are counted per channel within their own lane", () => {
    queue("ix-1", SPONSORS, "interactive");
    queue("ix-2", SPONSORS, "interactive");
    expect(countOutstandingJobs("author-lane", SPONSORS, "interactive")).toBe(2);
    // A different channel is unaffected.
    expect(countOutstandingJobs("author-lane", DEV_CHAT, "interactive")).toBe(0);
  });

  test("the hourly counter is lane-aware too", () => {
    const since = Date.now() - 3_600_000;
    const bg = countJobsSince("author-lane", since, "background");
    const ix = countJobsSince("author-lane", since, "interactive");
    expect(bg).toBe(3);
    expect(ix).toBe(2);
    // Unfiltered is the sum, so the old global behavior is intact.
    expect(countJobsSince("author-lane", since)).toBe(bg + ix);
  });

  test("lane defaults to interactive when unspecified", () => {
    enqueueJob({
      discordMessageId: "default-lane",
      discordChannelId: DEV_CHAT,
      discordThreadId: null,
      authorId: "author-default",
      namespace: EBOARD,
      scope: "channel",
      channelIds: [DEV_CHAT],
      content: "hi",
    });
    expect(countOutstandingJobs("author-default", DEV_CHAT, "interactive")).toBe(1);
  });
});
