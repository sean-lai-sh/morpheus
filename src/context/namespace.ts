import { getChannel, getWorkspace, visibleWorkspaces, type Channel } from "../config.ts";
import { effectiveChannelId, type MessageRow } from "../storage/messages.ts";
import type { Namespace, Scope } from "./types.ts";

/** Minimal row shape needed to attribute a message to a workspace. */
export type RowRef = Pick<MessageRow, "channel_id" | "parent_channel_id">;

/**
 * What a `ChannelResolver` must return. `workspace` is the only required field —
 * it is the access boundary. The optional `id`/`name`/`category` let callers that
 * build index paths (jobs first-pass snippets) do so without re-reading
 * channels.yml; when they are absent the caller falls back to `getChannel`.
 */
export type ResolvedChannel = Pick<Channel, "workspace"> &
  Partial<Pick<Channel, "include_threads" | "name" | "category" | "id">>;

/** Channel lookup. Tests inject a Map; production uses `getChannel`. */
export type ChannelResolver = (channelId: string) => ResolvedChannel | undefined;

/**
 * Workspace for a stored row. Uses the parent/allowlisted channel
 * (`effectiveChannelId`), never the thread's own id.
 *
 * Returns null when the parent is not in `channels.yml`. Callers must hard-fail
 * on null — do not treat unknown ids as any default workspace (thread ids are
 * never listed, so a hidden thread would leak).
 */
export function namespaceForRow(row: RowRef, resolveChannel: ChannelResolver = getChannel): Namespace | null {
  const parentId = effectiveChannelId(row as MessageRow);
  const channel = resolveChannel(parentId);
  if (!channel) return null;
  return channel.workspace;
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

/** The only producer of `Scope`. Unknown workspace → null (no access). */
export function scopeFor(root: Namespace): Scope | null {
  if (!getWorkspace(root)) return null;
  return { root, visible: visibleWorkspaces(root) };
}

/** True iff the row's workspace is visible from `scope`. Unknown channel → false. */
export function rowInScope(row: RowRef, scope: Scope, resolveChannel: ChannelResolver = getChannel): boolean {
  const ns = namespaceForRow(row, resolveChannel);
  return ns != null && scope.visible.has(ns);
}
