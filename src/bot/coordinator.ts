import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MentionableSelectMenuBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type Interaction,
  type MessageActionRowComponentBuilder,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type TextBasedChannel,
} from "discord.js";

type MessageRow = ActionRowBuilder<MessageActionRowComponentBuilder>;
import {
  dateInTimeZone,
  expandAudience,
  extractMentionableAudience,
} from "../coordinator/audience.ts";
import {
  buildRosterSeedPack,
  isRosterSeedCandidate,
  serializeRosterSeedPack,
} from "../coordinator/seed-job.ts";
import { parseDurationInput, parseWhenInput } from "../coordinator/when-input.ts";
import { draftPreview, meetingWhenLine } from "../coordinator/meeting-format.ts";
import { mergePageSelection, pageLabel, rosterPickerPages } from "../coordinator/roster-picker.ts";
import {
  claimMeetingDraft,
  createMeetingDraft,
  getMeetingDraft,
  setMeetingDraftAudience,
} from "../storage/meeting-drafts.ts";
import { ephemeralSlashAckMessageId } from "./reply.ts";
import { tryEnqueueJob } from "./enqueue.ts";
import { authorCanViewChannel } from "./job-scope.ts";
import { assertCoordinatorCreate, assertMeetInvoke } from "../coordinator/gates.ts";
import { publishOutboxEvents, type OutboxDispatchOutcome } from "../coordinator/publisher.ts";
import {
  formatReminderPolicy,
  isTaskReminderPolicy,
  type TaskReminderPolicy,
} from "../coordinator/reminders.ts";
import { logger } from "../logger.ts";
import { jobTriggerRoleIds } from "../config.ts";
import {
  cancelMeeting,
  createScheduledMeeting,
  getMeeting,
} from "../storage/coordinator-meetings.ts";
import {
  activateTask,
  addTaskAssignments,
  cancelTask,
  completeTaskAssignment,
  createTaskDraft,
  getTask,
  getTaskAssignments,
  getTaskForCreator,
  listTasksCreatedBy,
  listTasksForPerson,
  setPersonTaskReminderPreference,
  setTaskAssignmentReminderOverride,
  updateTask,
} from "../storage/coordinator-tasks.ts";
import type { OutboxEvent } from "../storage/outbox.ts";

export const TASK_COMMAND = new SlashCommandBuilder()
  .setName("task")
  .setDescription("Create and manage eboard tasks with Discord reminder DMs.")
  .addSubcommand((sub) => sub.setName("create").setDescription("Create a private task draft"))
  .addSubcommand((sub) => sub.setName("list").setDescription("List tasks assigned to you or created by you"))
  .addSubcommand((sub) =>
    sub.setName("preferences").setDescription("Set your default task reminder policy"),
  )
  .toJSON();

export const MEET_COMMAND = new SlashCommandBuilder()
  .setName("meet")
  .setDescription("Schedule or cancel an eboard meeting.")
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Schedule a meeting and send the Google Calendar invite"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("cancel")
      .setDescription("Cancel a meeting you created")
      .addStringOption((opt) =>
        opt.setName("meeting_id").setDescription("Meeting id from the announcement").setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("seed").setDescription("One-shot F26 Discord→email map (Grok reads the sheet; Mini stores bindings)"),
  )
  .toJSON();

const ALLOWED_MENTIONS = { parse: [] as never[], users: [] as string[], roles: [] as string[], repliedUser: false };


/**
 * Structural param, not discord.js's `Interaction` union: the union does not
 * include the base `MessageComponentInteraction`, only its concrete subtypes,
 * so `meetGate` (which accepts the base) could not call this. All this needs
 * is the optional `member`.
 */
function interactionRoleIds(interaction: { member?: unknown } | Interaction): string[] {
  const member = "member" in interaction ? interaction.member : null;
  if (!member) return [];
  if (typeof (member as GuildMember).roles?.cache?.keys === "function") {
    return [...(member as GuildMember).roles.cache.keys()];
  }
  const apiRoles = (member as { roles?: string[] }).roles;
  return Array.isArray(apiRoles) ? apiRoles : [];
}

function interactionParentId(interaction: ChatInputCommandInteraction | MessageComponentInteraction): string | null {
  const ch = interaction.channel;
  if (!ch) return null;
  if (
    ch.type === ChannelType.PublicThread ||
    ch.type === ChannelType.PrivateThread ||
    ch.type === ChannelType.AnnouncementThread
  ) {
    return ch.parentId ?? null;
  }
  return null;
}

function createGate(interaction: ChatInputCommandInteraction) {
  return assertCoordinatorCreate({
    roleIds: interactionRoleIds(interaction),
    channelId: interaction.channelId,
    parentChannelId: interactionParentId(interaction),
    triggerRoleIds: jobTriggerRoleIds(),
  });
}

function meetGate(interaction: ChatInputCommandInteraction | MessageComponentInteraction) {
  return assertMeetInvoke({
    roleIds: interactionRoleIds(interaction),
    channelId: interaction.channelId,
    parentChannelId: interactionParentId(interaction),
  });
}

