/**
 * Shared ingest pipeline used by both live events and backfill/reconcile.
 *
 * Flow per message:
 *   1. Hard pre-filter (drop bots, drop trivially-small messages, etc.)
 *   2. Upsert into SQLite (source of truth)
 *   3. Extract + persist GDrive links
 *   4. Decide markdown eligibility:
 *        - if channel.classify=false → write as operational
 *        - else → enqueue for classifier; do NOT write markdown yet
 *   5. Classifier worker (separate path) updates classification later and
 *      then triggers an append/rerender.
 *
 * Thread messages: pass parentChannelId when the message is in a thread of an
 * allowed channel that has include_threads:true. The message is stored under its
 * own thread channel_id in SQLite but uses the parent's config for classify
 * settings and markdown output.
 */
import type { Message, PartialMessage } from "discord.js";
import { getChannel, isChannelAllowed, loadChannels } from "../config.ts";
import { logger } from "../logger.ts";
import { setOldestSeen, setNewestSeen } from "../storage/crawl-state.ts";
import { extractLinks, persistLinks, removeLinksNotIn } from "../storage/links.ts";
import { appendBlock } from "../storage/markdown.ts";
import {
  effectiveChannelId,
  getMessage,
  markDeleted,
  setClassification,
  upsertMessage,
} from "../storage/messages.ts";
import { enqueue } from "../storage/queue.ts";

let bypassClassifier = false;
export function setClassifierBypass(value: boolean): void {
  bypassClassifier = value;
}

/** Hard filters that don't need an LLM. Returns reason if dropped. */
function hardFilterReason(message: Message | PartialMessage): string | null {
  if (message.author?.bot) return "bot-author";
  const content = (message.content ?? "").trim();
  // Allow short messages if they include a GDrive URL — the URL is the signal.
  const stripped = content.replace(/<@!?\d+>|<@&\d+>|<#\d+>|<a?:[a-zA-Z0-9_]+:\d+>/g, "").trim();
  const hasGdrive = /\b(drive|docs|sheets|slides|forms)\.google\.com\//i.test(content);
  if (!hasGdrive && stripped.length < 6) return "too-short";
  return null;
}

function authorName(message: Message | PartialMessage): string {
  const member = message.member;
  if (member?.displayName) return member.displayName;
  if (message.author?.username) return message.author.username;
  if (message.author?.globalName) return message.author.globalName;
  return message.author?.id ?? "unknown";
}

function fetchedToInput(
  message: Message,
  parentChannelId?: string | null,
): {
  id: string;
  channelId: string;
  parentChannelId: string | null;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;
  editedAt: number | null;
} {
  return {
    id: message.id,
    channelId: message.channelId,
    parentChannelId: parentChannelId ?? null,
    authorId: message.author?.id ?? "unknown",
    authorName: authorName(message),
    content: message.content ?? "",
    createdAt: message.createdTimestamp,
    editedAt: message.editedTimestamp ?? null,
  };
}

export interface IngestResult {
  action: "inserted" | "edited" | "skipped" | "dropped";
  reason?: string;
}

/**
 * Ingest a message. For thread messages, pass parentChannelId (the parent text
 * channel's id) — the parent must be allowlisted with include_threads:true.
 */
export async function ingestMessage(
  message: Message,
  parentChannelId?: string | null,
): Promise<IngestResult> {
  const configChannelId = parentChannelId ?? message.channelId;

  if (parentChannelId) {
    // Thread: parent must be allowlisted AND have include_threads:true
    const parent = getChannel(parentChannelId);
    if (!parent?.include_threads) {
      return { action: "skipped", reason: "channel-not-allowlisted" };
    }
  } else if (!isChannelAllowed(message.channelId)) {
    return { action: "skipped", reason: "channel-not-allowlisted" };
  }

  const dropReason = hardFilterReason(message);
  if (dropReason) return { action: "dropped", reason: dropReason };

  const input = fetchedToInput(message, parentChannelId);
  const { inserted, edited } = upsertMessage(input);

  // Crawl cursors track under the effective (config) channel id.
  setOldestSeen(configChannelId, input.id);
  setNewestSeen(configChannelId, input.id);

  const links = extractLinks(input.content);
  if (edited) removeLinksNotIn(input.id, links.map((l) => l.url));
  persistLinks(input.id, input.channelId, links, input.createdAt);

  if (!inserted && !edited) return { action: "skipped", reason: "no-change" };

  const channel = getChannel(configChannelId);
  if (!channel) return { action: "skipped", reason: "channel-config-missing" };

  if (!channel.classify || bypassClassifier) {
    setClassification(input.id, "operational", 1.0);
    const guildId = loadChannels().guild_id;
    const fresh = getMessage(input.id);
    if (fresh) {
      appendBlock(channel, guildId, fresh, inserted ? "create" : "edit");
    }
    return { action: inserted ? "inserted" : "edited" };
  }

  enqueue(input.id);
  return { action: inserted ? "inserted" : "edited" };
}

/**
 * Mark a message deleted by ID only (used by reconcile, which has no live Message object).
 */
export async function ingestDeleteById(messageId: string): Promise<IngestResult> {
  const stored = getMessage(messageId);
  if (!stored) return { action: "skipped", reason: "not-in-db" };

  const effId = effectiveChannelId(stored);
  if (!isChannelAllowed(effId)) {
    return { action: "skipped", reason: "channel-not-allowlisted" };
  }

  const wasNew = markDeleted(messageId);
  if (!wasNew) return { action: "skipped", reason: "already-deleted-or-unknown" };

  const eligible =
    stored.classification === "operational" || stored.classification === "discussion";
  if (!eligible) return { action: "skipped", reason: "not-markdown-eligible" };

  const channel = getChannel(effId);
  if (!channel) return { action: "skipped", reason: "channel-config-missing" };
  appendBlock(channel, loadChannels().guild_id, stored, "delete");
  logger.info({ message_id: stored.id, channel_id: stored.channel_id }, "tombstone written");
  return { action: "edited" };
}

/**
 * Handle a delete/partial-delete event from the gateway.
 */
export async function ingestDelete(message: Message | PartialMessage): Promise<IngestResult> {
  if (!message.id) return { action: "skipped", reason: "no-id" };

  // For the allowlist check we need the effective channel; look it up from the DB
  // (the stored row has parent_channel_id set for thread messages).
  const stored = getMessage(message.id);
  const effId = stored ? effectiveChannelId(stored) : (message.channelId ?? "");

  if (!isChannelAllowed(effId)) {
    return { action: "skipped", reason: "channel-not-allowlisted" };
  }

  const wasNew = markDeleted(message.id);
  if (!wasNew) return { action: "skipped", reason: "already-deleted-or-unknown" };

  if (!stored) return { action: "skipped", reason: "not-in-db" };

  const eligible =
    stored.classification === "operational" || stored.classification === "discussion";
  if (!eligible) return { action: "skipped", reason: "not-markdown-eligible" };

  const channel = getChannel(effId);
  if (!channel) return { action: "skipped", reason: "channel-config-missing" };
  appendBlock(channel, loadChannels().guild_id, stored, "delete");
  logger.info({ message_id: stored.id, channel_id: stored.channel_id }, "tombstone written");
  return { action: "edited" };
}
