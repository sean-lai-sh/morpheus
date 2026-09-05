import type { Guild, Message } from "discord.js";
import { publishOutboxEvents } from "../coordinator/publisher.ts";
import {
  extractTodoMentions,
  MISSING_DUE_REPLY,
  parseTodoIntent,
} from "../coordinator/todo-intent.ts";
import {
  completeVisibleTodo,
  createAndActivateTodo,
  formatTodoDue,
  formatVisibleTodoList,
  resolveNlAssignees,
  TodoUserError,
} from "../coordinator/todo-nl.ts";
import { logger } from "../logger.ts";
import { JOB_ALLOWED_MENTIONS } from "./reply.ts";
import {
  skipReasonForCandidate,
  type JobCandidate,
  type TryEnqueueOpts,
} from "./enqueue.ts";

export type TodoMentionReply = (text: string) => Promise<void>;

export interface TryHandleTodoMentionOpts extends TryEnqueueOpts {
  botUserId: string;
  reply?: TodoMentionReply;
  guild?: Guild | null;
  speakerDisplayName?: string;
  mentionedUsers?: Array<{ id: string; displayName?: string }>;
}

export async function tryHandleTodoMention(
  candidate: JobCandidate,
  opts: TryHandleTodoMentionOpts,
): Promise<{ handled: boolean }> {
  if (skipReasonForCandidate(candidate, opts)) return { handled: false };

  const intent = parseTodoIntent(candidate.content, {
    botUserId: opts.botUserId,
    now: opts.now,
  });
  if (intent.kind === "unclear") return { handled: false };

  const reply =
    opts.reply ??
    (async () => {
      /* tests inject reply */
    });

  try {
    if (intent.kind === "missing_due") {
      await reply(intent.dueError ?? MISSING_DUE_REPLY);
      return { handled: true };
    }
    if (intent.kind === "list") {
      await reply(formatVisibleTodoList(candidate.authorId));
      return { handled: true };
    }
    if (intent.kind === "done") {
      const result = completeVisibleTodo(candidate.authorId, intent.titleFragment);
      await reply(result.ok ? `Marked **${result.task.title}** done.` : result.detail);
      return { handled: true };
    }

    const mentions = extractTodoMentions(candidate.content, opts.botUserId);
    const assignees = await resolveNlAssignees({
      speakerUserId: candidate.authorId,
      speakerDisplayName: opts.speakerDisplayName,
      mentionedUsers: opts.mentionedUsers ?? mentions.userIds.map((id) => ({ id })),
      mentionedRoleIds: mentions.roleIds,
      guild: opts.guild,
    });
    const channelId = candidate.discordChannelId;
    const created = createAndActivateTodo({
      createdByUserId: candidate.authorId,
      title: intent.title,
      dueAt: intent.dueAt,
      channelId,
      assignees,
      now: opts.now,
    });
    await publishOutboxEvents(created.outboxEvents);
    const names = created.assignments.map((row) => row.displayName ?? row.userId).join(", ");
    await reply(
      `Added **${created.task.title}** due ${formatTodoDue(created.task.dueAt, created.task.timeZone)}.\nAssignees: ${names || "you"}\nI'll remind 1 day and 5 hours before in this channel and in DMs.`,
    );
    return { handled: true };
  } catch (err) {
    // Only messages written for a human go back to Discord; a SQLite or
    // discord.js error string would otherwise land in a public channel.
    logger.error({ err, author_id: candidate.authorId }, "todo mention apply failed");
    const message = err instanceof TodoUserError ? err.message : "";
    await reply(message || "I couldn't update that todo. It has been logged.");
    return { handled: true };
  }
}

export async function replyToTodoMessage(message: Message, text: string): Promise<void> {
  if (!("reply" in message) || typeof message.reply !== "function") return;
  await message.reply({ content: text, allowedMentions: JOB_ALLOWED_MENTIONS });
}
