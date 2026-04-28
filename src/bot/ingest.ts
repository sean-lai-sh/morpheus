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
 * For Part 1 step 4 (Discord client wiring), classifier is bypassed —
 * everything markdown-eligible is treated as operational so we can verify
 * the end-to-end pipeline before NIM is in place. The bypass is gated by
 * BYPASS_CLASSIFIER (set in src/index.ts based on the run subcommand).
 */
import type { Message, PartialMessage } from "discord.js";
import { getChannel, isChannelAllowed, loadChannels } from "../config.ts";
import { logger } from "../logger.ts";
import { setOldestSeen, setNewestSeen } from "../storage/crawl-state.ts";
import { extractLinks, persistLinks } from "../storage/links.ts";
import { appendBlock } from "../storage/markdown.ts";
import {
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
  // Prefer guild nickname, fall back to global username, fall back to id.
  const member = message.member;
  if (member?.displayName) return member.displayName;
  if (message.author?.username) return message.author.username;
  if (message.author?.globalName) return message.author.globalName;
  return message.author?.id ?? "unknown";
}

function fetchedToInput(message: Message): {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;
  editedAt: number | null;
} {
  return {
    id: message.id,
    channelId: message.channelId,
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

export async function ingestMessage(message: Message): Promise<IngestResult> {
  if (!isChannelAllowed(message.channelId)) {
    return { action: "skipped", reason: "channel-not-allowlisted" };
  }
  const dropReason = hardFilterReason(message);
  if (dropReason) return { action: "dropped", reason: dropReason };

  const input = fetchedToInput(message);
  const { inserted, edited } = upsertMessage(input);

  // Always update crawl cursors (even on edits — newest_seen tracks any seen id).
  setOldestSeen(input.channelId, input.id);
  setNewestSeen(input.channelId, input.id);

  // Link extraction is idempotent (UNIQUE constraint).
  const links = extractLinks(input.content);
  persistLinks(input.id, input.channelId, links, input.createdAt);

  if (!inserted && !edited) return { action: "skipped", reason: "no-change" };

  const channel = getChannel(input.channelId);
  if (!channel) return { action: "skipped", reason: "channel-config-missing" };

  // Classifier routing
  if (!channel.classify || bypassClassifier) {
    // Mark as operational deterministically; render markdown immediately.
    setClassification(input.id, "operational", 1.0);
    const guildId = loadChannels().guild_id;
    const fresh = getMessage(input.id);
    if (fresh) {
      appendBlock(channel, guildId, fresh, inserted ? "create" : "edit");
    }
    return { action: inserted ? "inserted" : "edited" };
  }

  // Classifier-on path: enqueue and let the worker render later.
  enqueue(input.id);
  return { action: inserted ? "inserted" : "edited" };
}

/**
 * Handle a delete/partial-delete event. Mark in SQLite + append tombstone if
 * the message had previously been written to markdown.
 */
export async function ingestDelete(message: Message | PartialMessage): Promise<IngestResult> {
  if (!message.id) return { action: "skipped", reason: "no-id" };
  if (!isChannelAllowed(message.channelId ?? "")) {
    return { action: "skipped", reason: "channel-not-allowlisted" };
  }

  const wasNew = markDeleted(message.id);
  if (!wasNew) return { action: "skipped", reason: "already-deleted-or-unknown" };

  const stored = getMessage(message.id);
  if (!stored) return { action: "skipped", reason: "not-in-db" };

  // Only emit a tombstone if the message was eligible for markdown
  const eligible =
    stored.classification === "operational" || stored.classification === "discussion";
  if (!eligible) return { action: "skipped", reason: "not-markdown-eligible" };

  const channel = getChannel(stored.channel_id);
  if (!channel) return { action: "skipped", reason: "channel-config-missing" };
  appendBlock(channel, loadChannels().guild_id, stored, "delete");
  logger.info({ message_id: stored.id, channel_id: stored.channel_id }, "tombstone written");
  return { action: "edited" };
}
