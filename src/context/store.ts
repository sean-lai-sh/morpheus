import { getChannel, loadChannels, loadEnv } from "../config.ts";
import { getDb } from "../storage/db.ts";
import {
  getMessage,
  type MessageRow,
} from "../storage/messages.ts";
import { requireNamespace, rowInScope } from "./namespace.ts";
import {
  channelIdsForNamespace,
  channelIdsForScope,
  channelIndexPath,
  indexPathForRow,
  messagePath,
  parseIndexPath,
  pathPrefixMatches,
  threadIndexPath,
} from "./paths.ts";
import { channelSlug } from "../storage/markdown.ts";
import type {
  ContextStore,
  IndexDocument,
  IndexNode,
  Namespace,
  PollPage,
  Scope,
  SearchHit,
  SearchQuery,
} from "./types.ts";

const SEARCH_LIMIT_MAX = 50;
const TREE_LIMIT = 100;
const WINDOW_LIMIT_MAX = 50;
const POLL_LIMIT_MAX = 50;

function permalinkFor(row: MessageRow): string {
  const guildId = loadEnv().DISCORD_GUILD_ID;
  return `https://discord.com/channels/${guildId}/${row.channel_id}/${row.id}`;
}

export function documentFromRow(row: MessageRow, namespace?: Namespace): IndexDocument {
  const ns = namespace ?? requireNamespace(row);
  return {
    id: row.id,
    namespace: ns,
    channelId: row.channel_id,
    parentChannelId: row.parent_channel_id,
    threadId: row.thread_id,
    threadName: row.thread_name,
    authorId: row.author_id,
    authorName: row.author_name,
    content: row.content,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    seq: row.seq,
    permalink: permalinkFor(row),
  };
}

function inClause(ids: string[]): { sql: string; params: string[] } {
  if (ids.length === 0) return { sql: "IN (NULL)", params: [] };
  return { sql: `IN (${ids.map(() => "?").join(", ")})`, params: ids };
}

function effectiveChannelSql(): string {
  return `COALESCE(parent_channel_id, channel_id)`;
}

function syncFtsRow(row: MessageRow): void {
  const db = getDb();
  const meta = db
    .query<{ rowid: number }, [string]>(`SELECT rowid AS rowid FROM messages WHERE id = ?`)
    .get(row.id);
  if (!meta) return;
  try {
    db.query(
      `INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', ?, ?)`,
    ).run(meta.rowid, row.content);
  } catch {
    // row may not be in FTS yet
  }
  if (row.deleted_at != null) return;
  db.query(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`).run(meta.rowid, row.content);
}

export function rebuildFts(): void {
  const db = getDb();
  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);
}

export function ftsCount(): number {
  return (
    getDb()
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM messages_fts`)
      .get()?.n ?? 0
  );
}

export function ingestFreshness(): { lastMessageAt: number | null; ftsCount: number } {
  const last = getDb()
    .query<{ ts: number | null }, []>(`SELECT MAX(created_at) AS ts FROM messages`)
    .get()?.ts ?? null;
  return { lastMessageAt: last, ftsCount: ftsCount() };
}

/** Function words that add nothing to bm25 and would starve an AND query. */
const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","been","before","but","by","can","did","do","does","for","from",
  "had","has","have","how","i","if","in","into","is","it","its","me","my","of","on","or","our","so",
  "that","the","their","them","then","there","these","they","this","to","us","was","we","were","what",
  "when","where","which","who","why","will","with","would","you","your","like","just","lol","pls","please",
]);

const MAX_QUERY_TOKENS = 32;

