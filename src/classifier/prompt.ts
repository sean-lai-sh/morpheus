import { z } from "zod";

const labelSchema = z.enum(["operational", "discussion", "noise"]);

export const batchResponseSchema = z.object({
  classifications: z
    .array(
      z.object({
        index: z.number().int().min(0),
        label: labelSchema,
        confidence: z.number().min(0).max(1),
      }),
    )
    .min(1),
});

export type BatchResponse = z.infer<typeof batchResponseSchema>;

export interface BatchItem {
  index: number;
  channelName: string;
  authorName: string;
  content: string;
}

export function buildPrompt(items: BatchItem[]): { system: string; user: string } {
  const system = `You classify Discord messages from a college student club's executive board server.

Labels (pick exactly one per message):
- operational: decisions, action items, deadlines, doc/sheet/form links, announcements, logistics, scheduling, budget, vendor contacts, RSVP counts, room assignments
- discussion: substantive back-and-forth that adds context to operational decisions (rationale, alternatives considered, tradeoffs, blocking concerns)
- noise: chitchat, reactions in text ("lol", "same", "ty"), off-topic, memes, greetings without content, single-emoji content

When in doubt between operational and discussion, prefer operational if the message contains a concrete artifact (link, number, date, name). Prefer discussion if it's reasoning. Reserve noise for messages that wouldn't help anyone catching up later.

Output ONLY a JSON object matching this schema, with one entry per message:
{"classifications":[{"index":0,"label":"operational","confidence":0.9}, ...]}

Confidence is your subjective certainty 0..1. Always include every input index.`;

  const list = items
    .map(
      (it) =>
        `${it.index}. [#${it.channelName}] @${it.authorName}: ${truncate(it.content, 800)}`,
    )
    .join("\n");
  const user = `Classify each of the following ${items.length} messages.\n\n${list}`;
  return { system, user };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
