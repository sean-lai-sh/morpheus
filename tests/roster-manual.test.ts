import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  EXCLUDED_ROSTER_DISCORD_IDS,
  MANUAL_ROSTER_BINDINGS,
} from "../src/coordinator/roster-map.ts";
import { applyRosterSeedResult, getRosterBinding } from "../src/storage/roster-map.ts";
import { getDb } from "../src/storage/db.ts";
import { withTempDb } from "./helpers.ts";

const db = withTempDb();
beforeAll(() => {
  getDb();
});
afterAll(() => db.cleanup());

describe("manual empty-Disc roster upsert", () => {
  test("migrate upserts Marc, Zachary, Khidir, Fahim and not khidir_41052", () => {
    expect(MANUAL_ROSTER_BINDINGS).toHaveLength(4);
    expect(getRosterBinding("397295320859541514")?.name).toBe("Marc Lam");
    expect(getRosterBinding("461685240138694667")?.name).toBe("Zachary Kublaisingh");
    expect(getRosterBinding("780412168754561045")?.name).toBe("Khidir Ahmed");
    expect(getRosterBinding("196692594443550720")?.name).toBe("Fahim Hussain");
    expect(getRosterBinding("1379449057474379819")).toBeNull();
    expect(getRosterBinding("397295320859541514")?.email).toBe("marc.lam@nyu.edu");
    expect(getRosterBinding("461685240138694667")?.email).toBe("zjk2012@nyu.edu");
    expect(getRosterBinding("780412168754561045")?.email).toBe("kka6822@nyu.edu");
    expect(getRosterBinding("196692594443550720")?.email).toBe("fmh9301@nyu.edu");
    for (const row of MANUAL_ROSTER_BINDINGS) {
      expect(row.confidence).toBe("name");
    }
  });

  test("seed complete cannot bind the excluded Khidir alt", () => {
    applyRosterSeedResult({
      mappings: [
        {
          discord_id: "1379449057474379819",
          email: "kka6822@nyu.edu",
          name: "Khidir Ahmed",
          disc: "khidir_41052",
          confidence: "name",
        },
      ],
    });
    expect(getRosterBinding("1379449057474379819")).toBeNull();
    expect(getRosterBinding("780412168754561045")?.discordId).toBe("780412168754561045");
    expect(EXCLUDED_ROSTER_DISCORD_IDS.has("1379449057474379819")).toBe(true);
  });
});