function bareTokens(raw: string): string[] {
  return raw
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Split a query into FTS5 phrase terms.
 * - `"exact phrase"` stays a quoted phrase (no stemming across it).
 * - Everything else becomes bare stemmed tokens with stopwords removed.
 * If stopword removal empties the query, the stopwords are kept (so `"what is it"` still matches something).
 */
export function ftsTerms(raw: string): string[] {
  const phrases: string[] = [];
  const rest = raw.replace(/"([^"]+)"/g, (_m, inner: string) => {
    const t = bareTokens(inner);
    if (t.length > 0) phrases.push(`"${t.join(" ")}"`);
    return " ";
  });
  const tokens = bareTokens(rest);
  let words = tokens.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  if (words.length === 0 && phrases.length === 0) words = tokens;
  return [...phrases, ...words.map((w) => `"${w}"`)].slice(0, MAX_QUERY_TOKENS);
}

/**
 * Strict (AND) FTS5 expression. Every term must match. Used for the precision pass,
 * and as the `query required` guard in HTTP.
 */
export function toFtsQuery(raw: string): string {
  return ftsTerms(raw).join(" AND ");
}

const LOOSE_MIN_TERMS = 3;
const LOOSE_MAX_TERMS = 8;

/**
 * Loose FTS5 expression for the recall pass: an OR of AND-pairs over the first
 * `LOOSE_MAX_TERMS` terms, so a hit must match at least two terms (a plain OR let
 * `zebra-unique-9` pull in anything containing "unique"). Quoted phrases are single
 * terms. Returns "" (no loose pass) when there are fewer than `LOOSE_MIN_TERMS`.
 */
export function toFtsQueryLoose(raw: string): string {
  const terms = ftsTerms(raw).slice(0, LOOSE_MAX_TERMS);
  if (terms.length < LOOSE_MIN_TERMS) return "";
  const pairs: string[] = [];
  for (let i = 0; i < terms.length; i++) {
    for (let j = i + 1; j < terms.length; j++) {
      pairs.push(`(${terms[i]} AND ${terms[j]})`);
    }
  }
  return pairs.join(" OR ");
}

/**
 * SQL-level restriction covered by a `pathPrefix`. Applied before the LIMIT so a
 * small channel — or a quiet thread — is not starved by a busy sibling.
 * `channelIds: null` means no restriction (`/`); `[]` means nothing can match
 * (unparseable or out-of-scope prefix).
 */
interface PrefixSqlFilter {
  channelIds: string[] | null;
  /** Set when the prefix names a thread (or a message inside one). */
  threadId: string | null;
  /** True for a `/…/threads` dir prefix: only thread messages can match. */
  threadsOnly: boolean;
  /** Set when the prefix names a single message. */
  messageId: string | null;
}

function sqlFilterForPathPrefix(prefix: string, scope: Scope): PrefixSqlFilter {
  const none: PrefixSqlFilter = { channelIds: [], threadId: null, threadsOnly: false, messageId: null };
  const parsed = parseIndexPath(prefix);
  if (!parsed) return none;
  if (parsed.kind === "root") return { ...none, channelIds: null };
  if (!scope.visible.has(parsed.namespace)) return none;
  if (parsed.kind === "namespace") {
    return { ...none, channelIds: channelIdsForNamespace(parsed.namespace) };
  }
  if (parsed.kind === "category") {
    return {
      ...none,
      channelIds: loadChannels()
        .channels.filter((c) => c.workspace === parsed.namespace && c.category === parsed.category)
        .map((c) => c.id),
    };
  }
  return {
    channelIds: [parsed.channel.id],
    threadId: parsed.kind === "thread" || parsed.kind === "message" ? parsed.threadId ?? null : null,
    threadsOnly: parsed.kind === "threadsDir",
    messageId: parsed.kind === "message" ? parsed.messageId : null,
  };
}

/**
 * Channel id or name → allowlisted id within `scope`. A name shared by two
 * visible channels is null (fail closed: no hits), never a silent first-match —
 * HTTP resolves names itself so it can 400 on ambiguity instead.
 */
function resolveChannelHint(scope: Scope, hint: string): string | null {
  const ids = new Set(channelIdsForScope(scope));
  const byId = getChannel(hint);
  if (byId && ids.has(byId.id)) return byId.id;
  const byName = loadChannels().channels.filter(
    (c) => ids.has(c.id) && c.name.toLowerCase() === hint.toLowerCase(),
  );
  if (byName.length !== 1) return null;
  return byName[0]?.id ?? null;
}

