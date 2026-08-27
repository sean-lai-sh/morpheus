import { describe, expect, test } from "bun:test";
import {
  JOB_ALLOWED_MENTIONS,
  allowlistedGithubIssueUrl,
  completeJobWithReply,
  postJobReply,
  splitDiscordContent,
} from "../src/bot/reply.ts";
import { withTempDb } from "./helpers.ts";
import { afterAll, beforeAll } from "bun:test";
import { claimJob, enqueueJob, getJob } from "../src/storage/jobs.ts";

const db = withTempDb();
beforeAll(() => {});
afterAll(() => db.cleanup());

describe("JOB_ALLOWED_MENTIONS", () => {
  test("parse/users/roles empty; repliedUser false (no substring @everyone scan)", () => {
    expect(JOB_ALLOWED_MENTIONS.parse).toEqual([]);
    expect(JOB_ALLOWED_MENTIONS.users).toEqual([]);
    expect(JOB_ALLOWED_MENTIONS.roles).toEqual([]);
    expect(JOB_ALLOWED_MENTIONS.repliedUser).toBe(false);
  });
});

describe("splitDiscordContent", () => {
  test("splits remainder over 2000", () => {
    const chunks = splitDiscordContent("a".repeat(2500));
    expect(chunks[0]?.length).toBe(2000);
    expect(chunks[1]?.length).toBe(500);
  });
});

describe("postJobReply", () => {
  test("message.reply uses allowedMentions.parse === []", async () => {
    const replyOpts: Array<{ allowedMentions?: { parse: unknown; users: unknown; roles: unknown; repliedUser?: boolean } }> =
      [];
    const stub = {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: {
            fetch: async () => ({
              reply: async (opts: (typeof replyOpts)[number]) => {
                replyOpts.push(opts);
                return { id: "r1" };
              },
            }),
          },
          send: async () => ({ id: "r2" }),
        }),
      },
    };
    const result = await postJobReply(
      { id: "job-1", discord_channel_id: "c1", discord_message_id: "m1" },
      "hello @everyone and <@&123>",
      { client: stub },
    );
    expect(result.messageId).toBe("r1");
    expect(replyOpts[0]?.allowedMentions?.parse).toEqual([]);
    expect(replyOpts[0]?.allowedMentions?.users).toEqual([]);
    expect(replyOpts[0]?.allowedMentions?.roles).toEqual([]);
    expect(replyOpts[0]?.allowedMentions?.repliedUser).toBe(false);
  });
});

describe("completeJobWithReply", () => {
  test("already-completed does not invoke Discord again", async () => {
    const { job } = enqueueJob({
      discordMessageId: "c-idemp",
      discordChannelId: "c1",
      discordThreadId: null,
      authorId: "u1",
      namespace: "general",
      content: "q",
    });
    claimJob(job.id, "w1");
    let replies = 0;
    const stub = {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: {
            fetch: async () => ({
              reply: async () => {
                replies += 1;
                return { id: "posted-1" };
              },
            }),
          },
          send: async () => ({ id: "posted-2" }),
        }),
      },
    };
    const first = await completeJobWithReply(job.id, "w1", { reply: "done" }, { client: stub });
    expect(first.ok).toBe(true);
    expect(first.posted).toBe(true);
    expect(replies).toBe(1);
    const second = await completeJobWithReply(job.id, "w1", { reply: "done again" }, { client: stub });
    expect(second.ok).toBe(true);
    expect(second.posted).toBe(false);
    expect(second.job?.result_discord_message_id).toBe("posted-1");
    expect(replies).toBe(1);
  });

  test("overlapping completes: second is in-progress and does not post", async () => {
    const { job } = enqueueJob({
      discordMessageId: "c-overlap",
      discordChannelId: "c1",
      discordThreadId: null,
      authorId: "u1",
      namespace: "general",
      content: "q",
    });
    claimJob(job.id, "w1");
    let replies = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: {
            fetch: async () => ({
              reply: async () => {
                replies += 1;
                await gate;
                return { id: "posted-overlap" };
              },
            }),
          },
          send: async () => ({ id: "posted-extra" }),
        }),
      },
    };
    const firstP = completeJobWithReply(job.id, "w1", { reply: "one", completion_key: "ck-o" }, { client: stub });
    const started = Date.now();
    while (!getJob(job.id)?.completion_key) {
      if (Date.now() - started > 2000) throw new Error("first complete never persisted completion_key");
      await Promise.resolve();
    }
    const second = await completeJobWithReply(job.id, "w1", { reply: "two", completion_key: "ck-o" }, { client: stub });
    expect(second.ok).toBe(false);
    expect(second.status).toBe(409);
    expect(second.error).toBe("in-progress");
    release();
    const first = await firstP;
    expect(first.ok).toBe(true);
    expect(first.posted).toBe(true);
    expect(replies).toBe(1);
  });

  test("partial multi-chunk send records first message id and retry does not re-post", async () => {
    const { job } = enqueueJob({
      discordMessageId: "c-partial",
      discordChannelId: "c1",
      discordThreadId: null,
      authorId: "u1",
      namespace: "general",
      content: "q",
    });
    claimJob(job.id, "w1");
    let replies = 0;
    let sends = 0;
    const stub = {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: {
            fetch: async () => ({
              reply: async () => {
                replies += 1;
                return { id: "first-chunk" };
              },
            }),
          },
          send: async () => {
            sends += 1;
            throw new Error("discord 5xx on follow-up");
          },
        }),
      },
    };
    const long = "a".repeat(2500);
    const first = await completeJobWithReply(job.id, "w1", { reply: long }, { client: stub });
    expect(first.ok).toBe(true);
    expect(first.job?.result_discord_message_id).toBe("first-chunk");
    expect(first.job?.status).toBe("completed");
    expect(replies).toBe(1);
    expect(sends).toBe(1);
    const second = await completeJobWithReply(job.id, "w1", { reply: long }, { client: stub });
    expect(second.ok).toBe(true);
    expect(second.posted).toBe(false);
    expect(replies).toBe(1);
    expect(sends).toBe(1);
  });
});

describe("allowlistedGithubIssueUrl", () => {
  test("rejects off-repo URLs", () => {
    expect(
      allowlistedGithubIssueUrl("https://github.com/evil/repo/issues/1", {
        repo: "sean-lai-sh/morpheus",
        namespace: "general",
      }),
    ).toBeNull();
  });

  test("drops leadership GitHub URLs by default", () => {
    expect(
      allowlistedGithubIssueUrl("https://github.com/sean-lai-sh/morpheus/issues/1", {
        repo: "sean-lai-sh/morpheus",
        namespace: "leadership",
        allowLeadershipGithub: false,
      }),
    ).toBeNull();
  });
});
