export type Namespace = "general" | "leadership";

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
  namespace: Namespace;
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
  readMessage(id: string, namespace: Namespace): IndexDocument | null;
  readPath(path: string, namespace: Namespace): IndexDocument | IndexDocument[] | IndexNode[] | null;
  tree(path: string, namespace: Namespace): IndexNode[];
  readChannelWindow(opts: {
    namespace: Namespace;
    /** Parent/allowlisted text channel id (effectiveChannelId). Includes threads. */
    channelId: string;
    afterId?: string;
    beforeId?: string;
    limit?: number;
  }): IndexDocument[];
  poll(namespace: Namespace, cursor: string | null, limit?: number): PollPage;
}