function index(doc: IndexDocument): void {
  const row = getMessage(doc.id);
  if (!row) {
    throw new Error(`index: missing messages row ${doc.id}`);
  }
  const ns = requireNamespace(row);
  if (doc.namespace !== ns) {
    throw new Error(`index: namespace mismatch for ${doc.id} (doc=${doc.namespace} row=${ns})`);
  }
  if (doc.channelId !== row.channel_id) {
    throw new Error(`index: channelId mismatch for ${doc.id}`);
  }
  if ((doc.parentChannelId ?? null) !== (row.parent_channel_id ?? null)) {
    throw new Error(`index: parentChannelId mismatch for ${doc.id}`);
  }
  syncFtsRow(row);
}

interface FtsHitRow extends MessageRow {
  snippet: string;
  rank: number;
}

const SNIPPET_TOKENS = 32;

function ftsRows(
  q: SearchQuery,
  ftsExpr: string,
  nsIds: string[],
  channelFilter: string | null,
  prefixFilter: PrefixSqlFilter | null,
  cap: number,
): FtsHitRow[] {
  const { sql: inSql, params: inParams } = inClause(nsIds);
  const params: (string | number)[] = [ftsExpr, ...inParams];
  let sql = `
    SELECT m.*, snippet(messages_fts, 0, '', '', '…', ${SNIPPET_TOKENS}) AS snippet, bm25(messages_fts) AS rank
    FROM messages_fts
    JOIN messages m ON m.rowid = messages_fts.rowid
    WHERE messages_fts MATCH ?
      AND ${effectiveChannelSql()} ${inSql}
  `;
  if (!q.includeDeleted) {
    sql += ` AND m.deleted_at IS NULL`;
  }
  if (channelFilter) {
    sql += ` AND (m.channel_id = ? OR m.parent_channel_id = ?)`;
    params.push(channelFilter, channelFilter);
  }
  if (q.threadId) {
    sql += ` AND m.thread_id = ?`;
    params.push(q.threadId);
  }
  // Prefix predicates beyond the channel ids, so a busy sibling thread (or the
  // parent channel itself) cannot fill the row cap before the target thread.
  if (prefixFilter?.threadId) {
    sql += ` AND m.thread_id = ?`;
    params.push(prefixFilter.threadId);
  }
  if (prefixFilter?.threadsOnly) {
    sql += ` AND m.thread_id IS NOT NULL`;
  }
  if (prefixFilter?.messageId) {
    sql += ` AND m.id = ?`;
    params.push(prefixFilter.messageId);
  }
  if (q.sinceMs != null) {
    sql += ` AND m.created_at >= ?`;
    params.push(q.sinceMs);
  }
  if (q.untilMs != null) {
    sql += ` AND m.created_at <= ?`;
    params.push(q.untilMs);
  }
  sql += ` ORDER BY rank ASC, CAST(m.id AS INTEGER) ASC LIMIT ?`;
  params.push(cap);
  return getDb().query<FtsHitRow, (string | number)[]>(sql).all(...params);
}

function linksForHits(ids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const { sql: inSql, params } = inClause(ids);
  const rows = getDb()
    .query<{ message_id: string; url: string }, string[]>(
      `SELECT message_id, url FROM links WHERE message_id ${inSql} ORDER BY link_id ASC`,
    )
    .all(...params);
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    list.push(r.url);
    out.set(r.message_id, list);
  }
  return out;
}

/**
 * Two passes: strict (every term) first, then loose (any two terms, bm25-ranked) to
 * fill up to `limit`. A natural-language question therefore degrades to its rarest
 * word pairs instead of returning nothing.
 */
