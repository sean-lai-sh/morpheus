/** Workspace id from `channels.yml` (`workspaces:`). Plain string: the access boundary is `Scope.visible`. */
export type Namespace = string;

/**
 * Access scope derived from a token or a job's originating channel.
 * `visible` = root workspace plus every transitive descendant. Produce only via `scopeFor()`.
 */
export interface Scope {
  root: Namespace;
  visible: ReadonlySet<Namespace>;
}

export interface IndexDocument {
  id: string;
  namespace: Namespace;
  /** messages.channel_id — the thread id for thread messages, NOT the parent. */
  channelId: string;
  /** messages.parent_channel_id — parent text channel, or null. */
  parentChannelId: string | null;
  threadId: string | null;
  threadName: string | null;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  /** Monotonic ingest seq; bumped on upsert / edit / delete / reactions. Poll cursor. */
  seq: number;
  /** https://discord.com/channels/{guild}/{channelId}/{id} using row channel_id */
  permalink: string;
}

export interface SearchQuery {
  query: string;
  /** REQUIRED in-process. HTTP derives this from the token. */
  scope: Scope;
  pathPrefix?: string;
  channelHint?: string;
  threadId?: string;
  sinceMs?: number;
  untilMs?: number;
  /** default false; HTTP must reject true */
  includeDeleted?: boolean;
  /** 1..50, default 10 */
  limit?: number;
}

export interface SearchHit {
  id: string;
  score: number;
  snippet: string;
  path: string;
  channelId: string;
  parentChannelId: string | null;
  threadId: string | null;
  authorName: string;
  createdAt: number;
  permalink: string;
}

export interface PollPage {
  /** opaque `${seq}:${id}` — NOT created_at */
  cursor: string;
  documents: IndexDocument[];
}

export interface IndexNode {
  path: string;
  kind: "dir" | "doc";
  name: string;
}

export interface ContextStore {
  index(doc: IndexDocument): void;
  search(q: SearchQuery): SearchHit[];
  readMessage(id: string, scope: Scope): IndexDocument | null;
  readPath(path: string, scope: Scope): IndexDocument | IndexDocument[] | IndexNode[] | null;
  tree(path: string, scope: Scope): IndexNode[];
  readChannelWindow(opts: {
    scope: Scope;
    /** Parent/allowlisted text channel id (effectiveChannelId). Includes threads. */
    channelId: string;
    afterId?: string;
    beforeId?: string;
    limit?: number;
  }): IndexDocument[];
  poll(scope: Scope, cursor: string | null, limit?: number): PollPage;
}