function handoffMessage(outcomes: OutboxDispatchOutcome[], accepted: string, deferred: string): string {
  return outcomes.some((outcome) => outcome.status === "accepted") ? accepted : deferred;
}

async function publish(events: OutboxEvent[]): Promise<OutboxDispatchOutcome[]> {
  if (events.length === 0) return [];
  return publishOutboxEvents(events);
}

function taskAudienceSelect(taskId: string) {
  return new ActionRowBuilder<MentionableSelectMenuBuilder>().addComponents(
    new MentionableSelectMenuBuilder()
      .setCustomId(`task-audience:${taskId}`)
      .setPlaceholder("Add Discord users or roles")
      .setMinValues(1)
      .setMaxValues(25),
  );
}

function reminderPolicySelect(customId: string, selected?: string) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("Choose reminder behavior")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        [
          ["default", "Use my default"],
          ["daily_until_done", "Daily until done"],
          ["one_day_before", "One day before due"],
          ["one_hour_before", "One hour before due"],
          ["none", "No reminders"],
        ]
          .filter(([value]) => customId !== "task-preferences" || value !== "default")
          .map(([value, label]) => ({
            value: value!,
            label: label!,
            default: value === selected,
          })),
      ),
  );
}

function buttonRow(
  ...buttons: Array<{ customId: string; label: string; style?: ButtonStyle }>
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    buttons.map((button) =>
      new ButtonBuilder()
        .setCustomId(button.customId)
        .setLabel(button.label.slice(0, 80))
        .setStyle(button.style ?? ButtonStyle.Primary),
    ),
  );
}

function formatDue(dueAt: number | null, timeZone: string): string {
  if (dueAt == null) return "No due date";
  return new Date(dueAt).toLocaleString("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function composerContent(taskId: string): { content: string; components: MessageRow[] } {
  const task = getTask(taskId);
  if (!task) throw new Error("Task not found.");
  const assignments = getTaskAssignments(task.id);
  const assignees = assignments.length
    ? assignments.map((a) => `${a.displayName ?? a.userId}${a.status === "completed" ? " ✓" : ""}`).join(", ")
    : "None yet";
  const rows: MessageRow[] = [
    taskAudienceSelect(task.id),
    buttonRow(
      { customId: `task-due:${task.id}:0`, label: "Set due date" },
      { customId: `task-edit:${task.id}`, label: "Edit details", style: ButtonStyle.Secondary },
      ...(task.status === "draft"
        ? [{ customId: `task-activate:${task.id}`, label: "Create task", style: ButtonStyle.Success }]
        : []),
      { customId: `task-cancel:${task.id}`, label: "Cancel task", style: ButtonStyle.Danger },
    ),
    buttonRow({ customId: "task-back", label: "Back to task list", style: ButtonStyle.Secondary }),
  ];
  return {
    content: `**${task.title}**\n${task.description ?? "No description."}\nDue: ${formatDue(task.dueAt, task.timeZone)}\nAssignees: ${assignees}\nStatus: ${task.status}`,
    components: rows,
  };
}

function taskListContent(userId: string): { content: string; components: MessageRow[] } {
  const assigned = listTasksForPerson({ userId });
  const created = listTasksCreatedBy({ userId });
  if (assigned.length === 0 && created.length === 0) {
    return { content: "You have no open tasks or active tasks you created.", components: [] };
  }
  const problems = [
    ...assigned.filter((entry) => entry.latestDelivery?.status === "failed"),
    ...created.flatMap((task) => task.assignments.filter((entry) => entry.latestDelivery?.status === "failed")),
  ];
  const assignedText = assigned.length
    ? assigned
        .map(
          (entry) =>
            `• ${entry.task.title}${entry.task.dueAt ? ` — due ${formatDue(entry.task.dueAt, entry.task.timeZone)}` : ""}`,
        )
        .join("\n")
    : "None";
  const createdText = created.length
    ? created
        .map(
          ({ task }) =>
            `• ${task.title}${task.dueAt ? ` — due ${formatDue(task.dueAt, task.timeZone)}` : ""}`,
        )
        .join("\n")
    : "None";
  const components: MessageRow[] = [];
  if (assigned.length) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("task-select")
          .setPlaceholder("Open a task")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            assigned.slice(0, 25).map(({ task, assignment }) => ({
              label: task.title.slice(0, 100),
              description: task.dueAt ? `Due ${formatDue(task.dueAt, task.timeZone)}` : "No due date",
              value: assignment.id,
            })),
          ),
      ),
    );
  }
  if (created.length) {
    components.push(
      buttonRow(
        ...created.slice(0, 5).map((entry) => ({
          customId: `task-owner:${entry.task.id}`,
          label: `Manage ${entry.task.title}`,
          style: ButtonStyle.Secondary,
        })),
      ),
    );
  }
  return {
    content: `**Assigned to you**\n${assignedText}\n\n**Created by you**\n${createdText}${
      problems.length
        ? `\n\n⚠️ ${problems.length} task reminder delivery issue(s). Open a task you created or assigned to yourself for details.`
        : ""
    }`,
    components,
  };
}

