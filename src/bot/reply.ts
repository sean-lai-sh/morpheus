import type { Client, Message, TextBasedChannel } from "discord.js";
import { loadEnv } from "../config.ts";
import { logger } from "../logger.ts";
import { redactSecrets } from "../notify/grok-dispatch.ts";
import { stopJobTyping } from "./typing.ts";
import {
  failJob,
  getJob,
  markJobCompleted,
  markJobSendError,
  prepareComplete,
  recordJobDiscordSend,
  type CompleteInput,
  type JobRow,
} from "../storage/jobs.ts";

/** Mention defense is Discord's allowedMentions — do not substring-scan @everyone. */
export const JOB_ALLOWED_MENTIONS = {
  parse: [] as never[],
  users: [] as string[],
  roles: [] as string[],
  repliedUser: false,
} as const;

const DISCORD_CONTENT_LIMIT = 2000;
const MAX_REPLY_CHARS = 8_000;

export interface DiscordReplyClient {
  channels: {
    fetch(id: string): Promise<unknown>;
  };
}

export function splitDiscordContent(content: string, limit = DISCORD_CONTENT_LIMIT): string[] {
  const text = content.length > MAX_REPLY_CHARS ? `${content.slice(0, MAX_REPLY_CHARS - 14)}…[truncated]` : content;
  if (text.length === 0) return ["\u200b"];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.5)) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function isTextChannel(channel: unknown): channel is TextBasedChannel & {
  messages: { fetch(id: string): Promise<Message> };
  send(opts: unknown): Promise<{ id: string }>;
} {
  if (!channel || typeof channel !== "object") return false;
  const c = channel as { isTextBased?: () => boolean; messages?: unknown; send?: unknown };
  if (typeof c.isTextBased === "function") return c.isTextBased();
  return Boolean(c.messages && c.send);
}

export async function postJobReply(
  job: Pick<JobRow, "discord_channel_id" | "discord_message_id" | "id"> & {
    result_discord_message_id?: string | null;
  },
  content: string,
  opts: {
    client?: DiscordReplyClient;
    onFirstSent?: (messageId: string) => void;
  } = {},
): Promise<{ messageId: string | null; skipped?: string }> {
  const client = opts.client;
  if (!client) return { messageId: null, skipped: "client-missing" };

  if (job.result_discord_message_id) {
    return { messageId: job.result_discord_message_id, skipped: "already-sent" };
  }

  const channel = await client.channels.fetch(job.discord_channel_id);
  if (!isTextChannel(channel)) {
    logger.error({ job_id: job.id, channel_id: job.discord_channel_id }, "job reply: channel not text-based");
    return { messageId: null, skipped: "channel-not-text" };
  }
  const message = await channel.messages.fetch(job.discord_message_id);
  const chunks = splitDiscordContent(content);
  const first = chunks[0] ?? "\u200b";
  const sent = await message.reply({
    content: first,
    allowedMentions: {
      parse: [],
      users: [],
      roles: [],
      repliedUser: false,
    },
  });
  opts.onFirstSent?.(sent.id);
  try {
    for (const extra of chunks.slice(1)) {
      await channel.send({
        content: extra,
        allowedMentions: {
          parse: [],
          users: [],
          roles: [],
          repliedUser: false,
        },
      });
    }
  } catch (err) {
    logger.error({ err, job_id: job.id }, "job reply follow-up failed after first send; not re-posting");
    return { messageId: sent.id, skipped: "follow-up-failed" };
  }
  return { messageId: sent.id };
}

/**
 * Default deny: a job's workspace must be listed in `allowedWorkspaces`
 * (GITHUB_ISSUES_WORKSPACES) before its reply may carry a GitHub issue URL.
 * Exact membership, not hierarchy.
 */
export function allowlistedGithubIssueUrl(
  raw: string | null | undefined,
  opts: { repo?: string; namespace?: string; allowedWorkspaces: string[] },
): string | null {
  if (!raw?.trim()) return null;
  if (!opts.namespace || !opts.allowedWorkspaces.includes(opts.namespace)) return null;
  const repo = opts.repo?.trim();
  if (!repo) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:") return null;
    if (u.hostname !== "github.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 4) return null;
    const [owner, name, kind, n] = parts;
    if (`${owner}/${name}` !== repo) return null;
    if (kind !== "issues" || !n || !/^\d+$/.test(n)) return null;
    return `${u.origin}/${owner}/${name}/issues/${n}`;
  } catch {
    return null;
  }
}

export interface CompleteJobResult {
  ok: boolean;
  status: number;
  job?: JobRow;
  error?: string;
  posted?: boolean;
}

/**
 * Idempotent complete: persist reply_text/completion_key, then Discord send, then mark completed.
 * Already-completed returns stored result_discord_message_id and does not re-post.
 */
