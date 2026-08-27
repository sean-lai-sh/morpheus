import { getDb } from "./db.ts";
import type { MessageRow } from "./messages.ts";

export type LinkKind = "drive" | "docs" | "sheets" | "slides" | "forms";

export interface LinkRow {
  link_id: number;
  message_id: string;
  channel_id: string;
  url: string;
  kind: LinkKind;
  file_id: string | null;
  first_seen_at: number;
}

export interface ExtractedLink {
  url: string;
  kind: LinkKind;
  fileId: string | null;
}

const URL_REGEX = /\bhttps?:\/\/(?:drive|docs|sheets|slides|forms)\.google\.com\/[^\s)>\]]+/gi;

const HOST_TO_KIND: Record<string, LinkKind> = {
  "drive.google.com": "drive",
  "docs.google.com": "docs",
  "sheets.google.com": "sheets",
  "slides.google.com": "slides",
  "forms.google.com": "forms",
};

function extractFileId(url: string): string | null {
  // Common patterns:
  //   /document/d/<ID>/...        (docs.google.com)
  //   /spreadsheets/d/<ID>/...    (docs.google.com or sheets.google.com)
  //   /presentation/d/<ID>/...    (docs/slides)
  //   /forms/d/<ID>/...           (forms)
  //   /file/d/<ID>/view           (drive)
  //   /open?id=<ID>               (drive)
  //   /uc?id=<ID>                 (drive)
  const dMatch = url.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  if (dMatch) return dMatch[1] ?? null;
  const idMatch = url.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (idMatch) return idMatch[1] ?? null;
  return null;
}

/**
 * docs.google.com hosts every editor product; the path decides which one.
 * Only called for docs.google.com — drive.google.com stays "drive".
 */
function refineDocsKind(url: string, fallback: LinkKind): LinkKind {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return fallback;
  }
  if (path.startsWith("/spreadsheets/")) return "sheets";
  if (path.startsWith("/presentation/")) return "slides";
  if (path.startsWith("/forms/")) return "forms";
  if (path.startsWith("/document/")) return "docs";
  return fallback;
}

/**
 * SQL expression normalizing `kind` for rows persisted before path-based
 * classification existed (canonical docs.google.com/spreadsheets|presentation|forms
 * URLs were stored as "docs").
 */
const KIND_SQL = `CASE
  WHEN l.url LIKE 'https://docs.google.com/spreadsheets/%' THEN 'sheets'
  WHEN l.url LIKE 'https://docs.google.com/presentation/%' THEN 'slides'
  WHEN l.url LIKE 'https://docs.google.com/forms/%' THEN 'forms'
  ELSE l.kind
END`;

export function extractLinks(content: string): ExtractedLink[] {
  const matches = content.match(URL_REGEX);
  if (!matches) return [];
  const seen = new Set<string>();
  const out: ExtractedLink[] = [];
  for (const raw of matches) {
    // Strip trailing punctuation that can't legitimately end a URL.
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    let kind = HOST_TO_KIND[host];
    if (!kind) continue;
    if (host === "docs.google.com") kind = refineDocsKind(url, kind);
    out.push({ url, kind, fileId: extractFileId(url) });
  }
  return out;
}

export function persistLinks(
  messageId: string,
  channelId: string,
  links: ExtractedLink[],
  firstSeenAt: number = Date.now(),
): void {
  if (links.length === 0) return;
  const db = getDb();
  const stmt = db.query(
    `INSERT INTO links (message_id, channel_id, url, kind, file_id, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id, url) DO NOTHING`,
  );
  const tx = db.transaction((rows: ExtractedLink[]) => {
    for (const l of rows) stmt.run(messageId, channelId, l.url, l.kind, l.fileId, firstSeenAt);
  });
  tx(links);
}

export function removeLinksNotIn(messageId: string, currentUrls: string[]): void {
  const db = getDb();
  if (currentUrls.length === 0) {
    db.query(`DELETE FROM links WHERE message_id = ?`).run(messageId);
    return;
  }
  const placeholders = currentUrls.map(() => "?").join(", ");
  db.query(`DELETE FROM links WHERE message_id = ? AND url NOT IN (${placeholders})`).run(
    messageId,
    ...currentUrls,
  );
}

