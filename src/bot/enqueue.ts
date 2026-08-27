import type { Message } from "discord.js";
import { getChannel } from "../config.ts";
import { logger } from "../logger.ts";
import { routeFeedFromText } from "../notify/route.ts";
import { dispatchGrokJob, type HttpsPoster } from "../notify/grok-dispatch.ts";
import {
  countJobsSince,
  countOutstandingJobs,
  enqueueJob,
  firstPassSnippets,
  namespaceForRow,
  type ChannelResolver,
  type JobRow,
} from "../storage/jobs.ts";
import { isMentionTrigger, isReplyToBot, memberRoleIds, mentionUserIds, threadParentId } from "./triggers.ts";

export type { ChannelResolver };

export type EnqueueSkipReason =
  | "disabled"
  | "bot-author"
  | "not-trigger"
  | "channel-not-allowlisted"
  | "unknown-namespace"
  | "role-gate"
  | "outstanding-cap"
  | "rate-cap"
  | "duplicate";

export type JobSource = "mention" | "slash";

export interface JobCandidate {
  discordMessageId: string;
  discordChannelId: string;
  discordThreadId: string | null;
  parentChannelId: string | null;
  authorId: string;
  authorIsBot: boolean;
  authorRoleIds: string[];
  content: string;
  mentionedBot: boolean;
  replyToBot: boolean;
  source: JobSource;
}

export interface TryEnqueueOpts {
  now?: number;
  triggerRoleIds?: Set<string>;
  maxOutstanding?: number;
  maxPerHour?: number;
  enabled?: boolean;
  nodeEnv?: string;
  dispatch?: boolean;
  poster?: HttpsPoster;
  env?: NodeJS.ProcessEnv;
  /** Tests inject a Map so this file does not mutate global channels.yml / cwd. */
  resolveChannel?: ChannelResolver;
}

export interface TryEnqueueResult {
  job: JobRow | null;
  skipped?: EnqueueSkipReason;
  dispatched?: boolean;
}

export function candidateFromMessage(message: Message, botUserId: string): JobCandidate {
  const parentId = threadParentId(message);
  const extra = message as Message & {
    referencedMessage?: { author?: { id: string; bot?: boolean } | null } | null;
  };
  const mentioned = isMentionTrigger(message.content ?? "", botUserId, mentionUserIds(message));
  const reply = isReplyToBot(
    {
      reference: message.reference,
      referencedMessage: extra.referencedMessage,
      repliedUser: message.mentions?.repliedUser ?? null,
    },
    botUserId,
  );
  return {
    discordMessageId: message.id,
    discordChannelId: message.channelId,
    discordThreadId: parentId ? message.channelId : null,
    parentChannelId: parentId,
    authorId: message.author?.id ?? "unknown",
    authorIsBot: Boolean(message.author?.bot),
    authorRoleIds: memberRoleIds(message.member),
    content: message.content ?? "",
    mentionedBot: mentioned,
    replyToBot: reply,
    source: "mention",
  };
}

function configChannelId(candidate: JobCandidate): string {
  return candidate.parentChannelId ?? candidate.discordChannelId;
}

/**
 * Role gate fail-closed: empty trigger-role set never enqueues (production and otherwise).
 * Tests inject `triggerRoleIds`.
 */
export function authorPassesRoleGate(authorRoleIds: string[], triggerRoles: Set<string>): boolean {
  if (triggerRoles.size === 0) return false;
  return authorRoleIds.some((id) => triggerRoles.has(id));
}

