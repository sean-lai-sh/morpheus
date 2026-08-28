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
 * The line every meeting surface shares: absolute time, how far away it is, and
 * how long it runs. Kept in one place so the draft preview and the in-channel
 * announcement can never disagree about a meeting's time.
 */
export function meetingWhenLine(startsAtMs: number, durationMinutes: number): string {
  return `${discordTimestamp(startsAtMs, "F")} · ${discordTimestamp(startsAtMs, "R")} · ${formatDuration(durationMinutes)}`;
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
}): string {
  const lines = [
    `📅 **${input.title}**`,
    meetingWhenLine(input.startsAtMs, input.durationMinutes),
    `-# read as "${input.rawWhen}" · shown in your local time`,
  ];
  if (input.notes) lines.push(`> ${input.notes.split("\n").join("\n> ")}`);
  lines.push("", "**Who's invited?** Pick @Eboard for the full F26 roster, or specific people.");
  return lines.join("\n");
}
