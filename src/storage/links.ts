import { getDb } from "./db.ts";

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
    const kind = HOST_TO_KIND[host];
    if (!kind) continue;
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

export function linksForMessage(messageId: string): LinkRow[] {
  return getDb()
    .query<LinkRow, [string]>(
      `SELECT * FROM links WHERE message_id = ? ORDER BY link_id ASC`,
    )
    .all(messageId);
}