function search(q: SearchQuery): SearchHit[] {
  const strict = toFtsQuery(q.query);
  if (!strict) return [];
  const limit = Math.min(Math.max(q.limit ?? 10, 1), SEARCH_LIMIT_MAX);
  let nsIds = channelIdsForScope(q.scope);
  if (nsIds.length === 0) return [];

  let channelFilter: string | null = null;
  if (q.channelHint) {
    channelFilter = resolveChannelHint(q.scope, q.channelHint);
    if (!channelFilter) return [];
  }

  const rawPrefix =
    q.pathPrefix && q.pathPrefix.endsWith("/") && q.pathPrefix.length > 1
      ? q.pathPrefix.slice(0, -1)
      : q.pathPrefix;
  // Sanitized `/` is a no-op prefix (every index path is under `/`); same as omitting it.
  const prefix = rawPrefix && rawPrefix !== "/" ? rawPrefix : undefined;
  let prefixFilter: PrefixSqlFilter | null = null;
  if (prefix) {
    prefixFilter = sqlFilterForPathPrefix(prefix, q.scope);
    if (prefixFilter.channelIds) {
      const allowed = new Set(prefixFilter.channelIds);
      nsIds = nsIds.filter((id) => allowed.has(id));
      if (nsIds.length === 0) return [];
    }
  }

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const collect = (rows: FtsHitRow[], match: SearchHit["match"]): void => {
    for (const row of rows) {
      if (hits.length >= limit) return;
      if (seen.has(row.id)) continue;
      if (!rowInScope(row, q.scope)) continue;
      const path = indexPathForRow(row);
      if (!path) continue;
      // SQL already pins `m.thread_id` for a thread (or in-thread message) prefix.
      // Do not re-drop on `thread_name` in the path: Discord rename leaves mixed
      // old/new names on the same id, and the other name would fill limit*4 (#65).
      if (prefix && !prefixFilter?.threadId && !pathPrefixMatches(path, prefix)) continue;
      seen.add(row.id);
      hits.push({
        id: row.id,
        score: row.rank,
        snippet: row.snippet || row.content.slice(0, 160),
        path,
        channelId: row.channel_id,
        parentChannelId: row.parent_channel_id,
        threadId: row.thread_id,
        authorName: row.author_name,
        createdAt: row.created_at,
        permalink: permalinkFor(row),
        links: [],
        match,
      });
    }
  };

  collect(ftsRows(q, strict, nsIds, channelFilter, prefixFilter, limit * 4), "strict");
  const loose = toFtsQueryLoose(q.query);
  if (hits.length < limit && loose && loose !== strict) {
    collect(ftsRows(q, loose, nsIds, channelFilter, prefixFilter, limit * 4), "loose");
  }

  const links = linksForHits(hits.map((h) => h.id));
  for (const h of hits) h.links = links.get(h.id) ?? [];
  return hits;
}

function readMessage(id: string, scope: Scope): IndexDocument | null {
  const row = getMessage(id);
  if (!row) return null;
  if (row.deleted_at != null) return null;
  if (!rowInScope(row, scope)) return null;
  return documentFromRow(row);
}

function redactDeletedContent(doc: IndexDocument): IndexDocument {
  if (doc.deletedAt == null) return doc;
  return { ...doc, content: "" };
}

function capNodes(nodes: IndexNode[]): IndexNode[] {
  return nodes.slice(0, TREE_LIMIT);
}

function listThreads(channelId: string): { threadId: string; threadName: string }[] {
  return getDb()
    .query<{ thread_id: string; thread_name: string }, [string, string]>(
      `SELECT thread_id, thread_name
       FROM messages
       WHERE (channel_id = ? OR parent_channel_id = ?)
         AND thread_id IS NOT NULL AND thread_name IS NOT NULL
       GROUP BY thread_id
       ORDER BY MIN(created_at) ASC`,
    )
    .all(channelId, channelId)
    .map((r) => ({ threadId: r.thread_id, threadName: r.thread_name }));
}

