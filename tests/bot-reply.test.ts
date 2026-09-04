import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  JOB_ALLOWED_MENTIONS,
  allowlistedGithubIssueUrl,
  completeJobWithReply,
  ephemeralSlashAckMessageId,
  isUnknownDiscordMessageError,
  postJobReply,
  shouldAnnounceInChannel,
  splitDiscordContent,
} from "../src/bot/reply.ts";
import { withTempDb } from "./helpers.ts";
import { EBOARD, LEADERSHIP, SPONSORS, withWorkspaceConfig } from "./jobs-fixture.ts";
import { claimJob, enqueueJob, getJob } from "../src/storage/jobs.ts";
import { resetEnvForTest } from "../src/config.ts";

const db = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;
beforeAll(() => {
  cfg = withWorkspaceConfig();
});
afterAll(() => {
  cfg.cleanup();
  db.cleanup();
});

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
  test("fail closed: unloadable workspace tokens block the reply from reaching Discord", async () => {
    const { job } = enqueueJob({
      discordMessageId: "c-failclosed",
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "u1",
      namespace: EBOARD,
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
                return { id: "leaked-1" };
              },
            }),
          },
          send: async () => ({ id: "leaked-2" }),
        }),
      },
    };
    // Two workspaces sharing one bearer makes loadWorkspaceTokens() throw, so
    // the redaction list cannot be built. The reply may contain those bearers.
    const savedEboard = process.env.MORPHEUS_API_TOKEN_EBOARD;
    process.env.MORPHEUS_API_TOKEN_EBOARD = process.env.MORPHEUS_API_TOKEN_LEADERSHIP;
    resetEnvForTest();
    try {
      const result = await completeJobWithReply(
        job.id,
        "w1",
        { reply: `token is ${process.env.MORPHEUS_API_TOKEN_LEADERSHIP}` },
        { client: stub },
      );
      expect(result.ok).toBe(false);
      expect(result.status).toBe(500);
      expect(result.error).toBe("secret-redaction-unavailable");
      expect(replies).toBe(0);
      expect(getJob(job.id)?.status).toBe("claimed");
    } finally {
      if (savedEboard === undefined) delete process.env.MORPHEUS_API_TOKEN_EBOARD;
      else process.env.MORPHEUS_API_TOKEN_EBOARD = savedEboard;
      resetEnvForTest();
    }
  });

  test("already-completed does not invoke Discord again", async () => {
    const { job } = enqueueJob({
      discordMessageId: "c-idemp",
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "u1",
      namespace: EBOARD,
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
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "u1",
      namespace: EBOARD,
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
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "u1",
      namespace: EBOARD,
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

  test("redacts Mini secrets before message.reply", async () => {
    const secret = "discord-bot-token-secret-value";
    const savedBot = process.env.DISCORD_BOT_TOKEN;
    process.env.DISCORD_BOT_TOKEN = secret;
    resetEnvForTest();
    const { job } = enqueueJob({
      discordMessageId: "c-redact",
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "u1",
      namespace: EBOARD,
      content: "q",
    });
    claimJob(job.id, "w1");
    let posted = "";
    const stub = {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: {
            fetch: async () => ({
              reply: async (opts: { content?: string }) => {
                posted = opts.content ?? "";
                return { id: "r-redact" };
              },
            }),
          },
          send: async () => ({ id: "r2" }),
        }),
      },
    };
    try {
      const result = await completeJobWithReply(
        job.id,
        "w1",
        { reply: `hello ${secret}` },
        { client: stub },
      );
      expect(result.ok).toBe(true);
      expect(posted).not.toContain(secret);
      expect(posted).toContain("[redacted]");
      expect(getJob(job.id)?.reply_text).not.toContain(secret);
      expect(getJob(job.id)?.reply_text).toContain("[redacted]");
    } finally {
      if (savedBot === undefined) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = savedBot;
      resetEnvForTest();
    }
  });

  test("Unknown Message (10008) on ephemeral ack falls back to channel.send, not 502", async () => {
    const { job } = enqueueJob({
      discordMessageId: "ephemeral-ack-snowflake",
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "u1",
      namespace: EBOARD,
      content: "generic slash job",
    });
    claimJob(job.id, "w1");
    let replies = 0;
    const sent: string[] = [];
    const stub = {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: {
            fetch: async () => {
              throw Object.assign(new Error("Unknown Message"), { code: 10008 });
            },
          },
          send: async (opts: { content: string }) => {
            sent.push(opts.content);
            return { id: "chan-fallback" };
          },
        }),
      },
    };
    const result = await completeJobWithReply(job.id, "w1", { reply: "Roster seed stored 25 binding(s)." }, { client: stub });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.posted).toBe(true);
    expect(result.error).toBeUndefined();
    expect(replies).toBe(0);
    expect(sent).toEqual(["Roster seed stored 25 binding(s)."]);
    expect(getJob(job.id)?.status).toBe("completed");
    expect(getJob(job.id)?.result_discord_message_id).toBe("chan-fallback");
  });
});

