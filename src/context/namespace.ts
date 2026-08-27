import { getChannel } from "../config.ts";
import { effectiveChannelId, type MessageRow } from "../storage/messages.ts";
import type { Namespace } from "./types.ts";

/**
 * Namespace for a stored row. Uses the parent/allowlisted channel
 * (`effectiveChannelId`), never the thread's own id.
 *
 * Returns null when the parent is not in `channels.yml`. Callers must hard-fail
 * on null — do not treat unknown ids as `general` (thread ids are never listed,
 * so a leadership thread would leak).
 */
export function namespaceForRow(row: MessageRow): Namespace | null {
  const parentId = effectiveChannelId(row);
  const channel = getChannel(parentId);
  if (!channel) return null;
  return channel.isolated ? "leadership" : "general";
}

/** Throws if the row cannot be attributed to an allowlisted channel. */
export function requireNamespace(row: MessageRow): Namespace {
  const ns = namespaceForRow(row);
  if (ns == null) {
    throw new Error(
      `namespaceForRow: unknown channel for message ${row.id} (effectiveChannelId=${effectiveChannelId(row)})`,
    );
  }
  return ns;
}
