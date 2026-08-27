import { type FeedChannelKey } from "./channels.ts";

export type FeedKind =
  | "sponsor"
  | "partnership"
  | "pitch"
  | "collab"
  | "student"
  | "job"
  | "internship"
  | "fellowship"
  | "opportunity"
  | "speaker"
  | "guest"
  | "keynote"
  | "talk"
  | "unknown";

const SPONSOR_KINDS = new Set(["sponsor", "partnership", "pitch", "collab"]);
const OPPORTUNITY_KINDS = new Set([
  "student",
  "job",
  "internship",
  "fellowship",
  "opportunity",
]);
const SPEAKER_KINDS = new Set(["speaker", "guest", "keynote", "talk"]);

/**
 * Map an inbound/outbound kind onto a feed channel.
 * Unknown never guesses sponsors/opportunities/speakers — it goes to #inbox.
 */
export function routeFeedChannel(kind: string): FeedChannelKey {
  const k = kind.trim().toLowerCase();
  if (SPONSOR_KINDS.has(k)) return "sponsors";
  if (OPPORTUNITY_KINDS.has(k)) return "opportunities";
  if (SPEAKER_KINDS.has(k)) return "speakers";
  return "inbox";
}

/** Best-effort classify free text (hello@ subject + body). Explicit kind wins. */
export function routeFeedFromText(text: string): FeedChannelKey {
  const t = text.toLowerCase();
  if (/\b(sponsor|partnership|pitch|collab(?:oration)?)\b/.test(t)) return "sponsors";
  if (/\b(internship|fellow(?:ship)?|hiring|job\b|career|opportunit)/.test(t)) {
    return "opportunities";
  }
  if (/\b(speaker|keynote|guest talk|guest speaker)\b/.test(t)) return "speakers";
  return "inbox";
}
