import { listAllRosterBindings, type RosterBindingRow } from "../storage/roster-map.ts";

/** Discord's hard ceiling on options in one string select. */
export const PICKER_PAGE_SIZE = 25;
/** Four pages is 100 people -- far past any plausible eboard. */
export const PICKER_MAX_PAGES = 4;

export interface PickerOption {
  label: string;
  value: string;
  description?: string;
}

export interface PickerParticipant {
  userId: string;
  displayName: string;
}

/**
 * Only people the Mini can actually invite, which is exactly `roster_bindings`.
 *
 * Discord offers no way to filter a user picker by role -- a mentionable select
 * always lists the whole guild -- so the way to stop offering people who cannot
 * be invited is to stop using a user picker and enumerate the roster instead.
 * The list is short and known, so this loses nothing but the noise.
 */
export function rosterPickerPages(
  bindings: RosterBindingRow[] = listAllRosterBindings(),
): PickerOption[][] {
  const sorted = [...bindings].sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );
  const pages: PickerOption[][] = [];
  for (let i = 0; i < sorted.length && pages.length < PICKER_MAX_PAGES; i += PICKER_PAGE_SIZE) {
    pages.push(
      sorted.slice(i, i + PICKER_PAGE_SIZE).map((row) => ({
        label: row.name.slice(0, 100),
        value: row.discordId,
        // The Discord handle disambiguates two people with the same real name.
        ...(row.disc ? { description: row.disc.slice(0, 100) } : {}),
      })),
    );
  }
  return pages;
}

/** Human-readable page label, e.g. "Arda – Karan". */
export function pageLabel(page: PickerOption[]): string {
  if (page.length === 0) return "Attendees";
  const first = page[0]!.label.split(" ")[0];
  const last = page[page.length - 1]!.label.split(" ")[0];
  return first === last ? `${first}` : `${first} – ${last}`;
}

/**
 * Fold one page's selection into the participants already chosen.
 *
 * Each string select reports only its own values, so a naive replace would wipe
 * everyone picked on the other page. Contributions are merged per page: drop
 * whatever this page previously contributed, then add what it now reports.
 * Order is stable so the confirm summary does not reshuffle between clicks.
 */
export function mergePageSelection(input: {
  existing: PickerParticipant[];
  page: PickerOption[];
  selectedIds: string[];
}): PickerParticipant[] {
  const pageIds = new Set(input.page.map((o) => o.value));
  const labelFor = new Map(input.page.map((o) => [o.value, o.label]));
  const kept = input.existing.filter((p) => !pageIds.has(p.userId));
  const added = input.selectedIds
    .filter((id) => pageIds.has(id))
    .map((id) => ({ userId: id, displayName: labelFor.get(id) ?? id }));
  const seen = new Set<string>();
  return [...kept, ...added].filter((p) => {
    if (seen.has(p.userId)) return false;
    seen.add(p.userId);
    return true;
  });
}