function listMainMessages(channelId: string): MessageRow[] {
  return getDb()
    .query<MessageRow, [string]>(
      `SELECT * FROM messages
       WHERE channel_id = ? AND parent_channel_id IS NULL AND thread_id IS NULL AND deleted_at IS NULL
       ORDER BY CAST(id AS INTEGER) ASC, created_at ASC
       LIMIT ${TREE_LIMIT}`,
    )
    .all(channelId);
}

function listThreadMessages(threadId: string): MessageRow[] {
  return getDb()
    .query<MessageRow, [string]>(
      `SELECT * FROM messages
       WHERE thread_id = ? AND deleted_at IS NULL
       ORDER BY CAST(id AS INTEGER) ASC, created_at ASC
       LIMIT ${TREE_LIMIT}`,
    )
    .all(threadId);
}

function tree(path: string, scope: Scope): IndexNode[] {
  const parsed = parseIndexPath(path);
  if (!parsed) return [];
  if (parsed.kind === "root") {
    return capNodes(
      [...scope.visible].sort().map((ns) => ({ path: `/${ns}`, kind: "dir" as const, name: ns })),
    );
  }
  if (!scope.visible.has(parsed.namespace)) return [];
  const namespace = parsed.namespace;
  if (parsed.kind === "namespace") {
    const channels = loadChannels().channels.filter((c) => c.workspace === namespace);
    const nodes: IndexNode[] = [];
    const seenCats = new Set<string>();
    for (const c of channels) {
      if (c.category && !seenCats.has(c.category)) {
        seenCats.add(c.category);
        nodes.push({
          path: `/${namespace}/${c.category}`,
          kind: "dir",
          name: c.category,
        });
      }
    }
    for (const c of channels) {
      if (c.category) continue;
      nodes.push({
        path: channelIndexPath(namespace, c),
        kind: "dir",
        name: channelSlug(c.name, c.id),
      });
    }
    return capNodes(nodes);
  }
  if (parsed.kind === "category") {
    const channels = loadChannels().channels.filter(
      (c) => c.workspace === namespace && c.category === parsed.category,
    );
    return capNodes(
      channels.map((c) => ({
        path: channelIndexPath(namespace, c),
        kind: "dir" as const,
        name: channelSlug(c.name, c.id),
      })),
    );
  }
  if (parsed.kind === "channel") {
    const nodes: IndexNode[] = [];
    const threads = listThreads(parsed.channel.id);
    if (threads.length > 0) {
      nodes.push({
        path: `${channelIndexPath(namespace, parsed.channel)}/threads`,
        kind: "dir",
        name: "threads",
      });
    }
    for (const row of listMainMessages(parsed.channel.id)) {
      if (!rowInScope(row, scope)) continue;
      nodes.push({
        path: messagePath(namespace, parsed.channel, row),
        kind: "doc",
        name: row.id,
      });
    }
    return capNodes(nodes);
  }
  if (parsed.kind === "threadsDir") {
    const threads = listThreads(parsed.channel.id);
    return capNodes(
      threads.map((t) => ({
        path: threadIndexPath(namespace, parsed.channel, t.threadName, t.threadId),
        kind: "dir" as const,
        name: channelSlug(t.threadName, t.threadId),
      })),
    );
  }
  if (parsed.kind === "thread") {
    const nodes: IndexNode[] = [];
    for (const row of listThreadMessages(parsed.threadId)) {
      if (!rowInScope(row, scope)) continue;
      nodes.push({
        path: messagePath(namespace, parsed.channel, row),
        kind: "doc",
        name: row.id,
      });
    }
    return capNodes(nodes);
  }
  if (parsed.kind === "message") {
    const row = getMessage(parsed.messageId);
    if (!row || !rowInScope(row, scope)) return [];
    return [
      {
        path: messagePath(namespace, parsed.channel, row),
        kind: "doc",
        name: row.id,
      },
    ];
  }
  return [];
}

