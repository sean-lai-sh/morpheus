import type { Message } from "discord.js";
import { getChannel, jobTriggerRoleIds } from "../config.ts";
import { assertCoordinatorCreate } from "../coordinator/gates.ts";
import { identityFromCachedUser, identityFromUserLike, type DiscordIdentity } from "../coordinator/identity.ts";
import { isMeetingIntent, parseMeetingRequest } from "../coordinator/meeting-request.ts";
import { publishOutboxEvents } from "../coordinator/publisher.ts";
import { logger } from "../logger.ts";
import { createScheduledMeeting } from "../storage/coordinator-meetings.ts";
import { findUsersByNameHints } from "../storage/users.ts";
import { isMentionTrigger, memberRoleIds, mentionUserIds, threadParentId } from "./triggers.ts";

const ALLOWED_MENTIONS = { parse: [] as never[], users: [] as string[], roles: [] as string[], repliedUser: false };

export interface MeetingMentionInput {
  discordMessageId: string;
  discordChannelId: string;
  parentChannelId: string | null;
  authorId: string;
  authorIsBot: boolean;
  authorRoleIds: string[];
  content: string;
  mentionedBot: boolean;
  botUserId: string;
  now?: number;
  author?: DiscordIdentity;
  mentioned?: DiscordIdentity[];
  mentionedRoleIds?: string[];
}

export interface MeetingMentionResult {
  handled: boolean;
  meetingId?: string;
  reason?: string;
}

export function meetingMentionFromMessage(message: Message, botUserId: string): MeetingMentionInput {
  const parentId = threadParentId(message);
  const mentioned = [...(message.mentions?.users?.values?.() ?? [])]
    .filter((user) => user.id !== botUserId && !user.bot)
    .map((user) => {
      const member = message.guild?.members.cache.get(user.id);
      return identityFromUserLike({
        id: user.id,
        username: user.username,
        globalName: user.globalName,
        nickname: member?.nickname,
        displayName: member?.displayName,
      });
    });
  const member = message.member;
  return {
    discordMessageId: message.id,
    discordChannelId: message.channelId,
    parentChannelId: parentId,
    authorId: message.author?.id ?? "unknown",
    authorIsBot: Boolean(message.author?.bot),
    authorRoleIds: memberRoleIds(message.member),
    content: message.content ?? "",
    mentionedBot: isMentionTrigger(message.content ?? "", botUserId, mentionUserIds(message)),
    botUserId,
    author: message.author
      ? identityFromUserLike({
          id: message.author.id,
          username: message.author.username,
          globalName: message.author.globalName,
          nickname: member?.nickname,
          displayName: member?.displayName,
        })
      : undefined,
    mentioned,
    mentionedRoleIds: [...(message.mentions?.roles?.keys?.() ?? [])],
  };
}

/**
 * Same meeting tool as /meet: role-gated, outbox calendar_sync, no emails in the pack.
 * Returns handled=true so the generic /ask mention path does not also enqueue.
 */
export async function tryHandleMeetingMention(input: MeetingMentionInput): Promise<MeetingMentionResult> {
  if (input.authorIsBot) return { handled: false, reason: "bot-author" };
  if (!input.mentionedBot) return { handled: false, reason: "not-trigger" };
  if (!isMeetingIntent(input.content, input.botUserId)) return { handled: false, reason: "not-meeting" };

  const gate = assertCoordinatorCreate({
    roleIds: input.authorRoleIds,
    channelId: input.discordChannelId,
    parentChannelId: input.parentChannelId,
    triggerRoleIds: jobTriggerRoleIds(),
    resolveChannel: getChannel,
  });
  if (!gate.ok) return { handled: false, reason: gate.reason };

  const parsed = parseMeetingRequest(input.content, {
    now: input.now,
    botUserId: input.botUserId,
    source: "mention",
  });
  if (!parsed) return { handled: false, reason: "not-meeting" };

  const roleMentioned = (input.mentionedRoleIds ?? []).length > 0 || /<@&\d+>/.test(input.content);
  const audienceKind = roleMentioned || parsed.audienceKind === "f26_roster" ? "f26_roster" : parsed.audienceKind;
  const mentioned = audienceKind === "f26_roster" ? [] : (input.mentioned ?? []);
  const extraUsers = audienceKind === "f26_roster" ? (input.mentioned ?? []) : [];
  const resolvedHints = audienceKind === "f26_roster" ? [] : findUsersByNameHints(parsed.requestedNames).map(identityFromCachedUser);
  const byId = new Map<string, DiscordIdentity>();
  for (const person of [...mentioned, ...extraUsers, ...resolvedHints]) byId.set(person.userId, person);
  const participants = audienceKind === "f26_roster" ? extraUsers : [...byId.values()];
  const unresolved = audienceKind === "f26_roster" ? [] : parsed.requestedNames.filter(
    (name) =>
      !resolvedHints.some((person) =>
        [person.username, person.globalName, person.guildNick].some(
          (field) => field && field.toLowerCase().includes(name.toLowerCase()),
        ),
      ),
  );

  try {
    const result = createScheduledMeeting({
      createdByUserId: input.authorId,
      createdBy: input.author ?? { userId: input.authorId, username: null, globalName: null, guildNick: null },
      title: parsed.title,
      startsAt: parsed.startsAt,
      durationMinutes: parsed.durationMinutes,
      timeZone: parsed.timeZone,
      notes: parsed.notes,
      channelId: input.parentChannelId ?? input.discordChannelId,
      participants,
      calendarTarget: audienceKind === "f26_roster" ? "eboard" : parsed.calendar,
      conference: parsed.conference,
      recurrence: parsed.recurrence,
      audienceKind,
      source: "mention",
      sourceMessageId: input.discordMessageId,
      sourceText: parsed.sourceText,
      requestedNames: unresolved,
      location: parsed.location,
      recurrenceUntil: parsed.recurrenceUntil,
      fieldLocks: parsed.locked,
      now: input.now,
    });
    await publishOutboxEvents(result.outboxEvents);
    logger.info(
      { meetingId: result.meeting.id, source: "mention", audience: parsed.audienceKind },
      "meeting.mention.queued",
    );
    return { handled: true, meetingId: result.meeting.id };
  } catch (err) {
    logger.warn({ err, author_id: input.authorId }, "meeting.mention.create_failed");
    return { handled: false, reason: err instanceof Error ? err.message : "create-failed" };
  }
}

export async function tryHandleMeetingMentionFromMessage(
  message: Message,
  botUserId: string,
): Promise<MeetingMentionResult> {
  const result = await tryHandleMeetingMention(meetingMentionFromMessage(message, botUserId));
  if (result.handled && "reply" in message && typeof message.reply === "function") {
    try {
      await message.reply({
        content:
          "Queued calendar sync. Grok (hello@) will create the event and I'll reply with the Meet link.",
        allowedMentions: ALLOWED_MENTIONS,
      });
    } catch (err) {
      logger.warn({ err, message_id: message.id }, "meeting.mention.ack_failed");
    }
  }
  return result;
}
