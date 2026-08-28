import { getRosterBinding, listAllRosterBindings } from "../storage/roster-map.ts";

export type MeetingAudienceKind = "picked" | "f26_roster";

export interface AttendeeResolution {
  /** Deduped, lowercased, stably ordered attendee addresses. */
  emails: string[];
  /** Participant snowflakes with no roster binding. */
  unresolved: string[];
  /**
   * Bindings the `f26_roster` audience contributed. Reported to the organizer so
   * a roster that is smaller than the sheet is visible rather than silent.
   */
  rosterCount: number;
}

interface AttendeeDeps {
  bindingFor?: (discordId: string) => { email: string } | null;
  allBindings?: () => Array<{ email: string }>;
}

/**
 * Turn a meeting audience into the addresses the Mini will put on the Calendar
 * invite. This is the reader `roster_bindings` never had: the whole point of
 * `/meet seed` is that this resolution happens here, on the box that holds the
 * map, so attendee emails never travel to a remote worker.
 *
 * `picked` invites exactly the chosen participants. `f26_roster` invites every
 * seeded binding *plus* any extra participants picked alongside the role -- the
 * audience helper keeps those snowflakes on the `f26_roster` kind rather than
 * downgrading the meeting to `picked`.
 *
 * Note the boundary: `f26_roster` here means "every F26 member the seed could
 * match to a Discord account", not "every Preferred Email on the sheet". Sheet
 * rows with no Discord match are surfaced as `unmatched` during the seed and are
 * not stored, so they cannot be invited from here. `rosterCount` exists so the
 * caller can show the organizer how many that actually was.
 */
export function resolveAttendeeEmails(
  input: { audience: MeetingAudienceKind; participantIds: string[] },
  deps: AttendeeDeps = {},
): AttendeeResolution {
  const bindingFor = deps.bindingFor ?? getRosterBinding;
  const allBindings = deps.allBindings ?? listAllRosterBindings;

  // Case-insensitive dedupe, but insertion order is preserved so the roster
  // block stays stable across reseeds and the picked extras trail it.
  const seen = new Set<string>();
  const emails: string[] = [];
  const push = (raw: string): void => {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) return;
    seen.add(email);
    emails.push(email);
  };

  let rosterCount = 0;
  if (input.audience === "f26_roster") {
    for (const row of allBindings()) {
      rosterCount += 1;
      push(row.email);
    }
  }

  const unresolved: string[] = [];
  for (const id of input.participantIds) {
    const binding = bindingFor(id);
    if (binding) push(binding.email);
    else unresolved.push(id);
  }

  return { emails, unresolved, rosterCount };
}