function assignmentCard(assignmentId: string, userId: string): { content: string; components: MessageRow[] } {
  const entries = listTasksForPerson({ userId, includeCompleted: true });
  const entry = entries.find((candidate) => candidate.assignment.id === assignmentId);
  if (!entry) throw new Error("This task is not assigned to you.");
  const failure =
    entry.latestDelivery?.status === "failed"
      ? `\n⚠️ Reminder delivery unavailable: ${entry.latestDelivery.error ?? "unknown reason"}`
      : "";
  const isCreator = entry.task.createdByUserId === userId;
  const components = [
    buttonRow(
      ...(entry.assignment.status === "open"
        ? [{ customId: `task-complete:${entry.assignment.id}`, label: "Mark done", style: ButtonStyle.Success }]
        : []),
      { customId: `task-reminder:${entry.assignment.id}`, label: "Reminder settings", style: ButtonStyle.Secondary },
      ...(isCreator
        ? [
            { customId: `task-edit:${entry.task.id}`, label: "Edit", style: ButtonStyle.Secondary },
            { customId: `task-due:${entry.task.id}:0`, label: "Due date", style: ButtonStyle.Secondary },
            { customId: `task-cancel:${entry.task.id}`, label: "Cancel", style: ButtonStyle.Danger },
          ]
        : []),
    ),
    buttonRow({ customId: "task-back", label: "Back to task list", style: ButtonStyle.Secondary }),
  ];
  return {
    content: `**${entry.task.title}**\n${entry.task.description ?? "No description."}\nDue: ${formatDue(entry.task.dueAt, entry.task.timeZone)}\nCreated by: ${entry.creatorName}\nYour status: ${entry.assignment.status}${failure}`,
    components,
  };
}

function dueDatePage(taskId: string, page: number, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + page * 24);
  const options = Array.from({ length: 24 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const value = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
    return {
      label: date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }),
      value,
    };
  });
  return {
    content: "Choose a due date. Dates are shown in the organization timezone.",
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`task-due-date:${taskId}:${page}`)
          .setPlaceholder("Choose a date")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(options),
      ),
      buttonRow(
        ...(page > 0 ? [{ customId: `task-due:${taskId}:${page - 1}`, label: "Earlier", style: ButtonStyle.Secondary }] : []),
        { customId: `task-due:${taskId}:${page + 1}`, label: "Later", style: ButtonStyle.Secondary },
        { customId: `task-clear-due:${taskId}`, label: "No due date", style: ButtonStyle.Secondary },
      ),
    ],
  };
}

function createTaskModal() {
  return new ModalBuilder()
    .setCustomId("task:create")
    .setTitle("Create task")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Task title")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setPlaceholder("Prepare sponsor outreach"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Details (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(2000)
          .setPlaceholder("What needs to be done?"),
      ),
    );
}

function editTaskModal(taskId: string, title: string, description: string | null) {
  return new ModalBuilder()
    .setCustomId(`task-edit:${taskId}`)
    .setTitle("Edit task")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Task title")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setValue(title.slice(0, 100)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Details (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(2000)
          .setValue((description ?? "").slice(0, 2000)),
      ),
    );
}

async function replyEphemeral(
  interaction: ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction,
  view: { content: string; components?: MessageRow[] },
): Promise<void> {
  const payload = {
    content: view.content,
    components: view.components ?? [],
    allowedMentions: ALLOWED_MENTIONS,
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
    return;
  }
  if (interaction.isMessageComponent()) {
    await interaction.update(payload);
    return;
  }
  await interaction.reply({ ...payload, ephemeral: true });
}

async function handleTaskCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "create") {
    const gate = createGate(interaction);
    if (!gate.ok) {
      await interaction.reply({
        content:
          gate.reason === "role-gate"
            ? "You need an eboard trigger role to create tasks."
            : "Create tasks from an allowlisted eboard channel.",
        ephemeral: true,
        allowedMentions: ALLOWED_MENTIONS,
      });
      return;
    }
    await interaction.showModal(createTaskModal());
    return;
  }
  if (sub === "preferences") {
    await interaction.reply({
      content: "Choose your default task reminder behavior.",
      ephemeral: true,
      components: [reminderPolicySelect("task-preferences")],
      allowedMentions: ALLOWED_MENTIONS,
    });
    return;
  }
  await replyEphemeral(interaction, taskListContent(interaction.user.id));
}

