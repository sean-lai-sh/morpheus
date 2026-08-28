import type { Message } from "discord.js";
import {
  audienceSelectionsFromMentions,
  meetingAudienceFromSelections,
} from "../coordinator/audience.ts";
import { assertCoordinatorCreate } from "../coordinator/gates.ts";
import { publishOutboxEvents } from "../coordinator/publisher.ts";
import { parseAbsoluteWhen } from "../coordinator/when.ts";
import { createScheduledMeeting } from "../storage/coordinator-meetings.ts";
import { isMentionTrigger, memberRoleIds, mentionUserIds, threadParentId } from "./triggers.ts";

const ALLOWED_MENTIONS = { parse: [] as never[], users: [] as string[], roles: [] as string[], repliedUser: false };

const MEETING_HINT =
  /\b(meet(?:ing)?|calendar|invite|sync|standup|stand-?up|1\s*:\s*1|1-1|one[- ]on[- ]one|huddle|office hours)\b/i;

export function looksLikeMeetingMention(content: string): boolean {
  return MEETING_HINT.test(content);
}

export function extractMeetingTitle(content: string): string {
  const cleaned = content
    .replace(/<@!?&?\d+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const first = cleaned.split(/[.!?]/)[0]?.trim() ?? cleaned;
  return (first.length > 80 ? first.slice(0, 77) + "…" : first) || "Untitled meeting";
}

/**
 * Thin mention door: meeting-ish text + user/role mentions → same createScheduledMeeting as /meet.
 * Role → F26 roster (no live expansion). Users stay snowflakes.
 */
export async function tryEnqueueMeetingMention(message: Message<true>, botUserId: string): Promise<boolean> {
  if (message.author.bot) return false;
  if (!isMentionTrigger(message.content, botUserId, mentionUserIds(message))) return false;
  if (!looksLikeMeetingMention(message.content)) return false;

  const mentionedUserIds = [...message.mentions.users.keys()].filter((id) => id !== botUserId);
  const mentionedRoleIds = [...message.mentions.roles.keys()];
  if (mentionedUserIds.length === 0 && mentionedRoleIds.length === 0) return false;

  const gate = assertCoordinatorCreate({
    roleIds: memberRoleIds(message.member),
    channelId: message.channelId,
    parentChannelId: threadParentId(message),
  });
  if (!gate.ok) return false;

  const parsed = parseAbsoluteWhen(message.content, new Date());
  if (!parsed) {
    await message.reply({
      content:
        "I need a concrete date/time to book (for example `Friday 3pm` or `2026-09-04 18:00`). Role @Eboard still means the F26 roster, not live Discord expansion.",
      allowedMentions: ALLOWED_MENTIONS,
    });
    return true;
  }

  const audience = meetingAudienceFromSelections(
    audienceSelectionsFromMentions({
      users: mentionedUserIds.map((id) => {
        const user = message.mentions.users.get(id);
        return {
          id,
          displayName: user?.globalName ?? user?.username ?? id,
        };
      }),
      roleIds: mentionedRoleIds,
    }),
  );

  const durationMinutes = Math.max(
    15,
    Math.min(480, Math.round((parsed.endsAt.getTime() - parsed.startsAt.getTime()) / 60_000) || 60),
  );
  const result = createScheduledMeeting({
    createdByUserId: message.author.id,
    title: extractMeetingTitle(message.content),
    startsAt: parsed.startsAt.getTime(),
    durationMinutes,
    timeZone: parsed.timeZone,
    notes: message.content,
    channelId: message.channelId,
    participants: audience.userSelections.map((user) => ({
      userId: user.id,
      displayName: user.displayName,
    })),
    audienceKind: audience.audienceKind,
  });
  const outcomes = await publishOutboxEvents(result.outboxEvents);
  const handed = outcomes.some((outcome) => outcome.status === "accepted")
    ? "Calendar sync handed off to Grok."
    : "Calendar sync is queued for automatic retry.";
  const audienceLine =
    audience.audienceKind === "f26_roster"
      ? "F26 Preferred Emails (role is not expanded)."
      : `${audience.userSelections.length} attendee(s).`;
  await message.reply({
    content: `📅 **${result.meeting.title}**\n${audienceLine}\nMeeting ID: \`${result.meeting.id}\`\n${handed}`,
    allowedMentions: ALLOWED_MENTIONS,
  });
  return true;
}
