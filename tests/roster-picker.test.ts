import { describe, expect, test } from "bun:test";
import {
  PICKER_PAGE_SIZE,
  mergePageSelection,
  pageLabel,
  rosterPickerPages,
  type PickerOption,
} from "../src/coordinator/roster-picker.ts";
import type { RosterBindingRow } from "../src/storage/roster-map.ts";

function binding(name: string, id: string, disc: string | null = null): RosterBindingRow {
  return { discordId: id, email: `${id}@nyu.edu`, name, disc, confidence: "disc", updatedAt: 0 };
}

describe("rosterPickerPages", () => {
  test("only roster-bound people are offered, sorted by name", () => {
    const pages = rosterPickerPages([binding("Zoe", "3"), binding("Ada", "1"), binding("Mia", "2")]);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.map((o) => o.label)).toEqual(["Ada", "Mia", "Zoe"]);
    expect(pages[0]!.map((o) => o.value)).toEqual(["1", "2", "3"]);
  });

  test("the Discord handle rides along to disambiguate duplicate names", () => {
    const pages = rosterPickerPages([binding("Sean Lai", "1", "shaszis"), binding("Sean Hu", "2")]);
    const withDisc = pages[0]!.find((o) => o.value === "1")!;
    expect(withDisc.description).toBe("shaszis");
    expect(pages[0]!.find((o) => o.value === "2")!.description).toBeUndefined();
  });

  test("splits at Discord's 25-option ceiling", () => {
    const many = Array.from({ length: 29 }, (_, i) =>
      binding(`P${String(i).padStart(2, "0")}`, String(i)),
    );
    const pages = rosterPickerPages(many);
    // 29 people is the real roster size; one select cannot hold them.
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(PICKER_PAGE_SIZE);
    expect(pages[1]).toHaveLength(4);
    const all = pages.flat().map((o) => o.value);
    expect(new Set(all).size).toBe(29);
  });

  test("an empty roster yields no pages rather than an empty menu", () => {
    expect(rosterPickerPages([])).toEqual([]);
  });
});

describe("pageLabel", () => {
  test("names the range by first name", () => {
    expect(pageLabel([{ label: "Ada Lovelace", value: "1" }, { label: "Karan Singh", value: "2" }])).toBe(
      "Ada – Karan",
    );
  });

  test("a single-person page does not render a range", () => {
    expect(pageLabel([{ label: "Ada Lovelace", value: "1" }])).toBe("Ada");
  });
});

describe("mergePageSelection", () => {
  const pageA: PickerOption[] = [
    { label: "Ada", value: "1" },
    { label: "Bo", value: "2" },
  ];
  const pageB: PickerOption[] = [
    { label: "Cy", value: "3" },
    { label: "Di", value: "4" },
  ];

  test("adds this page's picks", () => {
    expect(mergePageSelection({ existing: [], page: pageA, selectedIds: ["1"] })).toEqual([
      { userId: "1", displayName: "Ada" },
    ]);
  });

  test("does NOT wipe people chosen on another page", () => {
    // The whole reason merging exists: a select reports only its own values.
    const existing = [{ userId: "3", displayName: "Cy" }];
    expect(mergePageSelection({ existing, page: pageA, selectedIds: ["2"] })).toEqual([
      { userId: "3", displayName: "Cy" },
      { userId: "2", displayName: "Bo" },
    ]);
  });

  test("deselecting on this page removes only this page's people", () => {
    const existing = [
      { userId: "1", displayName: "Ada" },
      { userId: "3", displayName: "Cy" },
    ];
    expect(mergePageSelection({ existing, page: pageA, selectedIds: [] })).toEqual([
      { userId: "3", displayName: "Cy" },
    ]);
  });

  test("re-selecting the same page twice does not duplicate", () => {
    const once = mergePageSelection({ existing: [], page: pageB, selectedIds: ["3", "4"] });
    const twice = mergePageSelection({ existing: once, page: pageB, selectedIds: ["3", "4"] });
    expect(twice).toHaveLength(2);
    expect(twice.map((p) => p.userId)).toEqual(["3", "4"]);
  });

  test("ids not on this page are ignored, never invented", () => {
    expect(mergePageSelection({ existing: [], page: pageA, selectedIds: ["999"] })).toEqual([]);
  });
});