async function handleMeetCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const gate = meetGate(interaction);
  if (!gate.ok) {
    await interaction.reply({
      content:
        gate.reason === "role-gate"
          ? "Only Eboard (or Leadership / Senior Adv) can use /meet."
          : "Use /meet from an allowlisted eboard channel.",
      ephemeral: true,
      allowedMentions: ALLOWED_MENTIONS,
    });
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub === "seed") {
    await interaction.reply({
      content: "Queued roster seed. Grok (hello@) will read the F26 sheet and I'll store Discord→email bindings. The result will post in this channel.",
      ephemeral: true,
      allowedMentions: ALLOWED_MENTIONS,
    });
    if (interaction.guild) {
      await interaction.guild.members.fetch().catch(() => undefined);
    }
    // Only the roles that can actually appear on the F26 sheet. Seeding every
    // non-bot guild member sent hundreds of unrelated usernames to a remote
    // worker, buried the real roster in noise, and pushed `job.content` toward
    // the generic dispatcher's 4,000-character truncation (issue #89 item 2) --
    // past which the wakeup payload is invalid JSON rather than a short list.
    //
    // Deliberately the whole MEET_INVOKE set, not the bare @Eboard snowflake:
    // someone carrying only Leadership or Senior Adv is still on the sheet, and
    // dropping them here would silently make them un-inviteable later.
    const members = [...(interaction.guild?.members.cache.values() ?? [])]
      .filter((member) =>
        isRosterSeedCandidate({
          isBot: member.user.bot,
          roleIds: [...member.roles.cache.keys()],
        }),
      )
      .map((member) => ({
        id: member.id,
        username: member.user.username ?? null,
        global_name: member.user.globalName ?? null,
        nick: member.nickname ?? null,
      }));
    const content = serializeRosterSeedPack(buildRosterSeedPack(members));
    const result = await tryEnqueueJob(
      {
        discordMessageId: ephemeralSlashAckMessageId(interaction.id),
        discordChannelId: interaction.channelId,
        discordThreadId: null,
        parentChannelId: interactionParentId(interaction),
        authorId: interaction.user.id,
        authorIsBot: Boolean(interaction.user.bot),
        authorRoleIds: interactionRoleIds(interaction),
        content,
        mentionedBot: true,
        replyToBot: false,
        // Not "slash": the seed needs Grok's Sheets/Gmail tooling (the ack
        // promises it), so it belongs in the background lane, which is never
        // routed to the SDK sibling and is capped separately from /ask.
        source: "coordinator",
      },
      {
        canViewChannel: (id) =>
          authorCanViewChannel({ member: interaction.member, guild: interaction.guild }, id),
      },
    );
    if (result.skipped && result.skipped !== "duplicate") {
      await interaction.editReply({ content: `Could not queue seed (${result.skipped}).` }).catch(() => undefined);
    }
    return;
  }
  if (sub === "cancel") {
    const meetingId = interaction.options.getString("meeting_id", true).trim();
    const result = cancelMeeting({ meetingId, creatorUserId: interaction.user.id });
    const outcomes = await publish(result.outboxEvents);
    await interaction.reply({
      content: handoffMessage(
        outcomes,
        "Meeting cancelled. The Calendar event is being cancelled.",
        "Meeting cancelled. Calendar cancellation is queued for automatic retry.",
      ),
      ephemeral: true,
      allowedMentions: ALLOWED_MENTIONS,
    });
    return;
  }

  // A modal must be the FIRST response to the interaction -- it cannot follow a
  // defer -- so nothing may be awaited before this.
  await interaction.showModal(meetCreateModal());
}

const ORG_TIME_ZONE = "America/New_York";

/**
 * One box instead of five slash options. Discord has no date picker of any
 * kind, so the honest alternatives are a text field or a multi-hop select-menu
 * maze; the maze is what made `/task`'s due date four round trips. A forgiving
 * parser plus a preview that echoes the parse back is cheaper and clearer.
 *
 * Five inputs is Discord's hard maximum for a modal. Timezone did not make the
 * cut: it was a slash option nobody filled in sensibly, the org runs on one
 * zone, and anyone who genuinely needs another can type an ISO string with an
 * offset into `when`, which the parser accepts.
 */
export function meetCreateModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("meet:create")
    .setTitle("New meeting")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Title")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("when")
          .setLabel("When")
          .setPlaceholder("friday 2pm · tomorrow 3:30pm · sep 4 2pm · 2026-09-04 14:00")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("duration")
          .setLabel("Duration (blank = 30m)")
          .setPlaceholder("30m · 1h · 1h30")
          .setStyle(TextInputStyle.Short)
          .setRequired(false),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("location")
          .setLabel("Location (optional)")
          .setPlaceholder("Bobst 5th floor · a Zoom link · leave blank for Meet only")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(500)
          .setRequired(false),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("notes")
          .setLabel("Notes (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(false),
      ),
    );
}