export async function completeJobWithReply(
  id: string,
  claimedBy: string,
  input: CompleteInput,
  opts: {
    client?: DiscordReplyClient | Client;
    now?: number;
    postReplies?: boolean;
    githubRepo?: string;
    /** Workspace ids allowed to carry a GitHub issue URL. Default: GITHUB_ISSUES_WORKSPACES. */
    githubWorkspaces?: string[];
    /** Claim generation the caller must still own; gated atomically in prepareComplete. */
    expectedClaimedAt?: number;
  } = {},
): Promise<CompleteJobResult> {
  if (typeof input.reply !== "string" || input.reply.trim() === "") {
    return { ok: false, status: 400, error: "reply is required" };
  }

  let githubRepo = opts.githubRepo;
  let githubWorkspaces = opts.githubWorkspaces;
  let postReplies = opts.postReplies;
  const env = loadEnv();
  const reply = redactSecrets(input.reply, env);
  githubRepo ??= env.GITHUB_ISSUE_REPO;
  githubWorkspaces ??= env.GITHUB_ISSUES_WORKSPACES;
  postReplies ??= env.DISCORD_POST_REPLIES;

  const existing = getJob(id);
  const github = allowlistedGithubIssueUrl(input.github_issue_url, {
    repo: githubRepo,
    namespace: existing?.namespace,
    allowedWorkspaces: githubWorkspaces,
  });

  const prep = prepareComplete(
    id,
    claimedBy,
    { reply, github_issue_url: github, completion_key: input.completion_key },
    opts.now,
    opts.expectedClaimedAt,
  );
  if (!prep.ok) {
    const status = prep.reason === "not-found" ? 404 : 409;
    return { ok: false, status, error: prep.reason };
  }
  // Typing stops only once the reply is on Discord (or the job is terminal). A send
  // error leaves the job claimed for retry, and the indicator must survive that.
  if (prep.alreadyCompleted) {
    stopJobTyping(id);
    if (prep.job.status === "claimed" && prep.job.result_discord_message_id) {
      const done = markJobCompleted(id, prep.job.result_discord_message_id, opts.now);
      return { ok: true, status: 200, job: done ?? prep.job, posted: false };
    }
    return { ok: true, status: 200, job: prep.job, posted: false };
  }

  if (prep.job.result_discord_message_id) {
    stopJobTyping(id);
    const done = markJobCompleted(id, prep.job.result_discord_message_id, opts.now);
    return { ok: true, status: 200, job: done ?? prep.job, posted: false };
  }

  if (postReplies === false) {
    stopJobTyping(id);
    const done = markJobCompleted(id, null, opts.now);
    return { ok: true, status: 200, job: done ?? prep.job, posted: false };
  }

  if (!opts.client) {
    markJobSendError(id, "discord-client-unavailable", opts.now);
    return { ok: false, status: 503, error: "discord-client-unavailable", job: getJob(id) ?? prep.job };
  }

  try {
    const sent = await postJobReply(prep.job, reply, {
      client: opts.client,
      onFirstSent: (messageId) => {
        recordJobDiscordSend(id, messageId, opts.now);
        stopJobTyping(id);
      },
    });
    if (!sent.messageId) {
      markJobSendError(id, sent.skipped ?? "discord-send-failed", opts.now);
      // Job stays claimed for a retry; leave typing running until it posts or times out.
      return { ok: false, status: 502, error: sent.skipped ?? "discord-send-failed", job: getJob(id) ?? prep.job };
    }
    stopJobTyping(id);
    const done = markJobCompleted(id, sent.messageId, opts.now);
    return { ok: true, status: 200, job: done ?? getJob(id) ?? prep.job, posted: sent.skipped !== "already-sent" };
  } catch (err) {
    const recorded = getJob(id)?.result_discord_message_id;
    if (recorded) {
      stopJobTyping(id);
      const done = markJobCompleted(id, recorded, opts.now);
      logger.error({ err, job_id: id }, "job Discord follow-up failed; first send recorded, not retrying post");
      return { ok: true, status: 200, job: done ?? getJob(id) ?? prep.job, posted: true };
    }
    const msg = err instanceof Error ? err.message : "discord-send-failed";
    logger.error({ err, job_id: id }, "job Discord reply failed; leaving claimed");
    markJobSendError(id, msg, opts.now);
    return { ok: false, status: 502, error: msg, job: getJob(id) ?? prep.job };
  }
}

export function failJobAsWorker(
  id: string,
  claimedBy: string,
  error: string,
  now?: number,
  expectedClaimedAt?: number,
): { ok: boolean; status: number; job?: JobRow; error?: string } {
  const job = failJob(id, claimedBy, error, now, expectedClaimedAt);
  if (!job) {
    const existing = getJob(id);
    if (!existing) return { ok: false, status: 404, error: "not-found" };
    // A live claim we still own by identity but with a stale generation echo →
    // stale-claim, distinct from a plain claimed_by mismatch (both 409).
    if (
      expectedClaimedAt != null &&
      existing.status === "claimed" &&
      existing.claimed_by === claimedBy.trim() &&
      existing.claimed_at !== expectedClaimedAt
    ) {
      return { ok: false, status: 409, error: "stale-claim" };
    }
    return { ok: false, status: 409, error: "claimed-by-mismatch" };
  }
  stopJobTyping(id);
  return { ok: true, status: 200, job };
}
