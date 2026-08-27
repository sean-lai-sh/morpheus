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
import { tryEnqueueJob, type JobCandidate } from "./enqueue.ts";

export const ASK_COMMAND = new SlashCommandBuilder()
  .setName("ask")
  .setDescription("Ask Morpheus. Enqueues a Grok Bot job (same queue as @mentions).")
  .addStringOption((opt) =>
    opt.setName("question").setDescription("What to ask").setRequired(true).setMaxLength(2000),
  )
  .toJSON();

export async function registerGuildAskCommand(client: Client, guildId: string): Promise<void> {
  const token = discordBotToken();
  const appId = client.application?.id ?? client.user?.id;
  if (!appId) {
    logger.warn("cannot register /ask: application id missing");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [ASK_COMMAND] });
  logger.info({ guild_id: guildId }, "registered guild slash command /ask");
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

export async function handleAskInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "ask") return;
  if (!interaction.guildId) {
    await interaction.reply({
      content: "/ask only works in the guild.",
      ephemeral: true,
      allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
    });
    return;
  }

  const question = interaction.options.getString("question", true);
  const ack = await interaction.reply({
    content: "Queued.",
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
    content: question,
    mentionedBot: true,
    replyToBot: false,
    source: "slash",
  };

  const result = await tryEnqueueJob(candidate);
  if (result.skipped && result.skipped !== "duplicate") {
    logger.info(
      { skipped: result.skipped, user_id: interaction.user.id, channel_id: interaction.channelId },
      "/ask did not enqueue",
    );
    try {
      await interaction.editReply({ content: `Could not queue (${result.skipped}).` });
    } catch (err) {
      logger.warn({ err }, "failed to edit /ask ack");
    }
    return;
  }
}

export async function registerAskOnReady(client: Client): Promise<void> {
  const guildId = loadEnv().DISCORD_GUILD_ID;
  try {
    await registerGuildAskCommand(client, guildId);
  } catch (err) {
    logger.error({ err }, "failed to register /ask");
  }
}