/** Optional modal fields throw rather than return "" when left empty. */
function optionalField(interaction: ModalSubmitInteraction, id: string): string | null {
  try {
    return interaction.fields.getTextInputValue(id).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The audience controls: one string select per page of the roster, plus a
 * one-click button for the whole F26 roster.
 *
 * A mentionable select would list the entire guild -- Discord has no role
 * filter for user pickers -- which offered hundreds of people who cannot be
 * invited at all, since only `roster_bindings` resolves to an address. Naming
 * @Eboard as a button also removes the need to know it was type-able.
 */
function audienceRows(draftId: string, picked: readonly string[] = []): MessageRow[] {
  const pages = rosterPickerPages();
  const rows: MessageRow[] = pages.map((page, index) => {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`meet-roster:${draftId}:${index}`)
      .setPlaceholder(pages.length > 1 ? `Attendees · ${pageLabel(page)}` : "Pick attendees")
      .setMinValues(0)
      .setMaxValues(page.length)
      .addOptions(
        page.map((option) => ({
          label: option.label,
          value: option.value,
          ...(option.description ? { description: option.description } : {}),
          // Keeps the menu showing what is already chosen across re-renders.
          default: picked.includes(option.value),
        })),
      );
    return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select);
  });

  rows.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`meet-roster-all:${draftId}`)
        .setLabel("Invite the whole F26 roster")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`meet-picked:${draftId}`)
        .setLabel("Continue with selected")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`meet-discard:${draftId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return rows;
}

/** Confirm/cancel pair, shown once an audience is settled. */
function confirmRow(draftId: string): MessageRow {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`meet-confirm:${draftId}`)
      .setLabel("Confirm & send invite")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`meet-discard:${draftId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

/** Re-render the header for a stored draft (the raw text is no longer around). */
function draftPreviewFor(draft: {
  title: string;
  startsAt: number;
  durationMinutes: number;
  location: string | null;
  notes: string | null;
}): string {
  const lines = [`📅 **${draft.title}**`, meetingWhenLine(draft.startsAt, draft.durationMinutes)];
  if (draft.location) lines.push(`📍 ${draft.location}`);
  return lines.join("\n");
}

export function selectedLine(participants: readonly { displayName: string }[]): string {
  if (participants.length === 0) return "No attendees picked yet.";
  const names = participants.map((p) => p.displayName);
  const shown = names.slice(0, 8).join(", ");
  const rest = names.length - 8;
  return `**${names.length} selected:** ${shown}${rest > 0 ? ` +${rest} more` : ""}`;
}

/** What the organizer sees before any invitation goes out. */
export function confirmSummary(draft: {
  title: string;
  startsAt: number;
  durationMinutes: number;
  location: string | null;
  notes: string | null;
  audience: { audienceKind: "picked" | "f26_roster"; participants: Array<{ userId: string }> } | null;
}): string {
  const count = draft.audience?.participants.length ?? 0;
  const who =
    draft.audience?.audienceKind === "f26_roster"
      ? `**the full F26 roster**${count > 0 ? ` plus ${count} more` : ""}`
      : `**${count} ${count === 1 ? "person" : "people"}**`;
  const lines = [
    `📅 **${draft.title}**`,
    meetingWhenLine(draft.startsAt, draft.durationMinutes),
  ];
  if (draft.location) lines.push(`📍 ${draft.location}`);
  lines.push("", `Inviting ${who}. A Google Meet link is created automatically.`);
  lines.push("-# Confirming sends real calendar invitations.");
  return lines.join("\n");
}

/** The in-channel post. Shared time formatting with the preview by construction. */
export function meetingAnnouncement(
  meeting: { title: string; startsAt: number; endsAt: number; location: string | null; id: string; audienceKind: "picked" | "f26_roster" },
  participantCount: number,
): string {
  const durationMinutes = Math.max(1, Math.round((meeting.endsAt - meeting.startsAt) / 60_000));
  const lines = [`📅 **${meeting.title}**`, meetingWhenLine(meeting.startsAt, durationMinutes)];
  if (meeting.location) lines.push(`📍 ${meeting.location}`);
  lines.push(
    meeting.audienceKind === "f26_roster"
      ? "Invited: F26 roster (role is not expanded)."
      : `Invited: ${participantCount} attendee(s).`,
  );
  lines.push(`Meeting ID: \`${meeting.id}\``);
  return lines.join("\n");
}

async function handleMeetCreateModal(interaction: ModalSubmitInteraction): Promise<void> {
  const title = interaction.fields.getTextInputValue("title").trim();
  const rawWhen = interaction.fields.getTextInputValue("when").trim();
  const timeZone = ORG_TIME_ZONE;
  // Both parsers throw WhenParseError with a message written for a human; the
  // shared handler shows it verbatim, so a bad time is a correctable mistake
  // rather than a stack trace.
  const startsAt = parseWhenInput(rawWhen, timeZone).getTime();
  const durationMinutes = parseDurationInput(optionalField(interaction, "duration") ?? "", 30);

  const draft = createMeetingDraft({
    createdByUserId: interaction.user.id,
    channelId: interaction.channelId ?? "",
    title,
    startsAt,
    durationMinutes,
    timeZone,
    notes: optionalField(interaction, "notes"),
    location: optionalField(interaction, "location"),
  });

  await interaction.reply({
    content: draftPreview({
      title,
      startsAtMs: startsAt,
      durationMinutes,
      rawWhen,
      notes: draft.notes,
    }),
    ephemeral: true,
    components: audienceRows(draft.id),
    allowedMentions: ALLOWED_MENTIONS,
  });
}

async function resolveComponentAudience(
  interaction: MessageComponentInteraction,
): Promise<Array<{ userId: string; displayName: string }>> {
  if (!interaction.isMentionableSelectMenu()) throw new Error("Choose Discord users or roles.");
  const selections = extractMentionableAudience({
    values: [...interaction.values],
    resolved: {
      users: Object.fromEntries(
        [...interaction.users.entries()].map(([id, user]) => [
          id,
          { username: user.username, global_name: user.globalName },
        ]),
      ),
      roles: Object.fromEntries([...interaction.roles.entries()].map(([id]) => [id, { id }])),
    },
  });
  const people = await expandAudience({ selections, guild: interaction.guild });
  if (people.length === 0) throw new Error("That selection did not resolve to any Discord users.");
  return people;
}

async function saveTaskDueDate(
  interaction: MessageComponentInteraction,
  taskId: string,
  date: string,
  hour: number,
  minute: number,
): Promise<void> {
  const task = getTaskForCreator(taskId, interaction.user.id);
  if (!task) throw new Error("Only the task creator can set this due date.");
  const dueAt = dateInTimeZone(date, hour, minute, task.timeZone);
  if (dueAt.getTime() <= Date.now()) throw new Error("Choose a due time in the future.");
  const result = updateTask({ taskId, creatorUserId: interaction.user.id, dueAt: dueAt.getTime() });
  await publish(result.outboxEvents);
  await replyEphemeral(interaction, composerContent(taskId));
}

async function announceMeeting(
  client: Client,
  channelId: string,
  content: string,
): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !("send" in channel)) return;
  await (channel as TextBasedChannel & { send: (opts: unknown) => Promise<unknown> }).send({
    content,
    allowedMentions: ALLOWED_MENTIONS,
  });
}

