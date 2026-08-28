/**
 * Discord renders `<t:SECONDS:STYLE>` in each reader's own locale and timezone.
 * That is the closest thing Discord has to a calendar widget: instead of
 * printing a wall-clock string that is only correct for whoever typed it, every
 * viewer sees the meeting in their own time, and the relative form makes an
 * off-by-a-year typo obvious at a glance ("in 6 days" vs "in 1 year").
 *
 * Styles used here:
 *   F = "Friday, September 4, 2026 2:00 PM"
 *   R = "in 6 days"
 *   t = "2:00 PM"
 */
export function discordTimestamp(epochMs: number, style: "F" | "R" | "t" | "f" | "D"): string {
  return `<t:${Math.floor(epochMs / 1000)}:${style}>`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

/**
 * The meeting's own wall clock, in the org's timezone.
 *
 * `<t:...>` renders in the *reader's* timezone, which is the right default for
 * an announcement but actively confusing for the organizer: someone typing
 * "friday 2pm" from Singapore was shown "Saturday 02:00" and reasonably read
 * that as a parser bug. It was the same instant. Naming the org zone alongside
 * the local render removes the ambiguity for both audiences.
 */
export function orgWallClock(startsAtMs: number, timeZone: string): string {
  return new Date(startsAtMs).toLocaleString("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Short zone label, e.g. "EDT" -- what a person would say out loud. */
export function zoneAbbrev(startsAtMs: number, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(new Date(startsAtMs))
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

/**
 * The line every meeting surface shares: the booked wall clock in the org's
 * timezone, then the same instant rendered locally for whoever is reading.
 * Kept in one place so the draft preview and the in-channel announcement can
 * never disagree about a meeting's time.
 */
export function meetingWhenLine(
  startsAtMs: number,
  durationMinutes: number,
  timeZone = "America/New_York",
): string {
  return [
    `**${orgWallClock(startsAtMs, timeZone)} ${zoneAbbrev(startsAtMs, timeZone)}** · ${formatDuration(durationMinutes)}`,
    `${discordTimestamp(startsAtMs, "F")} · ${discordTimestamp(startsAtMs, "R")} in your local time`,
  ].join("\n");
}

/**
 * Preview shown before anything is booked. The user's own words for the time
 * are deliberately echoed back next to the parsed result: that is what turns a
 * loose parser from a hazard into a convenience -- a misread is visible here,
 * before 29 people get an invite.
 */
export function draftPreview(input: {
  title: string;
  startsAtMs: number;
  durationMinutes: number;
  rawWhen: string;
  notes: string | null;
  timeZone?: string;
}): string {
  const lines = [
    `📅 **${input.title}**`,
    meetingWhenLine(input.startsAtMs, input.durationMinutes, input.timeZone),
    `-# read as "${input.rawWhen}"`,
  ];
  if (input.notes) lines.push(`> ${input.notes.split("\n").join("\n> ")}`);
  lines.push("", "**Who's invited?** Add a role, specific people, or both.");
  return lines.join("\n");
}
