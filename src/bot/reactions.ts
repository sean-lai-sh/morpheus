import type { MessageReaction, PartialMessageReaction, User, PartialUser } from "discord.js";
import { getChannel, isChannelAllowed, loadEnv } from "../config.ts";
import { logger } from "../logger.ts";
import { appendBlock } from "../storage/markdown.ts";
import {
  effectiveChannelId,
  getMessage,
  reactionCounts,
  setReactions,
  type ReactionMap,
} from "../storage/messages.ts";

/**
 * Discord's reaction user list, paginated (API max 100 / page).
 * Used by the full-reconcile path in `handleReactionChange`.
 */
export async function fetchReactorIds(
  reaction: Pick<MessageReaction, "users">,
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (;;) {
    const batch = await reaction.users.fetch(after ? { limit: 100, after } : { limit: 100 });
    if (batch.size === 0) break;
    let last: string | undefined;
    for (const id of batch.keys()) {
      ids.push(id);
      last = id;
    }
    if (batch.size < 100 || !last) break;
    after = last;
  }
  return ids;
}

/**
 * Persist the current emoji → {count, users} map for an allowlisted message.
 *
 * Full reconcile (not incremental add/remove of `_user`): each event fetches
 * every emoji's current reactor list from Discord. Concurrent add/remove and
 * uncached reactors would race an incremental patch; `users.fetch()` is the
 * source of truth for who currently has the reaction.
 */
export async function handleReactionChange(
  reaction: MessageReaction | PartialMessageReaction,
  _user: User | PartialUser,
): Promise<void> {
  const full = reaction.partial ? await reaction.fetch() : reaction;
  const message = full.message.partial ? await full.message.fetch() : full.message;

  // For thread messages, message.channelId is the thread id (not in channels.yml).
  // Look up the stored row first so we can use effectiveChannelId for the allowlist check.
  const stored = getMessage(message.id);
  const lookupChannelId = stored ? effectiveChannelId(stored) : message.channelId;
  if (!isChannelAllowed(lookupChannelId)) return;

  const map: ReactionMap = {};
  for (const [, r] of message.reactions.cache) {
    const name = r.emoji.name;
    if (!name) continue;
    const users = await fetchReactorIds(r);
    const count = r.count ?? users.length;
    if (count <= 0 && users.length === 0) continue;
    map[name] = { count, users };
  }

  setReactions(message.id, map);

  // Re-read so markdown sees the just-written reactions JSON, not the stale row.
  const updated = getMessage(message.id);
  if (!updated) return;
  const channel = getChannel(effectiveChannelId(updated));
  if (!channel) return;
  appendBlock(channel, loadEnv().DISCORD_GUILD_ID, updated, "edit");
  logger.debug({ message_id: message.id, reactions: reactionCounts(map) }, "reactions updated");
}
