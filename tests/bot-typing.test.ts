import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { parseEnv } from "../src/config.ts";
import {
  isJobTypingActive,
  jobTypingChannelId,
  startJobTyping,
  stopAllJobTyping,
  stopJobTyping,
  type TypingScheduler,
} from "../src/bot/typing.ts";
import { completeJobWithReply, failJobAsWorker } from "../src/bot/reply.ts";
import { claimJob, enqueueJob } from "../src/storage/jobs.ts";
import { withTempDb } from "./helpers.ts";
import { EBOARD, SPONSORS, withWorkspaceConfig } from "./jobs-fixture.ts";

const db = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;
beforeAll(() => {
  cfg = withWorkspaceConfig();
});
afterEach(() => {
  stopAllJobTyping();
});
afterAll(() => {
  cfg.cleanup();
  db.cleanup();
});

function envFor(over: Record<string, string | undefined> = {}) {
  return parseEnv({
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN ?? "test-token",
    DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID ?? "987654321098765432",
    ...over,
  });
}

function manualScheduler() {
  const fns = new Map<unknown, () => void>();
  let n = 0;
  const scheduler: TypingScheduler = {
    interval(fn) {
      const id = ++n;
      fns.set(id, fn);
      return id;
    },
    clear(id) {
      fns.delete(id);
    },
  };
  return {
    scheduler,
    async tick() {
      for (const fn of [...fns.values()]) fn();
      await Promise.resolve();
      await Promise.resolve();
    },
    pending() {
      return fns.size;
    },
  };
}

describe("jobTypingChannelId", () => {
  test("uses discord_channel_id when there is no thread", () => {
    expect(
      jobTypingChannelId({ discord_channel_id: "111111111111111111", discord_thread_id: null }),
    ).toBe("111111111111111111");
  });

  test("prefers thread id when the payload has one", () => {
    expect(
      jobTypingChannelId({
        discord_channel_id: "111111111111111111",
        discord_thread_id: "999999999999999999",
      }),
    ).toBe("999999999999999999");
  });
});

describe("startJobTyping", () => {
  test("flag off → no sendTyping", async () => {
    const typed: string[] = [];
    const r = await startJobTyping(
      { id: "t-off", discord_channel_id: "111111111111111111" },
      {
        env: envFor({ DISCORD_TYPING_ON_DISPATCH: "false" }),
        sendTyping: async (id) => {
          typed.push(id);
        },
        isFinished: () => false,
      },
    );
    expect(r.started).toBe(false);
    expect(r.skipped).toBe("disabled");
    expect(typed).toEqual([]);
  });

  test("pulses the job channel immediately, not an unrelated id", async () => {
    const typed: string[] = [];
    const clock = manualScheduler();
    const r = await startJobTyping(
      { id: "t-ch", discord_channel_id: "111111111111111111", discord_thread_id: null },
      {
        env: envFor(),
        sendTyping: async (id) => {
          typed.push(id);
        },
        scheduler: clock.scheduler,
        isFinished: () => false,
        maxMs: 60_000,
      },
    );
    expect(r.started).toBe(true);
    expect(r.channelId).toBe("111111111111111111");
    expect(typed).toEqual(["111111111111111111"]);
    expect(isJobTypingActive("t-ch")).toBe(true);
    await clock.tick();
    expect(typed).toEqual(["111111111111111111", "111111111111111111"]);
  });

  test("thread jobs type in the thread, never the parent", async () => {
    const typed: string[] = [];
    const clock = manualScheduler();
    const r = await startJobTyping(
      {
        id: "t-thread",
        discord_channel_id: "999999999999999999",
        discord_thread_id: "999999999999999999",
      },
      {
        env: envFor(),
        sendTyping: async (id) => {
          typed.push(id);
        },
        scheduler: clock.scheduler,
        isFinished: () => false,
      },
    );
    expect(r.started).toBe(true);
    expect(typed).toEqual(["999999999999999999"]);
  });

  test("stopJobTyping prevents further pulses", async () => {
    const typed: string[] = [];
    const clock = manualScheduler();
    await startJobTyping(
      { id: "t-stop", discord_channel_id: "111111111111111111" },
      {
        env: envFor(),
        sendTyping: async (id) => {
          typed.push(id);
        },
        scheduler: clock.scheduler,
        isFinished: () => false,
      },
    );
    stopJobTyping("t-stop", clock.scheduler);
    expect(isJobTypingActive("t-stop")).toBe(false);
    await clock.tick();
    expect(typed).toEqual(["111111111111111111"]);
  });

  test("deadline stops the loop without another pulse", async () => {
    const typed: string[] = [];
    const clock = manualScheduler();
    let t = 1_000;
    await startJobTyping(
      { id: "t-max", discord_channel_id: "111111111111111111" },
      {
        env: envFor(),
        sendTyping: async (id) => {
          typed.push(id);
        },
        scheduler: clock.scheduler,
        isFinished: () => false,
        nowFn: () => t,
        maxMs: 5_000,
      },
    );
    expect(typed.length).toBe(1);
    t = 10_000;
    await clock.tick();
    expect(isJobTypingActive("t-max")).toBe(false);
    expect(typed.length).toBe(1);
  });

  test("client-missing skips when no sendTyping inject", async () => {
    const r = await startJobTyping(
      { id: "t-noclient", discord_channel_id: "111111111111111111" },
      { env: envFor(), isFinished: () => false },
    );
    expect(r.started).toBe(false);
    expect(r.skipped).toBe("client-missing");
  });

  test("official client sendTyping is used when injected as channels.fetch", async () => {
    const typed: string[] = [];
    const client = {
      channels: {
        fetch: async (id: string) => ({
          isTextBased: () => true,
          sendTyping: async () => {
            typed.push(id);
          },
        }),
      },
    };
    const clock = manualScheduler();
    const r = await startJobTyping(
      { id: "t-client", discord_channel_id: "111111111111111111" },
      {
        env: envFor(),
        client,
        scheduler: clock.scheduler,
        isFinished: () => false,
      },
    );
    expect(r.started).toBe(true);
    expect(typed).toEqual(["111111111111111111"]);
  });
});

