/**
 * Shared ingest pipeline used by both live events and backfill/reconcile.
 *
 * Flow per message:
 *   1. Hard pre-filter (drop bots, drop trivially-small messages, etc.)
 *   2. Upsert into SQLite (source of truth)
 *   3. Extract + persist GDrive links
 *   4. Mark operational, write local markdown, index into ContextStore FTS
 *
 * Thread messages: pass parentChannelId when the message is in a thread of an
 * allowed channel that has include_threads:true. The message is stored under its
 * own thread channel_id in SQLite but uses the parent's config for markdown output.
 * threadName is the human-readable thread channel name.
 */
import type { Message, PartialMessage } from "discord.js";
import { getChannel, isChannelAllowed, loadEnv } from "../config.ts";
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
  type MessageRow,
} from "../storage/messages.ts";
import { getDisplayName, upsertUser } from "../storage/users.ts";
import { indexFromRow } from "../context/store.ts";
import { namespaceForRow } from "../context/namespace.ts";

// Matches a string that is nothing but a bare media URL (gif, image, video).
// If there's any surrounding text, the message goes through normally.
const PURE_MEDIA_URL =
  /^https?:\/\/\S+\.(?:gif|png|jpg|jpeg|webp|mp4|mov|tenor\.com\/\S+|giphy\.com\/\S+)$/i;

function hardFilterReason(message: Message | PartialMessage): string | null {
  if (message.author?.bot) return "bot-author";
  const content = (message.content ?? "").trim();
  // Allow short messages if they include a GDrive URL — the URL is the signal.
  const stripped = content.replace(/<@!?\d+>|<@&\d+>|<#\d+>|<a?:[a-zA-Z0-9_]+:\d+>/g, "").trim();
  const hasGdrive = /\b(drive|docs|sheets|slides|forms)\.google\.com\//i.test(content);
  if (!hasGdrive && stripped.length < 6) return "too-short";
  if (PURE_MEDIA_URL.test(content)) return "pure-media";
  return null;
}

function authorName(message: Message | PartialMessage, userId?: string): string {
  const member = message.member;
  if (member?.displayName) return member.displayName;
  // Fall back to users table for display name when member cache is cold (e.g. backfill).
  if (userId) {
    const cached = getDisplayName(userId);
    if (cached) return cached;
  }
  if (message.author?.globalName) return message.author.globalName;
  if (message.author?.username) return message.author.username;
  return message.author?.id ?? "unknown";
}

function fetchedToInput(
  message: Message,
  parentChannelId?: string | null,
  threadName?: string | null,
): {
  id: string;
  channelId: string;
  parentChannelId: string | null;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;
  editedAt: number | null;
  threadId: string | null;
  threadName: string | null;
} {
  const userId = message.author?.id;
  const threadId = parentChannelId ? message.channelId : null;
  return {
    id: message.id,
    channelId: message.channelId,
    parentChannelId: parentChannelId ?? null,
    authorId: userId ?? "unknown",
    authorName: authorName(message, userId),
    content: message.content ?? "",
    createdAt: message.createdTimestamp,
    editedAt: message.editedTimestamp ?? null,
    threadId,
    threadName: threadId ? (threadName ?? null) : null,
  };
}

function tryIndex(row: MessageRow): void {
  if (namespaceForRow(row) == null) {
    logger.error(
      {
        message_id: row.id,
        channel_id: row.channel_id,
        parent_channel_id: row.parent_channel_id,
      },
      "refusing to index: namespaceForRow returned null",
    );
    return;
  }
  try {
    indexFromRow(row);
  } catch (err) {
    logger.error({ err, message_id: row.id }, "context index failed");
  }
}

export interface IngestResult {
  action: "inserted" | "edited" | "skipped" | "dropped";
  reason?: string;
}

/**
 * Ingest a message. For thread messages, pass parentChannelId (the parent text
 * channel's id) and threadName (the thread channel's display name).
 *
 * `updateCrawlCursors` defaults true. Reconcile's thread pass sets it false so
 * archived thread snowflakes cannot rewind an in-progress parent backfill cursor.
 */
export async function ingestMessage(
  message: Message,
  parentChannelId?: string | null,
  threadName?: string | null,
  opts?: { updateCrawlCursors?: boolean },
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

  const input = fetchedToInput(message, parentChannelId, threadName);
  const { inserted, edited } = upsertMessage(input);

  // Cache user display name whenever the guild member is available.
  if (message.author?.id && message.member) {
    upsertUser(
      message.author.id,
      message.author.username ?? null,
      message.member.nickname ?? null,
      message.author.globalName ?? null,
    );
  }

  // Crawl cursors track under the effective (config) channel id.
  if (opts?.updateCrawlCursors !== false) {
    setOldestSeen(configChannelId, input.id);
    setNewestSeen(configChannelId, input.id);
  }

  const links = extractLinks(input.content);
  if (edited) removeLinksNotIn(input.id, links.map((l) => l.url));
  persistLinks(input.id, input.channelId, links, input.createdAt);

  if (!inserted && !edited) return { action: "skipped", reason: "no-change" };

  const channel = getChannel(configChannelId);
  if (!channel) return { action: "skipped", reason: "channel-config-missing" };

  // All messages are marked operational; ContextStore FTS is the retrieval path.
  setClassification(input.id, "operational", 1.0);
  const guildId = loadEnv().DISCORD_GUILD_ID;
  const fresh = getMessage(input.id);
  if (fresh) {
    appendBlock(channel, guildId, fresh, inserted ? "create" : "edit");
    tryIndex(fresh);
  }
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

  const channel = getChannel(effId);
  if (!channel) return { action: "skipped", reason: "channel-config-missing" };

  const wasNew = markDeleted(messageId);
  if (!wasNew) return { action: "skipped", reason: "already-deleted-or-unknown" };

  appendBlock(channel, loadEnv().DISCORD_GUILD_ID, stored, "delete");
  const fresh = getMessage(messageId);
  if (fresh) tryIndex(fresh);
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

  const channel = getChannel(effId);
  if (!channel) return { action: "skipped", reason: "channel-config-missing" };
  appendBlock(channel, loadEnv().DISCORD_GUILD_ID, stored, "delete");
  const fresh = getMessage(message.id);
  if (fresh) tryIndex(fresh);
  logger.info({ message_id: stored.id, channel_id: stored.channel_id }, "tombstone written");
  return { action: "edited" };
}