export async function tryEnqueueJob(
  candidate: JobCandidate,
  opts: TryEnqueueOpts = {},
): Promise<TryEnqueueResult> {
  const envVars = opts.env ?? process.env;
  const enabled = opts.enabled ?? parseEnvBool(envVars.JOB_QUEUE_ENABLED, true);
  const maxOutstanding = opts.maxOutstanding ?? parseEnvInt(envVars.JOB_MAX_OUTSTANDING_PER_AUTHOR, 2);
  const maxPerHour = opts.maxPerHour ?? parseEnvInt(envVars.JOB_MAX_PER_AUTHOR_PER_HOUR, 5);
  const triggerRoles =
    opts.triggerRoleIds ??
    new Set(
      (envVars.JOB_TRIGGER_ROLE_IDS ?? "")
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    );

  if (!enabled) return { job: null, skipped: "disabled" };
  if (candidate.authorIsBot) return { job: null, skipped: "bot-author" };

  const isTrigger =
    candidate.source === "slash" || candidate.mentionedBot || candidate.replyToBot;
  if (!isTrigger) return { job: null, skipped: "not-trigger" };

  const resolveChannel = opts.resolveChannel ?? getChannel;
  const channelId = configChannelId(candidate);
  const channel = resolveChannel(channelId);
  if (!channel) return { job: null, skipped: "channel-not-allowlisted" };

  const namespace = namespaceForRow(
    {
      channel_id: candidate.discordChannelId,
      parent_channel_id: candidate.parentChannelId,
    },
    resolveChannel,
  );
  if (!namespace) return { job: null, skipped: "unknown-namespace" };

  if (!authorPassesRoleGate(candidate.authorRoleIds, triggerRoles)) {
    const nodeEnv = opts.nodeEnv ?? envVars.NODE_ENV ?? "development";
    logger.error(
      { author_id: candidate.authorId, node_env: nodeEnv, trigger_roles: triggerRoles.size },
      "job enqueue role gate failed (fail closed)",
    );
    return { job: null, skipped: "role-gate" };
  }

  const now = opts.now ?? Date.now();
  if (countOutstandingJobs(candidate.authorId) >= maxOutstanding) {
    logger.info(
      { author_id: candidate.authorId, cap: maxOutstanding },
      "job enqueue skipped: outstanding cap",
    );
    return { job: null, skipped: "outstanding-cap" };
  }
  if (countJobsSince(candidate.authorId, now - 3_600_000) >= maxPerHour) {
    logger.info(
      { author_id: candidate.authorId, cap: maxPerHour },
      "job enqueue skipped: hourly cap",
    );
    return { job: null, skipped: "rate-cap" };
  }

  const { job, duplicate } = enqueueJob(
    {
      discordMessageId: candidate.discordMessageId,
      discordChannelId: candidate.discordChannelId,
      discordThreadId: candidate.discordThreadId,
      authorId: candidate.authorId,
      namespace,
      content: candidate.content,
    },
    now,
  );
  if (duplicate) return { job, skipped: "duplicate" };

  logger.info(
    {
      job_id: job.id,
      namespace: job.namespace,
      discord_message_id: job.discord_message_id,
      source: candidate.source,
    },
    "job enqueued",
  );

  if (opts.dispatch === false) return { job };

  const dispatched = await dispatchEnqueuedJob(job, {
    poster: opts.poster,
    env: envVars,
    resolveChannel,
  });
  return { job, dispatched };
}

export async function dispatchEnqueuedJob(
  job: JobRow,
  opts: { poster?: HttpsPoster; env?: NodeJS.ProcessEnv; resolveChannel?: ChannelResolver } = {},
): Promise<boolean> {
  try {
    const snippets = firstPassSnippets(job, 12, opts.resolveChannel ?? getChannel);
    const result = await dispatchGrokJob(
      {
        first_pass: true,
        job: {
          id: job.id,
          discord_message_id: job.discord_message_id,
          discord_channel_id: job.discord_channel_id,
          author_id: job.author_id,
          namespace: job.namespace,
          content: job.content,
        },
        snippets,
        feed_hint: routeFeedFromText(job.content),
      },
      { env: opts.env, poster: opts.poster },
    );
    return result.dispatched;
  } catch (err) {
    logger.error({ err, job_id: job.id }, "Grok dispatch failed; job remains queued");
    return false;
  }
}

function parseEnvBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === "") return fallback;
  const s = raw.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes") return true;
  if (s === "0" || s === "false" || s === "no") return false;
  return fallback;
}

function parseEnvInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}
