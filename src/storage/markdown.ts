import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { LinkRow } from "./links.ts";
import { linksForMessage } from "./links.ts";
import type { MessageRow } from "./messages.ts";
import { messagesForChannelAsc } from "./messages.ts";
import { markDirty } from "./sync-state.ts";

export const DISCORD_DIR = resolve(process.cwd(), "data/discord");
export const GENERAL_DIR = resolve(DISCORD_DIR, "general");
export const LEADERSHIP_DIR = resolve(DISCORD_DIR, "leadership");

/** Minimal channel shape needed for path resolution. */
export interface ChannelKey {
  id: string;
  name: string;
  category?: string | undefined;
  isolated?: boolean | undefined;
}

/** Slugify channel or thread name for use in filesystem paths. */
export function channelSlug(name: string, id: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "channel";
  return `${base}-${id.slice(-4)}`;
}

function rootDir(channel: ChannelKey): string {
  return channel.isolated ? LEADERSHIP_DIR : GENERAL_DIR;
}

function channelDirPath(channel: ChannelKey): string {
  const root = rootDir(channel);
  const slug = channelSlug(channel.name, channel.id);
  return channel.category ? resolve(root, channel.category, slug) : resolve(root, slug);
}

export function channelFilePath(channel: ChannelKey): string {
  return resolve(channelDirPath(channel), "main.md");
}

function threadFilePath(channel: ChannelKey, threadId: string, threadName: string): string {
  return resolve(channelDirPath(channel), "threads", `${channelSlug(threadName, threadId)}.md`);
}

function ensureFile(channel: ChannelKey, guildId: string): string {
  const path = channelFilePath(channel);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, fileHeader(channel, guildId), "utf8");
  return path;
}

function ensureThreadFile(
  channel: ChannelKey,
  guildId: string,
  threadId: string,
  threadName: string,
): string {
  const path = threadFilePath(channel, threadId, threadName);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, threadFileHeader(channel, guildId, threadId, threadName), "utf8");
  return path;
}

function fileHeader(channel: ChannelKey, guildId: string): string {
  return [
    `# #${channel.name}`,
    `- channel_id: ${channel.id}`,
    `- guild_id: ${guildId}`,
    `- indexing_rules: all messages; edits append; deletes tombstone`,
    ``,
    `---`,
    ``,
  ].join("\n");
}

function threadFileHeader(
  channel: ChannelKey,
  guildId: string,
  threadId: string,
  threadName: string,
): string {
  return [
    `# Thread: ${threadName}`,
    `- thread_id: ${threadId}`,
    `- starter_message_id: ${threadId}`,
    `- parent_channel_id: ${channel.id}`,
    `- parent_channel_name: ${channel.name}`,
    `- guild_id: ${guildId}`,
    `- indexing_rules: all messages; edits append; deletes tombstone`,
    ``,
    `---`,
    ``,
  ].join("\n");
}

function fmtTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function linksLine(links: LinkRow[]): string | null {
  if (links.length === 0) return null;
  return `**Links**: ${links.map((l) => l.url).join(" ")}`;
}

function reactionsLine(reactions: string | null): string | null {
  if (!reactions) return null;
  const map = JSON.parse(reactions) as Record<string, number>;
  const parts = Object.entries(map)
    .filter(([, n]) => n > 0)
    .map(([e, n]) => `${e}×${n}`);
  return parts.length ? `**Reactions**: ${parts.join(" ")}` : null;
}

export interface RenderInput {
  msg: MessageRow;
  links: LinkRow[];
  variant: "create" | "edit" | "delete";
}

export function renderBlock(input: RenderInput): string {
  const { msg, links, variant } = input;
  const ts = fmtTimestamp(variant === "edit" ? msg.edited_at ?? msg.created_at : msg.created_at);
  const author = `@${msg.author_name}`;

  if (variant === "delete") {
    return [
      `## [${fmtTimestamp(msg.deleted_at ?? Date.now())}] DELETED (tombstone for msg:${msg.id})`,
      `[content removed]`,
      ``,
      ``,
    ].join("\n");
  }

  const headerVariant = variant === "edit" ? `EDIT (edit of msg:${msg.id})` : `(msg:${msg.id})`;
  const lines: string[] = [
    `## [${ts}] ${author} ${headerVariant}`,
    msg.content || "[empty message]",
  ];
  const ll = linksLine(links);
  if (ll) lines.push(ll);
  const rl = reactionsLine(msg.reactions);
  if (rl) lines.push(rl);
  lines.push("", "");
  return lines.join("\n");
}

/**
 * Append a block for the given message to its channel or thread file.
 * Routes to the thread file when msg.thread_id is set.
 */
export function appendBlock(
  channel: ChannelKey,
  guildId: string,
  msg: MessageRow,
  variant: "create" | "edit" | "delete",
): void {
  let path: string;
  if (msg.thread_id && msg.thread_name) {
    path = ensureThreadFile(channel, guildId, msg.thread_id, msg.thread_name);
  } else {
    path = ensureFile(channel, guildId);
  }
  const links = variant === "delete" ? [] : linksForMessage(msg.id);
  const block = renderBlock({ msg, links, variant });
  appendFileSync(path, block, "utf8");
  markDirty(rootDir(channel));
}

/**
 * Re-render a channel's markdown from SQLite (recovery path).
 *
 * Writes main.md for non-thread messages and one file per thread under threads/.
 * Limitation: SQLite stores only the latest content per message id, so the
 * original-then-EDIT history produced by the live writer cannot be reproduced.
 */
export function rerenderChannel(channel: ChannelKey, guildId: string): number {
  const allRows = messagesForChannelAsc(channel.id);

  // Write main.md (non-thread messages only).
  const mainPath = channelFilePath(channel);
  mkdirSync(dirname(mainPath), { recursive: true });
  let mainBody = fileHeader(channel, guildId);
  let written = 0;
  for (const msg of allRows) {
    if (msg.thread_id) continue;
    const links = linksForMessage(msg.id);
    mainBody += renderBlock({ msg, links, variant: "create" });
    if (msg.deleted_at) mainBody += renderBlock({ msg, links: [], variant: "delete" });
    written++;
  }
  writeFileSync(mainPath, mainBody, "utf8");

  // Group thread messages by thread_id.
  const threadGroups = new Map<string, MessageRow[]>();
  for (const msg of allRows) {
    if (!msg.thread_id || !msg.thread_name) continue;
    const existing = threadGroups.get(msg.thread_id);
    if (existing) existing.push(msg);
    else threadGroups.set(msg.thread_id, [msg]);
  }

  // Write one file per thread.
  for (const [threadId, msgs] of threadGroups) {
    const threadName = msgs[0]?.thread_name ?? threadId;
    const tPath = threadFilePath(channel, threadId, threadName);
    mkdirSync(dirname(tPath), { recursive: true });
    let tBody = threadFileHeader(channel, guildId, threadId, threadName);
    for (const msg of msgs) {
      const links = linksForMessage(msg.id);
      tBody += renderBlock({ msg, links, variant: "create" });
      if (msg.deleted_at) tBody += renderBlock({ msg, links: [], variant: "delete" });
      written++;
    }
    writeFileSync(tPath, tBody, "utf8");
  }

  markDirty(rootDir(channel));
  return written;
}

/** Remove legacy flat .md files at the root of data/discord/ (left over from pre-hierarchy runs). */
export function removeLegacyFlatFiles(): void {
  try {
    const entries = readdirSync(DISCORD_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".md")) {
        rmSync(resolve(DISCORD_DIR, e.name));
      }
    }
  } catch {
    // directory may not exist yet; nothing to clean
  }
}