async function handleComponent(interaction: MessageComponentInteraction): Promise<void> {
  const [kind, value, extra] = interaction.customId.split(":");
  if (kind === "task-select" && interaction.isStringSelectMenu()) {
    const assignmentId = interaction.values[0];
    if (!assignmentId) throw new Error("Choose a task first.");
    await replyEphemeral(interaction, assignmentCard(assignmentId, interaction.user.id));
    return;
  }
  if (kind === "task-back") {
    await replyEphemeral(interaction, taskListContent(interaction.user.id));
    return;
  }
  if (kind === "task-owner" && value) {
    if (!getTaskForCreator(value, interaction.user.id)) throw new Error("Only the task creator can edit this task.");
    await replyEphemeral(interaction, composerContent(value));
    return;
  }
  if (kind === "task-audience" && value) {
    const people = await resolveComponentAudience(interaction);
    const result = addTaskAssignments({
      taskId: value,
      creatorUserId: interaction.user.id,
      assignees: people,
    });
    await publish(result.outboxEvents);
    await replyEphemeral(interaction, composerContent(value));
    return;
  }
  if (kind === "task-activate" && value) {
    const result = activateTask({ taskId: value, creatorUserId: interaction.user.id });
    await publish(result.outboxEvents);
    await replyEphemeral(interaction, composerContent(value));
    return;
  }
  if (kind === "task-complete" && value) {
    completeTaskAssignment({ assignmentId: value, userId: interaction.user.id });
    await replyEphemeral(interaction, {
      content: "Marked done. Your task reminders have stopped.",
      components: [],
    });
    return;
  }
  if (kind === "task-reminder" && value) {
    await replyEphemeral(interaction, {
      content: "Choose a reminder setting for this task.",
      components: [
        reminderPolicySelect(`task-reminder-select:${value}`),
        buttonRow({ customId: `task-reminder-card:${value}`, label: "Back to task", style: ButtonStyle.Secondary }),
      ],
    });
    return;
  }
  if (kind === "task-reminder-select" && value && interaction.isStringSelectMenu()) {
    const chosen = interaction.values[0];
    if (!chosen) throw new Error("Choose a reminder setting.");
    const policy = chosen === "default" ? undefined : chosen;
    if (policy && !isTaskReminderPolicy(policy)) throw new Error("Choose a reminder setting.");
    const result = setTaskAssignmentReminderOverride({
      assignmentId: value,
      userId: interaction.user.id,
      policy: policy as TaskReminderPolicy | undefined,
    });
    await publish(result.outboxEvents);
    await replyEphemeral(interaction, assignmentCard(value, interaction.user.id));
    return;
  }
  if (kind === "task-preferences" && interaction.isStringSelectMenu()) {
    const selected = interaction.values[0];
    if (!selected || !isTaskReminderPolicy(selected)) throw new Error("Choose a default reminder setting.");
    const events = setPersonTaskReminderPreference({ userId: interaction.user.id, defaultPolicy: selected });
    await publish(events);
    await replyEphemeral(interaction, {
      content: `Your default task reminder is now **${formatReminderPolicy(selected)}**. Open tasks using your default were rescheduled.`,
      components: [reminderPolicySelect("task-preferences", selected)],
    });
    return;
  }
  if (kind === "task-edit" && value) {
    const task = getTaskForCreator(value, interaction.user.id);
    if (!task) throw new Error("Only the task creator can edit this task.");
    await interaction.showModal(editTaskModal(value, task.title, task.description));
    return;
  }
  if (kind === "task-due" && value) {
    await replyEphemeral(interaction, dueDatePage(value, Number(extra ?? "0")));
    return;
  }
  if (kind === "task-due-date" && value && interaction.isStringSelectMenu()) {
    const date = interaction.values[0];
    if (!date) throw new Error("Choose a date.");
    await replyEphemeral(interaction, {
      content: `Choose a time for ${date}.`,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`task-due-hour:${value}:${date}`)
            .setPlaceholder("Choose a time")
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions([
              { value: "end", label: "End of day (5:00 PM)" },
              ...Array.from({ length: 24 }, (_, hour) => ({
                value: String(hour),
                label: new Date(2000, 0, 1, hour).toLocaleTimeString("en-US", { hour: "numeric" }),
              })),
            ]),
        ),
      ],
    });
    return;
  }
  if (kind === "task-due-hour" && value && interaction.isStringSelectMenu()) {
    const date = extra;
    const hour = interaction.values[0];
    if (!date || hour === undefined) throw new Error("Choose a date and time.");
    if (hour === "end") {
      await saveTaskDueDate(interaction, value, date, 17, 0);
      return;
    }
    await replyEphemeral(interaction, {
      content: `Choose minutes past ${new Date(2000, 0, 1, Number(hour)).toLocaleTimeString("en-US", { hour: "numeric" })}.`,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`task-due-minute:${value}:${date}:${hour}`)
            .setPlaceholder("Choose minutes")
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(["00", "15", "30", "45"].map((minute) => ({ value: minute, label: `:${minute}` }))),
        ),
      ],
    });
    return;
  }
  if (kind === "task-due-minute" && value && interaction.isStringSelectMenu()) {
    const parts = interaction.customId.split(":");
    const date = parts[2];
    const hour = parts[3];
    const minute = interaction.values[0];
    if (!date || hour === undefined || !minute) throw new Error("Choose a date and time.");
    await saveTaskDueDate(interaction, value, date, Number(hour), Number(minute));
    return;
  }
  if (kind === "task-clear-due" && value) {
    const result = updateTask({ taskId: value, creatorUserId: interaction.user.id, dueAt: null });
    await publish(result.outboxEvents);
    await replyEphemeral(interaction, composerContent(value));
    return;
  }
  if (kind === "task-cancel" && value) {
    cancelTask({ taskId: value, creatorUserId: interaction.user.id });
    await replyEphemeral(interaction, {
      content: "Task cancelled. No further reminders will be sent.",
      components: [],
    });
    return;
  }
  if (kind === "task-reminder-card" && value) {
    await replyEphemeral(interaction, assignmentCard(value, interaction.user.id));
    return;
  }
  if (kind === "meet-roster" && value) {
    // customId is meet-roster:<draftId>:<pageIndex>, already split above, so the
    // page arrives as `extra`. Draft ids are UUIDs and carry no colons.
    const draftId = value;
    const pageIndex = Number(extra ?? "0");
    if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new Error("This action has expired.");
    const draft = getMeetingDraft(draftId, interaction.user.id);
    if (!draft) throw new Error("This meeting draft expired. Run /meet create again.");

    const pages = rosterPickerPages();
    const page = pages[pageIndex];
    if (!page) throw new Error("This action has expired.");

    // A role pick is all-or-nothing, so touching the per-person list means the
    // organizer is building a picked audience, not the roster dump.
    const existing = draft.audience?.audienceKind === "picked" ? draft.audience.participants : [];
    const participants = mergePageSelection({
      existing,
      page,
      selectedIds: interaction.isStringSelectMenu() ? [...interaction.values] : [],
    });
    const saved = setMeetingDraftAudience(draftId, interaction.user.id, {
      audienceKind: "picked",
      participants,
    });
    if (!saved) throw new Error("This meeting draft expired. Run /meet create again.");

    await replyEphemeral(interaction, {
      content: `${draftPreviewFor(saved)}\n\n${selectedLine(participants)}`,
      components: audienceRows(draftId, participants.map((p) => p.userId)),
    });
    return;
  }
  if (kind === "meet-roster-all" && value) {
    const saved = setMeetingDraftAudience(value, interaction.user.id, {
      audienceKind: "f26_roster",
      participants: [],
    });
    if (!saved) throw new Error("This meeting draft expired. Run /meet create again.");
    await replyEphemeral(interaction, {
      content: confirmSummary(saved),
      components: [confirmRow(value)],
    });
    return;
  }
  if (kind === "meet-picked" && value) {
    const draft = getMeetingDraft(value, interaction.user.id);
    if (!draft) throw new Error("This meeting draft expired. Run /meet create again.");
    if (!draft.audience || draft.audience.participants.length === 0) {
      throw new Error("Pick at least one attendee, or use the F26 roster button.");
    }
    await replyEphemeral(interaction, {
      content: confirmSummary(draft),
      components: [confirmRow(value)],
    });
    return;
  }
  if (kind === "meet-discard" && value) {
    // Claim consumes the row, so a discarded draft cannot be confirmed later.
    claimMeetingDraft(value, interaction.user.id);
    await replyEphemeral(interaction, {
      content: "Discarded. Nothing was booked and no invitations were sent.",
      components: [],
    });
    return;
  }
  if (kind === "meet-confirm" && value) {
    // Single-shot: two fast clicks cannot both book. The second gets null.
    const draft = claimMeetingDraft(value, interaction.user.id);
    if (!draft) throw new Error("This meeting draft expired. Run /meet create again.");
    if (!draft.audience) throw new Error("Pick who to invite first, then confirm.");

    const people = draft.audience.participants;
    const audienceKind = draft.audience.audienceKind;
    const result = createScheduledMeeting({
      createdByUserId: draft.createdByUserId,
      title: draft.title,
      startsAt: draft.startsAt,
      durationMinutes: draft.durationMinutes,
      timeZone: draft.timeZone,
      notes: draft.notes,
      location: draft.location,
      channelId: draft.channelId,
      participants: people,
      audienceKind,
    });
    const outcomes = await publish(result.outboxEvents);
    if (interaction.client.isReady() && draft.channelId) {
      try {
        await announceMeeting(interaction.client, draft.channelId, meetingAnnouncement(result.meeting, people.length));
      } catch (err) {
        logger.warn({ err, meetingId: result.meeting.id }, "meeting.announce.failed");
      }
    }
    await replyEphemeral(interaction, {
      content: `${handoffMessage(
        outcomes,
        "Meeting scheduled. The Calendar invite is on its way.",
        "Meeting scheduled. Calendar sync is queued for automatic retry.",
      )}\nMeeting ID: \`${result.meeting.id}\``,
      components: [],
    });
    return;
  }
  throw new Error("This action has expired.");
}

