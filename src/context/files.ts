import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { channelFilePath, discordDir, threadFilePath } from "../storage/markdown.ts";
import { parseIndexPath, sanitizeIndexPath } from "./paths.ts";
import type { Scope } from "./types.ts";

/**
 * Raw markdown retrieval (#49 follow-up).
 *
 * The crawler already writes one `.md` per channel (`main.md`) and one per
 * thread (`threads/<slug>.md`). Those files ARE the index — an agent that can
 * read them needs no document-window API to reconstruct. This module maps an
 * index path onto the file that backs it, under the same workspace boundary
 * every other `/v1` read obeys.
 *
 * Only `channel` and `thread` paths have a backing file. Root/namespace/
 * category/threadsDir are directories (use `tree`), and a single message is a
 * block inside a file, not a file (use `/v1/messages/:id`).
 */

export interface RawFileRef {
  /** Absolute path on this box. Always inside `data/discord/`. */
  absPath: string;
  /** Suggested download name, e.g. `eboard-chat-2814.md`. */
  fileName: string;
  /** The sanitized index path this resolved from. */
  indexPath: string;
  size: number;
  mtimeMs: number;
}

/**
 * Resolve an index path to its backing `.md`, or null.
 *
 * Null covers every refusal — unparseable path, workspace outside the scope,
 * a kind with no backing file, an escape attempt, or a file the crawler has
 * not written yet — so a caller can map the whole set to one 404 and leak
 * nothing about which of those it was.
 */
export function rawFilePathFor(rawPath: string, scope: Scope): RawFileRef | null {
  const sanitized = sanitizeIndexPath(rawPath);
  if (sanitized == null) return null;

  let parsed: ReturnType<typeof parseIndexPath>;
  try {
    parsed = parseIndexPath(sanitized);
  } catch {
    return null;
  }
  if (!parsed) return null;
  if (parsed.kind !== "channel" && parsed.kind !== "thread") return null;
  // The workspace boundary, same predicate the document reads use.
  if (!scope.visible.has(parsed.namespace)) return null;

  const key = {
    id: parsed.channel.id,
    name: parsed.channel.name,
    category: parsed.category,
    workspace: parsed.namespace,
  };
  const absPath =
    parsed.kind === "channel"
      ? channelFilePath(key)
      : threadFilePath(key, parsed.threadId, parsed.threadName);

  // Defence in depth: `channelSlug` sanitizes, but never serve a path that
  // resolved outside the export root regardless of how it got there.
  const root = resolve(discordDir());
  const abs = resolve(absPath);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  if (!existsSync(abs)) return null;

  const st = statSync(abs);
  if (!st.isFile()) return null;

  const fileName =
    parsed.kind === "channel"
      ? `${sanitized.split("/").filter(Boolean).pop() ?? "channel"}.md`
      : `${abs.split(sep).pop() ?? "thread.md"}`;

  return { absPath: abs, fileName, indexPath: sanitized, size: st.size, mtimeMs: st.mtimeMs };
}

/** Byte window resolved against a file size. `end` is inclusive, HTTP-style. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range: bytes=…` header. Multi-range is deliberately
 * unsupported (it would need multipart/byteranges); such a header is treated
 * as "no range" rather than an error, which RFC 9110 permits.
 *
 * Returns `"unsatisfiable"` when the range parses but falls outside the file,
 * so the caller can answer 416 instead of silently serving the whole thing.
 */
export function parseByteRange(header: string | null, size: number): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const rawStart = m[1] ?? "";
  const rawEnd = m[2] ?? "";
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    // Suffix form: `bytes=-500` = the last 500 bytes.
    const wanted = Number(rawEnd);
    if (!Number.isFinite(wanted) || wanted <= 0) return "unsatisfiable";
    if (size === 0) return "unsatisfiable";
    const start = Math.max(0, size - wanted);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start < 0) return "unsatisfiable";
  if (start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return "unsatisfiable";
  return { start, end };
}

/** One block boundary in an export file: every message starts a `## [` line. */
const BLOCK_START = "\n## ";

export interface FileWindow {
  /** The channel/thread header (everything before the first `---`), always included. */
  header: string;
  /** Message blocks for the requested window, snapped to whole blocks. */
  body: string;
  /** Byte offset the body starts at, after snapping. */
  start: number;
  /** Byte offset one past the body's last byte. */
  end: number;
  size: number;
  /** True when `start > 0`, i.e. older content exists before this window. */
  hasOlder: boolean;
}

/**
 * Read a window of an export file, newest-last but anchored at the END by
 * default — these files are append-ordered oldest → newest, so the last bytes
 * are the recent conversation an agent almost always wants first.
 *
 * The window is snapped backward to the previous block boundary so a read
 * never begins mid-message. Snap-forward would skip the current (often last)
 * block when it is larger than `bytes`, returning an empty newest window and
 * a `before=${start}` that loops on the same empty range.
 *
 * Accepting a slightly larger window is the point: the last block is what
 * "recent" questions need. The file header is always prepended so the agent
 * knows which channel it is looking at even when reading from the middle.
 *
 * `before` pages backwards: pass the previous window's `start`.
 */
export function readFileWindow(
  ref: RawFileRef,
  opts: { bytes: number; before?: number } = { bytes: 32_768 },
): FileWindow {
  const buf = readFileSync(ref.absPath);
  const size = buf.length;

  const headerEnd = buf.indexOf("\n---\n");
  const header = headerEnd >= 0 ? buf.subarray(0, headerEnd).toString("utf8") : "";
  const bodyFloor = headerEnd >= 0 ? headerEnd + 5 : 0;

  const bytes = Math.max(1, Math.trunc(opts.bytes));
  const anchorEnd =
    opts.before != null && Number.isFinite(opts.before)
      ? Math.max(bodyFloor, Math.min(Math.trunc(opts.before), size))
      : size;
  let start = Math.max(bodyFloor, anchorEnd - bytes);

  // Snap backward to a whole-block start. If the last (or current) block is
  // larger than `bytes`, include that whole block rather than emptying.
  if (start > bodyFloor && start < anchorEnd) {
    const prev = buf.lastIndexOf(BLOCK_START, start - 1);
    if (prev >= bodyFloor) start = prev + 1;
    else start = bodyFloor;
  }

  return {
    header,
    body: buf.subarray(start, anchorEnd).toString("utf8"),
    start,
    end: anchorEnd,
    size,
    hasOlder: start > bodyFloor,
  };
}

/**
 * A weak validator: size + mtime. The export files are append-mostly and
 * rewritten wholesale by `rerenderChannel`, so this changes whenever content
 * does, without hashing 676 KB on every request.
 */
export function fileEtag(ref: Pick<RawFileRef, "size" | "mtimeMs">): string {
  return `W/"${ref.size.toString(16)}-${Math.floor(ref.mtimeMs).toString(16)}"`;
}
