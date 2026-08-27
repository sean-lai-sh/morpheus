import {
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type Interaction,
} from "discord.js";
import { discordBotToken, loadEnv } from "../config.ts";
import { logger } from "../logger.ts";
import { tryEnqueueJob, type JobCandidate, type JobSource } from "./enqueue.ts";
import { authorCanViewChannel, mentionChannelIds } from "./job-scope.ts";

export const ASK_COMMAND = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("Ask Morpheus (interactive lane; same queue as @mentions).")
  .addStringOption((opt) =>
    opt.setName("question").setDescription("What to ask").setRequired(true).setMaxLength(2000),
  )
  .toJSON();

/**
 * Queued lane (#47 split): /background always dispatches to the Grok Bot
 * webhook — research, drafting, anything worth a longer worker turn (~2 min
 * wake is acceptable here). CURSOR_SDK_DISPATCH never steals this lane.
 * Same jobs/complete/message.reply contract and workspace isolation as /ask.
 */
export const BACKGROUND_COMMAND = new SlashCommandBuilder()
  .setName("background")
  .setDescription("Queue a longer background job for the Grok worker (research, drafting; takes minutes).")
  .addStringOption((opt) =>
    opt.setName("task").setDescription("What to research or draft").setRequired(true).setMaxLength(2000),
  )
  .toJSON();

interface JobCommandSpec {
  option: string;
  source: JobSource;
  ack: string;
}

/** Short acks only — the real answer arrives later via the job-complete reply. */
const JOB_COMMANDS: Record<string, JobCommandSpec> = {
  ask: { option: "question", source: "slash", ack: "Queued." },
  background: {
    option: "task",
    source: "background",
    ack: "Queued (background). The worker replies here when done — this lane can take a few minutes.",
  },
};

export async function registerGuildJobCommands(client: Client, guildId: string): Promise<void> {
  const token = discordBotToken();
  const appId = client.application?.id ?? client.user?.id;
  if (!appId) {
    logger.warn("cannot register slash commands: application id missing");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(appId, guildId), {
    body: [ASK_COMMAND, BACKGROUND_COMMAND],
  });
  logger.info({ guild_id: guildId }, "registered guild slash commands /ask and /background");
}

function interactionParentId(interaction: ChatInputCommandInteraction): string | null {
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

function interactionRoleIds(interaction: ChatInputCommandInteraction): string[] {
  const member = interaction.member;
  if (!member) return [];
  if (typeof (member as GuildMember).roles?.cache?.keys === "function") {
    return [...(member as GuildMember).roles.cache.keys()];
  }
  const apiRoles = (member as { roles?: string[] }).roles;
  return Array.isArray(apiRoles) ? apiRoles : [];
}

export async function handleJobCommandInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  const spec = JOB_COMMANDS[interaction.commandName];
  if (!spec) return;
  const name = interaction.commandName;

  if (!interaction.guildId) {
    await interaction.reply({
      content: `/${name} only works in the guild.`,
      ephemeral: true,
      allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
    });
    return;
  }

  const content = interaction.options.getString(spec.option, true);
  const ack = await interaction.reply({
    content: spec.ack,
    allowedMentions: {
      parse: [],
      users: [],
      roles: [],
      repliedUser: false,
    },
    fetchReply: true,
  });
  const parentId = interactionParentId(interaction);

  const candidate: JobCandidate = {
    discordMessageId: ack.id,
    discordChannelId: interaction.channelId,
    discordThreadId: parentId ? interaction.channelId : null,
    parentChannelId: parentId,
    authorId: interaction.user.id,
    authorIsBot: Boolean(interaction.user.bot),
    authorRoleIds: interactionRoleIds(interaction),
    content,
    mentionedBot: true,
    replyToBot: false,
    source: spec.source,
    mentionedChannelIds: mentionChannelIds({ content }),
  };

  const result = await tryEnqueueJob(candidate, {
    canViewChannel: (id) =>
      authorCanViewChannel(
        {
          member: interaction.member,
          guild: interaction.guild,
        },
        id,
      ),
  });
  if (result.skipped && result.skipped !== "duplicate") {
    logger.info(
      { skipped: result.skipped, user_id: interaction.user.id, channel_id: interaction.channelId, command: name },
      `/${name} did not enqueue`,
    );
    try {
      await interaction.editReply({ content: `Could not queue (${result.skipped}).` });
    } catch (err) {
      logger.warn({ err }, `failed to edit /${name} ack`);
    }
    return;
  }
}

export async function registerJobCommandsOnReady(client: Client): Promise<void> {
  const guildId = loadEnv().DISCORD_GUILD_ID;
  try {
    await registerGuildJobCommands(client, guildId);
  } catch (err) {
    logger.error({ err }, "failed to register slash commands");
  }
}