describe("ephemeral slash announce", () => {
  test("synthetic slash-ephemeral ids and roster.seed content announce in channel", () => {
    expect(ephemeralSlashAckMessageId("123")).toBe("slash-ephemeral:123");
    expect(shouldAnnounceInChannel({ discord_message_id: "slash-ephemeral:123" })).toBe(true);
    expect(shouldAnnounceInChannel({ discord_message_id: "999", content: "hello" })).toBe(false);
    expect(isUnknownDiscordMessageError(Object.assign(new Error("Unknown Message"), { code: 10008 }))).toBe(true);
    expect(isUnknownDiscordMessageError(new Error("missing permissions"))).toBe(false);
  });
});

describe("allowlistedGithubIssueUrl", () => {
  const ISSUE = "https://github.com/sean-lai-sh/morpheus/issues/1";
  const REPO = "sean-lai-sh/morpheus";

  test("rejects off-repo URLs", () => {
    expect(
      allowlistedGithubIssueUrl("https://github.com/evil/repo/issues/1", {
        repo: REPO,
        namespace: EBOARD,
        allowedWorkspaces: [EBOARD],
      }),
    ).toBeNull();
  });

  test("empty GITHUB_ISSUES_WORKSPACES drops every workspace (default deny)", () => {
    expect(
      allowlistedGithubIssueUrl(ISSUE, { repo: REPO, namespace: LEADERSHIP, allowedWorkspaces: [] }),
    ).toBeNull();
  });

  test("an allowlisted workspace keeps the URL", () => {
    expect(
      allowlistedGithubIssueUrl(ISSUE, {
        repo: REPO,
        namespace: LEADERSHIP,
        allowedWorkspaces: [LEADERSHIP],
      }),
    ).toBe(ISSUE);
  });

  test("membership is exact, not hierarchical", () => {
    expect(
      allowlistedGithubIssueUrl(ISSUE, {
        repo: REPO,
        namespace: EBOARD,
        allowedWorkspaces: [LEADERSHIP],
      }),
    ).toBeNull();
  });

  test("a job with no workspace never carries a URL", () => {
    expect(
      allowlistedGithubIssueUrl(ISSUE, { repo: REPO, allowedWorkspaces: [EBOARD] }),
    ).toBeNull();
  });
});

describe("completeJobWithReply github gate", () => {
  const ISSUE = "https://github.com/sean-lai-sh/morpheus/issues/7";

  test("githubWorkspaces gates the stored github_issue_url", async () => {
    const dropped = enqueueJob({
      discordMessageId: "c-github-drop",
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "u1",
      namespace: EBOARD,
      content: "q",
    }).job;
    claimJob(dropped.id, "w1");
    await completeJobWithReply(
      dropped.id,
      "w1",
      { reply: "done", github_issue_url: ISSUE },
      { postReplies: false, githubRepo: "sean-lai-sh/morpheus", githubWorkspaces: [] },
    );
    expect(getJob(dropped.id)?.github_issue_url).toBeNull();

    const kept = enqueueJob({
      discordMessageId: "c-github-keep",
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "u1",
      namespace: EBOARD,
      content: "q",
    }).job;
    claimJob(kept.id, "w1");
    await completeJobWithReply(
      kept.id,
      "w1",
      { reply: "done", github_issue_url: ISSUE },
      { postReplies: false, githubRepo: "sean-lai-sh/morpheus", githubWorkspaces: [EBOARD] },
    );
    expect(getJob(kept.id)?.github_issue_url).toBe(ISSUE);
  });
});
