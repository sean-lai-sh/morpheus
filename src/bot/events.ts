import { ChannelType, Events, type Client, type Message, type PartialMessage } from "discord.js";
import { logger } from "../logger.ts";
import { ingestDelete, ingestMessage } from "./ingest.ts";

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

export function registerLiveHandlers(client: Client): void {
  client.on(Events.MessageCreate, async (m) => {
    try {
      const full = await fetchIfPartial(m);
      if (!full) return;
      const r = await ingestMessage(full, threadParentId(full));
      if (r.action === "inserted" || r.action === "edited") {
        logger.debug(
          { message_id: full.id, channel_id: full.channelId, op: "live", action: r.action },
          "ingested",
        );
      }
    } catch (err) {
      logger.error({ err, id: m.id }, "MessageCreate handler error");
    }
  });

  client.on(Events.MessageUpdate, async (_old, m) => {
    try {
      const full = await fetchIfPartial(m as Message | PartialMessage);
      if (!full) return;
      const r = await ingestMessage(full, threadParentId(full));
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
}
