import type { Message } from "discord.js";
import { getChannel, jobTriggerRoleIds, loadEnv, type Env } from "../config.ts";
import { logger } from "../logger.ts";
import { routeFeedFromText } from "../notify/route.ts";
import { dispatchGrokJob, type GrokJobPayload, type HttpsPoster } from "../notify/grok-dispatch.ts";
import { dispatchSdkJob } from "../notify/sdk-dispatch.ts";
import { namespaceForRow, type ChannelResolver } from "../context/namespace.ts";
import {
  countJobsSince,
  countOutstandingJobs,
  enqueueJob,
  firstPassSnippets,
  type JobRow,
} from "../storage/jobs.ts";
import { mentionChannelIds, resolveJobChannelScope } from "./job-scope.ts";
import {
  startJobTyping,
  type StartJobTypingOpts,
  type TypingClient,
  type TypingScheduler,
} from "./typing.ts";
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

/**
 * `mention` (@bot / reply-to-bot) and `slash` (/ask) are the interactive lane:
 * short turns that may run on the local Cursor SDK sibling.
 *
 * `background` (/background) and `coordinator` (/meet seed, Calendar handoffs)
 * are the queued lane: always Grok Bot, never the SDK sibling, regardless of
 * CURSOR_SDK_DISPATCH. Coordinator work needs Google Calendar / Sheets / Gmail
 * tooling that only the Grok worker has — the /meet seed ack literally promises
 * "Grok (hello@) will read the F26 sheet" — so it can never be routed to the
 * sibling. Caps are lane-scoped, so this also keeps a roster seed or a Calendar
 * retry from eating a human's /ask outstanding slots.
 */
export type JobSource = "mention" | "slash" | "background" | "coordinator";

export type JobLane = "interactive" | "background";

export function laneForSource(source: JobSource): JobLane {
  return source === "background" || source === "coordinator" ? "background" : "interactive";
}

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
  /** Discord `<#id>` / mentions.channels from the trigger. */
  mentionedChannelIds?: string[];
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
  /** Poster for the sibling Cursor SDK dispatcher (experiment #47, flag-gated off). */
  sdkPoster?: HttpsPoster;
  env?: Env;
  /** Tests inject a Map so this file does not mutate global channels.yml / cwd. */
  resolveChannel?: ChannelResolver;
  /**
   * ViewChannel for extra `#channel` mentions. Default fail-closed (false).
   * Production wires discord.js `permissionsFor`.
   */
  canViewChannel?: (channelId: string) => boolean;
  /** Injectable workspace lookup for job scope. Default: channels.yml. */
  resolveWorkspace?: (id: string) => { parent?: string } | undefined;
  /** Injectable workspace-subtree lookup for mentioned channels. Default: channels.yml. */
  visibleWorkspaces?: (root: string) => ReadonlySet<string>;
  /** Tests inject sendTyping so dispatch tests never touch Discord. */
  typingClient?: TypingClient;
  sendTyping?: (channelId: string) => Promise<void>;
  typingScheduler?: TypingScheduler;
}

