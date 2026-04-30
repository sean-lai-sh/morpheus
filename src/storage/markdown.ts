import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Channel } from "../config.ts";
import type { LinkRow } from "./links.ts";
import { linksForMessage } from "./links.ts";
import type { MessageRow } from "./messages.ts";
import { messagesForChannelAsc } from "./messages.ts";
import { markDirty } from "./sync-state.ts";

export const DISCORD_DIR = resolve(process.cwd(), "data/discord");

/** Slugify channel name for filename, suffixed with last-4 of channel id (rename-safe). */
export function channelSlug(name: string, channelId: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "channel";
  return `${base}-${channelId.slice(-4)}`;
}

export function channelFilePath(channel: Pick<Channel, "id" | "name">): string {
  return resolve(DISCORD_DIR, `${channelSlug(channel.name, channel.id)}.md`);
}

function ensureDir(): void {
  mkdirSync(DISCORD_DIR, { recursive: true });
}

function fileHeader(channel: Pick<Channel, "id" | "name">, guildId: string): string {
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

function ensureFile(channel: Pick<Channel, "id" | "name">, guildId: string): string {
  ensureDir();
  const path = channelFilePath(channel);
  if (!existsSync(path)) writeFileSync(path, fileHeader(channel, guildId), "utf8");
  return path;
}

function fmtTimestamp(ms: number): string {
  // YYYY-MM-DD HH:MM UTC — stable, locale-free, easy to grep
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
 * Append a block for the given message to its channel file.
 * Caller is responsible for deciding if the message is markdown-eligible
 * (operational or discussion only). This function does NOT filter.
 */
export function appendBlock(
  channel: Pick<Channel, "id" | "name">,
  guildId: string,
  msg: MessageRow,
  variant: "create" | "edit" | "delete",
): void {
  const path = ensureFile(channel, guildId);
  const links = variant === "delete" ? [] : linksForMessage(msg.id);
  const block = renderBlock({ msg, links, variant });
  appendFileSync(path, block, "utf8");
  markDirty(DISCORD_DIR);
}

/**
 * Re-render a channel's markdown from SQLite (recovery path).
 *
 * Limitation: SQLite stores only the latest content per message id, so we
 * cannot reproduce the original-then-EDIT history that the append-only writer
 * produces in real-time. Rerender therefore writes a single block per message
 * with the latest content (annotated `(edited <ts>)` if it was edited) plus
 * a tombstone block when deleted_at is set. Use this only when the live
 * markdown file is corrupted or lost.
 */
export function rerenderChannel(channel: Pick<Channel, "id" | "name">, guildId: string): number {
  ensureDir();
  const path = channelFilePath(channel);
  let body = fileHeader(channel, guildId);
  const rows = messagesForChannelAsc(channel.id);
  let written = 0;
  for (const msg of rows) {
    const links = linksForMessage(msg.id);
    body += renderBlock({ msg, links, variant: "create" });
    if (msg.deleted_at) body += renderBlock({ msg, links: [], variant: "delete" });
    written++;
  }
  writeFileSync(path, body, "utf8");
  markDirty(DISCORD_DIR);
  return written;
}