function readChannelWindow(opts: {
  scope: Scope;
  channelId: string;
  afterId?: string;
  beforeId?: string;
  limit?: number;
}): IndexDocument[] {
  const channel = getChannel(opts.channelId);
  if (!channel) return [];
  if (!opts.scope.visible.has(channel.workspace)) return [];

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), WINDOW_LIMIT_MAX);
  const params: string[] = [opts.channelId, opts.channelId];
  let sql = `
    SELECT * FROM messages
    WHERE (channel_id = ? OR parent_channel_id = ?)
      AND deleted_at IS NULL
  `;
  if (opts.afterId) {
    sql += ` AND CAST(id AS INTEGER) > CAST(? AS INTEGER)`;
    params.push(opts.afterId);
  }
  if (opts.beforeId) {
    sql += ` AND CAST(id AS INTEGER) < CAST(? AS INTEGER)`;
    params.push(opts.beforeId);
  }
  sql += ` ORDER BY CAST(id AS INTEGER) ASC, created_at ASC LIMIT ?`;
  const rows = getDb()
    .query<MessageRow, (string | number)[]>(sql)
    .all(...params, limit);
  return rows.filter((r) => rowInScope(r, opts.scope)).map((r) => documentFromRow(r));
}

function readPath(
  path: string,
  scope: Scope,
): IndexDocument | IndexDocument[] | IndexNode[] | null {
  const parsed = parseIndexPath(path);
  if (!parsed) return null;
  if (parsed.kind === "root") return tree(path, scope);
  if (!scope.visible.has(parsed.namespace)) return null;
  if (parsed.kind === "namespace" || parsed.kind === "category" || parsed.kind === "threadsDir") {
    return tree(path, scope);
  }
  if (parsed.kind === "channel") {
    return readChannelWindow({ scope, channelId: parsed.channel.id });
  }
  if (parsed.kind === "thread") {
    const rows = listThreadMessages(parsed.threadId).filter((r) => rowInScope(r, scope));
    return rows.map((r) => documentFromRow(r));
  }
  if (parsed.kind === "message") {
    return readMessage(parsed.messageId, scope);
  }
  return null;
}

function parseCursor(cursor: string): { seq: number; id: string } | null {
  const i = cursor.indexOf(":");
  if (i <= 0) return null;
  const seq = Number(cursor.slice(0, i));
  const id = cursor.slice(i + 1);
  if (!Number.isInteger(seq) || seq < 0 || id.length === 0) return null;
  return { seq, id };
}

function poll(scope: Scope, cursor: string | null, limit = 20): PollPage {
  const cap = Math.min(Math.max(limit, 1), POLL_LIMIT_MAX);
  const nsIds = channelIdsForScope(scope);
  if (nsIds.length === 0) return { cursor: cursor ?? "0:0", documents: [] };
  const { sql: inSql, params: inParams } = inClause(nsIds);

  const params: (string | number)[] = [...inParams];
  let sql = `
    SELECT * FROM messages
    WHERE ${effectiveChannelSql()} ${inSql}
  `;
  if (cursor) {
    const parsed = parseCursor(cursor);
    if (!parsed) return { cursor, documents: [] };
    sql += ` AND (seq > ? OR (seq = ? AND CAST(id AS INTEGER) > CAST(? AS INTEGER)))`;
    params.push(parsed.seq, parsed.seq, parsed.id);
  }
  sql += ` ORDER BY seq ASC, CAST(id AS INTEGER) ASC LIMIT ?`;
  params.push(cap);

  const rows = getDb()
    .query<MessageRow, (string | number)[]>(sql)
    .all(...params)
    .filter((r) => rowInScope(r, scope));
  const documents = rows.map((r) => redactDeletedContent(documentFromRow(r)));
  const last = documents[documents.length - 1];
  const nextCursor = last ? `${last.seq}:${last.id}` : (cursor ?? "0:0");
  return { cursor: nextCursor, documents };
}

export const contextStore: ContextStore = {
  index,
  search,
  readMessage,
  readPath,
  tree,
  readChannelWindow,
  poll,
};

export function indexFromRow(row: MessageRow): void {
  const ns = requireNamespace(row);
  contextStore.index(documentFromRow(row, ns));
}