export interface TryEnqueueResult {
  job: JobRow | null;
  skipped?: EnqueueSkipReason;
  dispatched?: boolean;
  typingStarted?: boolean;
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
    mentionedChannelIds: mentionChannelIds(message),
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

type CandidateGate =
  | { ok: false; skipped: EnqueueSkipReason }
  | { ok: true; loaded: Env; namespace: string; channelId: string; resolveChannel: ChannelResolver };

/**
 * Shared fail-closed gates for @mention jobs and NL todos. Caps are job-only
 * and are not included: a todo should still land when the Grok/SDK lane is full.
 * Returns what it resolved on the way through so callers do not re-derive the
 * env, the channel resolver, or the namespace a second time.
 */
function gateCandidate(candidate: JobCandidate, opts: TryEnqueueOpts): CandidateGate {
  const loaded = opts.env ?? loadEnv();
  const enabled = opts.enabled ?? loaded.JOB_QUEUE_ENABLED;
  const triggerRoles = opts.triggerRoleIds ?? jobTriggerRoleIds(loaded);

  if (!enabled) return { ok: false, skipped: "disabled" };
  if (candidate.authorIsBot) return { ok: false, skipped: "bot-author" };

  const isTrigger =
    candidate.source === "slash" ||
    candidate.source === "background" ||
    candidate.source === "coordinator" ||
    candidate.mentionedBot ||
    candidate.replyToBot;
  if (!isTrigger) return { ok: false, skipped: "not-trigger" };

  const resolveChannel = opts.resolveChannel ?? getChannel;
  const channelId = configChannelId(candidate);
  if (!resolveChannel(channelId)) return { ok: false, skipped: "channel-not-allowlisted" };

  const namespace = namespaceForRow(
    {
      channel_id: candidate.discordChannelId,
      parent_channel_id: candidate.parentChannelId,
    },
    resolveChannel,
  );
  if (!namespace) return { ok: false, skipped: "unknown-namespace" };

  if (!authorPassesRoleGate(candidate.authorRoleIds, triggerRoles)) {
    const nodeEnv = opts.nodeEnv ?? loaded.NODE_ENV;
    logger.error(
      { author_id: candidate.authorId, node_env: nodeEnv, trigger_roles: triggerRoles.size },
      "job enqueue role gate failed (fail closed)",
    );
    return { ok: false, skipped: "role-gate" };
  }
  return { ok: true, loaded, namespace, channelId, resolveChannel };
}

export function skipReasonForCandidate(
  candidate: JobCandidate,
  opts: TryEnqueueOpts = {},
): EnqueueSkipReason | null {
  const gate = gateCandidate(candidate, opts);
  return gate.ok ? null : gate.skipped;
}

export async function tryEnqueueJob(
  candidate: JobCandidate,
  opts: TryEnqueueOpts = {},
): Promise<TryEnqueueResult> {
  const gate = gateCandidate(candidate, opts);
  if (!gate.ok) return { job: null, skipped: gate.skipped };
  const { loaded, namespace, channelId, resolveChannel } = gate;

  const maxOutstanding = opts.maxOutstanding ?? loaded.JOB_MAX_OUTSTANDING_PER_AUTHOR;
  const maxPerHour = opts.maxPerHour ?? loaded.JOB_MAX_PER_AUTHOR_PER_HOUR;

  const now = opts.now ?? Date.now();
  const lane = laneForSource(candidate.source);

  // Caps are lane-scoped: interactive (local SDK) and background (Grok) each
  // have their own outstanding/hourly counters. Passing `lane` into the
  // existing counters keeps a Grok flood from locking the Mini slot, and
  // keeps /background from enqueueing unboundedly. Role gate above still
  // fail-closes for every lane.
  if (
    countOutstandingJobs(candidate.authorId, candidate.discordChannelId, lane) >=
    maxOutstanding
  ) {
    logger.info(
      {
        author_id: candidate.authorId,
        channel_id: candidate.discordChannelId,
        cap: maxOutstanding,
        lane,
      },
      "job enqueue skipped: outstanding cap (per channel, per lane)",
    );
    return { job: null, skipped: "outstanding-cap" };
  }
  if (countJobsSince(candidate.authorId, now - 3_600_000, lane) >= maxPerHour) {
    logger.info(
      { author_id: candidate.authorId, cap: maxPerHour, lane },
      "job enqueue skipped: hourly cap (per lane)",
    );
    return { job: null, skipped: "rate-cap" };
  }

  const mentionedIds =
    candidate.mentionedChannelIds ?? mentionChannelIds({ content: candidate.content });
  const { scope, channelIds } = resolveJobChannelScope({
    namespace,
    originatingChannelId: channelId,
    threadId: candidate.discordThreadId,
    mentionedChannelIds: mentionedIds,
    canViewChannel: opts.canViewChannel ?? (() => false),
    resolveChannel,
    resolveWorkspace: opts.resolveWorkspace,
    visibleWorkspaces: opts.visibleWorkspaces,
  });

  const { job, duplicate } = enqueueJob(
    {
      discordMessageId: candidate.discordMessageId,
      discordChannelId: candidate.discordChannelId,
      discordThreadId: candidate.discordThreadId,
      authorId: candidate.authorId,
      namespace,
      scope,
      channelIds,
      content: candidate.content,
      lane,
    },
    now,
  );
  if (duplicate) return { job, skipped: "duplicate" };

  logger.info(
    {
      job_id: job.id,
      namespace: job.namespace,
      scope: job.scope,
      channel_ids: job.channel_ids,
      discord_message_id: job.discord_message_id,
      source: candidate.source,
    },
    "job enqueued",
  );

  if (opts.dispatch === false) return { job };

  const dispatched = await dispatchEnqueuedJob(job, {
    lane: laneForSource(candidate.source),
    poster: opts.poster,
    sdkPoster: opts.sdkPoster,
    env: loaded,
    resolveChannel,
    typingClient: opts.typingClient,
    sendTyping: opts.sendTyping,
    typingScheduler: opts.typingScheduler,
  });
  return { job, dispatched: dispatched.dispatched, typingStarted: dispatched.typingStarted };
}

/**
 * Lane routing (#47 split, Grok Bot stays the long-running queue):
 *
 *   - `background` (/background)         → Grok Bot webhook, always.
 *   - `interactive` + CURSOR_SDK_DISPATCH → sibling Cursor SDK dispatcher.
 *   - `interactive`, flag off (default)   → Grok Bot webhook, exactly as today.
 *
 * The SDK sibling never receives /background jobs; the flag never steals them.
 *
 * `lane` defaults to the lane the row was enqueued in, not to `interactive`:
 * the persisted lane is what the caps counted and what the ack promised, so a
 * re-dispatch that forgets the option (the outbox sweeper used to) can no
 * longer hand a Grok-only job to the SDK sibling.
 */
export async function dispatchEnqueuedJob(
  job: JobRow,
  opts: {
    lane?: JobLane;
    poster?: HttpsPoster;
    sdkPoster?: HttpsPoster;
    env?: Env;
    resolveChannel?: ChannelResolver;
    typingClient?: TypingClient;
    sendTyping?: (channelId: string) => Promise<void>;
    typingScheduler?: TypingScheduler;
  } = {},
): Promise<{ dispatched: boolean; typingStarted?: boolean }> {
  const env = opts.env ?? loadEnv();
  const lane = opts.lane ?? laneOfRow(job);

  // Only a queued row can still be claimed (claimJob's CAS requires
  // status='queued'). The outbox sweeper retries every 60s off a stored
  // discord_message_id, so a row cancelled by cancelStaleQueuedJobs — or
  // already completed — would otherwise be re-POSTed forever: the webhook
  // answers 2xx, the caller records a successful handoff, and no worker can
  // ever pick the job up. Refuse before any POST and log the loop.
  if (job.status !== "queued") {
    logger.warn(
      { job_id: job.id, status: job.status, lane },
      "job dispatch skipped: row is no longer queued (cannot be claimed)",
    );
    return { dispatched: false };
  }

  let payload: GrokJobPayload;
  try {
    const snippets = firstPassSnippets(job, 12, opts.resolveChannel ?? getChannel);
    payload = {
      first_pass: true,
      job: {
        id: job.id,
        discord_message_id: job.discord_message_id,
        discord_channel_id: job.discord_channel_id,
        author_id: job.author_id,
        namespace: job.namespace,
        scope: job.scope,
        channel_ids: job.channel_ids,
        content: job.content,
      },
      snippets,
      feed_hint: routeFeedFromText(job.content),
    };
  } catch (err) {
    logger.error({ err, job_id: job.id }, "job dispatch payload build failed; job remains queued");
    return { dispatched: false };
  }

  try {
    const useSdk = lane === "interactive" && env.CURSOR_SDK_DISPATCH;
    const result = useSdk
      ? await dispatchSdkJob(payload, { env, poster: opts.sdkPoster })
      : await dispatchGrokJob(payload, { env, poster: opts.poster });
    if (!result.dispatched) return { dispatched: false };
    // Typing starts after a 2xx from whichever worker took the job (#48);
    // the official bot on the Mini drives it, never the worker.
    //
    // Interactive only. `/background` is explicitly the "this takes minutes,
    // go away and come back" lane — its slash ack already says so, and a
    // typing indicator pulsing for several minutes reads as a hung bot rather
    // than a working one. The ack is the acknowledgement; the reply is the
    // result.
    if (lane === "background") return { dispatched: true, typingStarted: false };
    const typing = await startTypingAfterDispatch(job, opts);
    return { dispatched: true, typingStarted: typing };
  } catch (err) {
    logger.error({ err, job_id: job.id, lane }, "job dispatch failed; job remains queued");
    return { dispatched: false };
  }
}

/**
 * `jobs.lane` is persisted but not yet part of the `JobRow` type, so read it
 * defensively; anything unset stays `interactive`, the historical default.
 */
function laneOfRow(job: JobRow): JobLane {
  return (job as JobRow & { lane?: unknown }).lane === "background" ? "background" : "interactive";
}

async function startTypingAfterDispatch(
  job: JobRow,
  opts: Pick<TryEnqueueOpts, "env" | "typingClient" | "sendTyping" | "typingScheduler">,
): Promise<boolean> {
  const typingOpts: StartJobTypingOpts = {
    env: opts.env,
    client: opts.typingClient,
    sendTyping: opts.sendTyping,
    scheduler: opts.typingScheduler,
  };
  try {
    const started = await startJobTyping(job, typingOpts);
    return started.started;
  } catch (err) {
    logger.warn({ err, job_id: job.id }, "job typing failed to start; dispatch still succeeded");
    return false;
  }
}