export function linksForMessage(messageId: string): LinkRow[] {
  return getDb()
    .query<LinkRow, [string]>(
      `SELECT * FROM links WHERE message_id = ? ORDER BY link_id ASC`,
    )
    .all(messageId);
}

export const LINK_KINDS: readonly LinkKind[] = ["drive", "docs", "sheets", "slides", "forms"];

export function isLinkKind(v: string): v is LinkKind {
  return (LINK_KINDS as readonly string[]).includes(v);
}

export interface LinkQuery {
  /** Allowlisted parent channel ids; matched against COALESCE(parent_channel_id, channel_id). */
  channelIds: string[];
  kind?: LinkKind;
  /**
   * Inclusive bounds on the message's posted time (messages.created_at, ms epoch) —
   * NOT links.first_seen_at, which is ingest time and diverges on backfill.
   */
  sinceMs?: number;
  untilMs?: number;
  /** Restrict to one parent channel (matches the channel itself or threads under it). */
  channelId?: string;
  /** Row cap after dedupe by file_id (or url); callers still post-filter by scope. */
  limit: number;
}

/** A link joined with its (non-deleted) message row. Ordered newest first by posted time. */
export type LinkWithMessage = LinkRow & { message: MessageRow };

/**
 * Links whose message lives in one of `channelIds` (by effective/parent channel,
 * never `links.channel_id`, which holds the thread id for thread messages).
 * Deleted messages are always excluded. Time semantics are posted-at
 * (messages.created_at) throughout: since/until bounds, newest-first ordering,
 * and which duplicate wins. Rows are deduped by file_id (falling back to url)
 * keeping the newest, *before* `limit` is applied, so a frequently reshared
 * file cannot crowd out older unique files. Callers must still post-filter
 * with `rowInScope` and map to an index path.
 */
export function queryLinks(q: LinkQuery): LinkWithMessage[] {
  if (q.channelIds.length === 0) return [];
  const params: (string | number)[] = [...q.channelIds];
  let where = `
    WHERE COALESCE(m.parent_channel_id, m.channel_id) IN (${q.channelIds.map(() => "?").join(", ")})
      AND m.deleted_at IS NULL`;
  if (q.kind) {
    where += ` AND ${KIND_SQL} = ?`;
    params.push(q.kind);
  }
  if (q.sinceMs != null) {
    where += ` AND m.created_at >= ?`;
    params.push(q.sinceMs);
  }
  if (q.untilMs != null) {
    where += ` AND m.created_at <= ?`;
    params.push(q.untilMs);
  }
  if (q.channelId) {
    where += ` AND (m.channel_id = ? OR m.parent_channel_id = ?)`;
    params.push(q.channelId, q.channelId);
  }
  const sql = `
    SELECT * FROM (
      SELECT l.link_id, l.message_id, l.url, l.file_id, l.first_seen_at,
             ${KIND_SQL} AS kind,
             l.channel_id AS link_channel_id,
             m.*,
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(l.file_id, l.url)
               ORDER BY m.created_at DESC, l.link_id DESC
             ) AS rn
      FROM links l
      JOIN messages m ON m.id = l.message_id${where}
    )
    WHERE rn = 1
    ORDER BY created_at DESC, link_id DESC
    LIMIT ?`;
  params.push(q.limit);
  type Raw = MessageRow & {
    link_id: number;
    message_id: string;
    link_channel_id: string;
    url: string;
    kind: LinkKind;
    file_id: string | null;
    first_seen_at: number;
    rn: number;
  };
  const rows = getDb().query<Raw, (string | number)[]>(sql).all(...params);
  return rows.map((r) => {
    const { link_id, message_id, link_channel_id, url, kind, file_id, first_seen_at, rn: _rn, ...message } = r;
    return { link_id, message_id, channel_id: link_channel_id, url, kind, file_id, first_seen_at, message: message as MessageRow };
  });
}
