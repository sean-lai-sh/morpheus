import { ChannelType, Events, type Client, type Message, type PartialMessage } from "discord.js";
import { logger } from "../logger.ts";
import { ingestDelete, ingestMessage } from "./ingest.ts";
import { handleReactionChange } from "./reactions.ts";
import { candidateFromMessage, tryEnqueueJob } from "./enqueue.ts";
import { authorCanViewChannel } from "./job-scope.ts";
import { handleJobCommandInteraction, registerJobCommandsOnReady } from "./commands.ts";
import { handleCoordinatorInteraction } from "./coordinator.ts";
import { tryHandleMeetingMentionFromMessage } from "./meeting-mention.ts";

async function fetchIfPartial(
  message: Message | PartialMessage,
): Promise<Message | null> {
  if (message.partial) {
    try {
      return await message.fetch();
    } catch (err) {
      logger.warn({ err, id: message.id }, "failed to fetch partial message");
      return null;
    }
  }
  return message;
}

/** Returns the parent text channel id if the message is in a thread, else null. */
function threadParentId(message: Message): string | null {
  const t = message.channel.type;
  if (
    t === ChannelType.PublicThread ||
    t === ChannelType.PrivateThread ||
    t === ChannelType.AnnouncementThread
  ) {
    return (message.channel as { parentId?: string | null }).parentId ?? null;
  }
  return null;
}

/** Returns the thread channel name if the message is in a thread, else null. */
function threadChannelName(message: Message): string | null {
  const t = message.channel.type;
  if (
    t === ChannelType.PublicThread ||
    t === ChannelType.PrivateThread ||
    t === ChannelType.AnnouncementThread
  ) {
    return (message.channel as { name?: string }).name ?? null;
  }
  return null;
}

export function registerLiveHandlers(client: Client): void {
  client.on(Events.MessageCreate, async (m) => {
    try {
      const full = await fetchIfPartial(m);
      if (!full) return;
      try {
        const parentId = threadParentId(full);
        const r = await ingestMessage(
          full,
          parentId,
          threadChannelName(full),
          parentId ? { updateCrawlCursors: false } : undefined,
        );
        if (r.action === "inserted" || r.action === "edited") {
          logger.debug(
            { message_id: full.id, channel_id: full.channelId, op: "live", action: r.action },
            "ingested",
          );
        }
      } catch (err) {
        logger.error({ err, id: m.id }, "MessageCreate ingest error");
      }
      try {
        const botId = client.user?.id;
        if (!botId) return;
        const meeting = await tryHandleMeetingMentionFromMessage(full, botId);
        if (meeting.handled) return;
        await tryEnqueueJob(candidateFromMessage(full, botId), {
          canViewChannel: (id) => authorCanViewChannel(full, id),
        });
      } catch (err) {
        logger.error({ err, id: m.id }, "MessageCreate job enqueue error");
      }
    } catch (err) {
      logger.error({ err, id: m.id }, "MessageCreate handler error");
    }
  });

  client.on(Events.MessageUpdate, async (_old, m) => {
    try {
      const full = await fetchIfPartial(m as Message | PartialMessage);
      if (!full) return;
      const parentId = threadParentId(full);
      const r = await ingestMessage(
        full,
        parentId,
        threadChannelName(full),
        parentId ? { updateCrawlCursors: false } : undefined,
      );
      logger.debug(
        { message_id: full.id, channel_id: full.channelId, op: "live", action: r.action },
        "edit ingested",
      );
    } catch (err) {
      logger.error({ err, id: m.id }, "MessageUpdate handler error");
    }
  });

  client.on(Events.MessageDelete, async (m) => {
    try {
      const r = await ingestDelete(m);
      logger.debug(
        { message_id: m.id, channel_id: m.channelId, op: "live", action: r.action },
        "delete handled",
      );
    } catch (err) {
      logger.error({ err, id: m.id }, "MessageDelete handler error");
    }
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      await handleReactionChange(reaction, user);
    } catch (err) {
      logger.error({ err, id: reaction.message.id }, "ReactionAdd handler error");
    }
  });

  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    try {
      await handleReactionChange(reaction, user);
    } catch (err) {
      logger.error({ err, id: reaction.message.id }, "ReactionRemove handler error");
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      const handled = await handleCoordinatorInteraction(interaction);
      if (!handled) await handleJobCommandInteraction(interaction);
    } catch (err) {
      logger.error({ err }, "InteractionCreate handler error");
    }
  });

  const registerCommands = () => {
    void registerJobCommandsOnReady(client);
  };
  if (client.isReady()) registerCommands();
  else client.once(Events.ClientReady, registerCommands);
}