async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.customId === "task:create") {
    const title = interaction.fields.getTextInputValue("title");
    let description: string | null = null;
    try {
      description = interaction.fields.getTextInputValue("description");
    } catch {
      description = null;
    }
    const task = createTaskDraft({
      createdByUserId: interaction.user.id,
      title,
      description,
      channelId: interaction.channelId,
    });
    await replyEphemeral(interaction, composerContent(task.id));
    return;
  }
  if (interaction.customId === "meet:create") {
    await handleMeetCreateModal(interaction);
    return;
  }
  if (interaction.customId.startsWith("task-edit:")) {
    const taskId = interaction.customId.slice("task-edit:".length);
    let description: string | null = "";
    try {
      description = interaction.fields.getTextInputValue("description");
    } catch {
      description = "";
    }
    const result = updateTask({
      taskId,
      creatorUserId: interaction.user.id,
      title: interaction.fields.getTextInputValue("title"),
      description,
    });
    await publish(result.outboxEvents);
    await replyEphemeral(interaction, composerContent(taskId));
    return;
  }
  throw new Error("This form has expired.");
}

export async function handleCoordinatorInteraction(interaction: Interaction): Promise<boolean> {
  const isCommand =
    interaction.isChatInputCommand() &&
    (interaction.commandName === "task" || interaction.commandName === "meet");
  const isComponent =
    interaction.isMessageComponent() &&
    /^(task-|meet-|task:|meet:)/.test(interaction.customId);
  const isModal =
    interaction.isModalSubmit() &&
    (interaction.customId === "task:create" ||
      interaction.customId === "meet:create" ||
      interaction.customId.startsWith("task-edit:"));
  if (!isCommand && !isComponent && !isModal) return false;

  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "task") {
      await handleTaskCommand(interaction);
      return true;
    }
    if (interaction.isChatInputCommand() && interaction.commandName === "meet") {
      await handleMeetCommand(interaction);
      return true;
    }
    if (interaction.isMessageComponent()) {
      await handleComponent(interaction);
      return true;
    }
    if (interaction.isModalSubmit()) {
      await handleModal(interaction);
      return true;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unable to complete that action.";
    logger.warn({ err, user_id: interaction.user.id }, "coordinator interaction failed");
    const payload = { content: message, ephemeral: true, allowedMentions: ALLOWED_MENTIONS };
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      }
    } catch (replyErr) {
      logger.warn({ err: replyErr }, "failed to reply to coordinator interaction error");
    }
  }
  return true;
}

export function formatMeetingAnnouncement(meetingId: string): string | null {
  const meeting = getMeeting(meetingId);
  if (!meeting) return null;
  const when = new Date(meeting.startsAt).toLocaleString("en-US", {
    timeZone: meeting.timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `📅 **${meeting.title}**\n${when}${meeting.meetLink ? `\nMeet: ${meeting.meetLink}` : ""}\nMeeting ID: \`${meeting.id}\``;
}