describe("typing vs job complete/fail", () => {
  test("completeJobWithReply stops the loop so a later tick does not type", async () => {
    const { job } = enqueueJob({
      discordMessageId: "t-complete",
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "u1",
      namespace: EBOARD,
      content: "q",
    });
    claimJob(job.id, "w1");
    const typed: string[] = [];
    const clock = manualScheduler();
    await startJobTyping(job, {
      env: envFor(),
      sendTyping: async (id) => {
        typed.push(id);
      },
      scheduler: clock.scheduler,
    });
    expect(isJobTypingActive(job.id)).toBe(true);
    const stub = {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: {
            fetch: async () => ({
              reply: async () => ({ id: "r-typed" }),
            }),
          },
          send: async () => ({ id: "r2" }),
        }),
      },
    };
    const done = await completeJobWithReply(job.id, "w1", { reply: "hello" }, { client: stub });
    expect(done.ok).toBe(true);
    expect(isJobTypingActive(job.id)).toBe(false);
    await clock.tick();
    expect(typed).toEqual([SPONSORS]);
  });

  test("failJobAsWorker stops typing", async () => {
    const { job } = enqueueJob({
      discordMessageId: "t-fail",
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "u1",
      namespace: EBOARD,
      content: "q",
    });
    claimJob(job.id, "w1");
    const clock = manualScheduler();
    await startJobTyping(job, {
      env: envFor(),
      sendTyping: async () => {},
      scheduler: clock.scheduler,
    });
    expect(isJobTypingActive(job.id)).toBe(true);
    const failed = failJobAsWorker(job.id, "w1", "boom");
    expect(failed.ok).toBe(true);
    expect(isJobTypingActive(job.id)).toBe(false);
  });

  test("a failed Discord send leaves typing running so the retry still shows it", async () => {
    const { job } = enqueueJob({
      discordMessageId: "t-send-error",
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "u1",
      namespace: EBOARD,
      content: "q",
    });
    claimJob(job.id, "w1");
    const clock = manualScheduler();
    await startJobTyping(job, {
      env: envFor(),
      sendTyping: async () => {},
      scheduler: clock.scheduler,
    });
    const throwing = {
      channels: {
        fetch: async () => {
          throw new Error("discord down");
        },
      },
    };
    const res = await completeJobWithReply(job.id, "w1", { reply: "hello" }, {
      client: throwing,
      postReplies: true,
    });
    expect(res.ok).toBe(false);
    // markJobSendError keeps the job claimed for a retry — the indicator must survive it.
    expect(isJobTypingActive(job.id)).toBe(true);
  });

  test("missing Discord client leaves typing running", async () => {
    const { job } = enqueueJob({
      discordMessageId: "t-no-client",
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "u1",
      namespace: EBOARD,
      content: "q",
    });
    claimJob(job.id, "w1");
    const clock = manualScheduler();
    await startJobTyping(job, {
      env: envFor(),
      sendTyping: async () => {},
      scheduler: clock.scheduler,
    });
    const res = await completeJobWithReply(job.id, "w1", { reply: "hello" }, { postReplies: true });
    expect(res.status).toBe(503);
    expect(isJobTypingActive(job.id)).toBe(true);
  });

  test("complete with empty reply does not stop typing (job still claimed)", async () => {
    const { job } = enqueueJob({
      discordMessageId: "t-empty",
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "u1",
      namespace: EBOARD,
      content: "q",
    });
    claimJob(job.id, "w1");
    const clock = manualScheduler();
    await startJobTyping(job, {
      env: envFor(),
      sendTyping: async () => {},
      scheduler: clock.scheduler,
    });
    const bad = await completeJobWithReply(job.id, "w1", { reply: "" });
    expect(bad.ok).toBe(false);
    expect(isJobTypingActive(job.id)).toBe(true);
  });
});
