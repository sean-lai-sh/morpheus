import { loadEnv, type Env } from "../config.ts";
import { logger } from "../logger.ts";
import { getJob } from "../storage/jobs.ts";
import { peekClient } from "./client.ts";

/**
 * Mini-side typing after GROK_BOT_WEBHOOK_URL 2xx.
 *
 * Discord typing expires in ~10s. We pulse sendTyping on the official discord.js
 * client until the job leaves queued/claimed, the reply posts, or maxMs.
 *
 * Why not POST /v1/jobs/:id/typing from Grok? Extra Tailscale round-trip after
 * the wakeup webhook; Grok's first HTTP hit is often /v1/fs (no job id). Mini
 * already has the official client and the job's channel/thread at dispatch time.
 * Grok never holds DISCORD_BOT_TOKEN; this module talks to Discord only through
 * the existing Mini client.
 */

/** Discord typing indicator lasts ~10s. Pulse before it expires. */
export const TYPING_PULSE_MS = 8_000;

export interface TypingChannel {
  sendTyping(): Promise<unknown>;
}

export interface TypingClient {
  channels: {
    fetch(id: string): Promise<unknown>;
  };
}

export interface TypingScheduler {
  interval(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

export const defaultTypingScheduler: TypingScheduler = {
  interval(fn, ms) {
    const id = setInterval(fn, ms);
    id.unref?.();
    return id;
  },
  clear(id) {
    clearInterval(id as ReturnType<typeof setInterval>);
  },
};

export interface JobTypingTarget {
  id: string;
  discord_channel_id: string;
  discord_thread_id?: string | null;
}

interface TypingLoop {
  jobId: string;
  channelId: string;
  timer: unknown;
  deadline: number;
  stopped: boolean;
}

const loops = new Map<string, TypingLoop>();

/**
 * Channel (or thread) where the member asked. Prefer discord_thread_id when set.
 * Never use job.channel_ids — that is retrieval scope, not the reply surface.
 */
export function jobTypingChannelId(job: {
  discord_channel_id: string;
  discord_thread_id?: string | null;
}): string {
  const thread = job.discord_thread_id?.trim() ?? "";
  if (thread && /^\d+$/.test(thread)) return thread;
  return job.discord_channel_id;
}

export function isJobTypingActive(jobId: string): boolean {
  const loop = loops.get(jobId);
  return Boolean(loop && !loop.stopped);
}

export function activeTypingJobIds(): string[] {
  return [...loops.keys()];
}

export function stopJobTyping(jobId: string, scheduler: TypingScheduler = defaultTypingScheduler): void {
  const loop = loops.get(jobId);
  if (!loop) return;
  loop.stopped = true;
  if (loop.timer != null) scheduler.clear(loop.timer);
  loops.delete(jobId);
}

export function stopAllJobTyping(scheduler: TypingScheduler = defaultTypingScheduler): void {
  for (const id of [...loops.keys()]) stopJobTyping(id, scheduler);
}

function readyOfficialClient(): TypingClient | undefined {
  const client = peekClient();
  if (!client?.isReady()) return undefined;
  return client;
}

function jobStillOpen(jobId: string): boolean {
  const job = getJob(jobId);
  if (!job) return false;
  return job.status === "queued" || job.status === "claimed";
}

function isTextTypingChannel(channel: unknown): channel is TypingChannel {
  if (!channel || typeof channel !== "object") return false;
  const c = channel as { isTextBased?: () => boolean; sendTyping?: unknown };
  if (typeof c.sendTyping !== "function") return false;
  if (typeof c.isTextBased === "function" && !c.isTextBased()) return false;
  return true;
}

async function sendTypingOnClient(client: TypingClient, channelId: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!isTextTypingChannel(channel)) {
    throw new Error("channel-not-text");
  }
  await channel.sendTyping();
}

export interface StartJobTypingOpts {
  client?: TypingClient;
  env?: Env;
  pulseMs?: number;
  maxMs?: number;
  sendTyping?: (channelId: string) => Promise<void>;
  scheduler?: TypingScheduler;
  now?: number;
  nowFn?: () => number;
  isFinished?: (jobId: string) => boolean;
}

export interface StartJobTypingResult {
  started: boolean;
  skipped?: string;
  channelId?: string;
}

/**
 * Best-effort: never throws into the dispatch path. First pulse is awaited so
 * the indicator shows immediately after webhook 2xx; later pulses are interval.
 */
export async function startJobTyping(
  job: JobTypingTarget,
  opts: StartJobTypingOpts = {},
): Promise<StartJobTypingResult> {
  const env = opts.env ?? loadEnv();
  if (!env.DISCORD_TYPING_ON_DISPATCH) {
    return { started: false, skipped: "disabled" };
  }

  const channelId = jobTypingChannelId(job);
  if (!channelId || !/^\d+$/.test(channelId)) {
    return { started: false, skipped: "invalid-channel" };
  }

  const scheduler = opts.scheduler ?? defaultTypingScheduler;
  stopJobTyping(job.id, scheduler);

  const client = opts.client ?? readyOfficialClient();
  const send =
    opts.sendTyping ??
    (async (id: string) => {
      if (!client) throw new Error("client-missing");
      await sendTypingOnClient(client, id);
    });

  if (!opts.sendTyping && !client) {
    return { started: false, skipped: "client-missing" };
  }

  const isFinished = opts.isFinished ?? ((id) => !jobStillOpen(id));
  if (isFinished(job.id)) {
    return { started: false, skipped: "job-finished" };
  }

  const pulseMs = opts.pulseMs ?? TYPING_PULSE_MS;
  const maxMs = opts.maxMs ?? env.DISCORD_TYPING_MAX_MS;
  const nowFn = opts.nowFn ?? (() => opts.now ?? Date.now());
  const startedAt = nowFn();
  const loop: TypingLoop = {
    jobId: job.id,
    channelId,
    timer: null,
    deadline: startedAt + maxMs,
    stopped: false,
  };
  loops.set(job.id, loop);

  const pulse = async (): Promise<void> => {
    if (loop.stopped) return;
    if (nowFn() >= loop.deadline || isFinished(job.id)) {
      stopJobTyping(job.id, scheduler);
      return;
    }
    try {
      await send(channelId);
    } catch (err) {
      logger.warn({ err, job_id: job.id, channel_id: channelId }, "job typing pulse failed; stopping");
      stopJobTyping(job.id, scheduler);
    }
  };

  await pulse();
  if (loop.stopped || !loops.has(job.id)) {
    return { started: false, skipped: "stopped", channelId };
  }

  loop.timer = scheduler.interval(() => {
    void pulse();
  }, pulseMs);

  return { started: true, channelId };
}
