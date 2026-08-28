import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { completeJobWithReply } from "../src/bot/reply.ts";
import {
  applyRosterSeedComplete,
  buildRosterSeedPack,
  formatRosterSeedAnnouncement,
  parseRosterSeedContent,
  serializeRosterSeedPack,
} from "../src/coordinator/seed-job.ts";
import { claimJob, enqueueJob, getJob } from "../src/storage/jobs.ts";
import { getRosterBinding } from "../src/storage/roster-map.ts";
import { getDb } from "../src/storage/db.ts";
import { withTempDb } from "./helpers.ts";
import { EBOARD, SPONSORS, withWorkspaceConfig } from "./jobs-fixture.ts";

const db = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;

beforeAll(() => {
  process.env.DISCORD_POST_REPLIES = "true";
  cfg = withWorkspaceConfig();
  getDb();
});

afterAll(() => {
  cfg.cleanup();
  db.cleanup();
});

describe("roster.seed pack", () => {
  test("outbound pack has members and no emails", () => {
    const pack = buildRosterSeedPack([
      { id: "11", username: "seanlai", global_name: "Sean Lai", nick: "Sean" },
    ]);
    const content = serializeRosterSeedPack(pack);
    expect(parseRosterSeedContent(content)?.kind).toBe("roster.seed");
    expect(content).toContain("seanlai");
    expect(content).toContain("1079418365");
    expect(content).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  });

  test("complete JSON persists bindings and announcement omits emails", () => {
    const pack = serializeRosterSeedPack(buildRosterSeedPack([]));
    const applied = applyRosterSeedComplete(
      pack,
      JSON.stringify({
        mappings: [
          {
            discord_id: "11",
            email: "sean@nyu.edu",
            name: "Sean Lai",
            disc: "seanlai",
            confidence: "disc",
          },
        ],
        unmatched: [{ name: "Marc Chen", disc: null, reason: "empty_disc" }],
      }),
    );
    expect(applied?.mapped).toBe(1);
    expect(getRosterBinding("11")?.email).toBe("sean@nyu.edu");
    const announcement = formatRosterSeedAnnouncement(applied!.mapped, applied!.unmatched);
    expect(announcement).toContain("Marc Chen");
    expect(announcement).not.toContain("sean@nyu.edu");
  });

  test("job complete stores announcement without emails and does not leak Grok JSON", async () => {
    const content = serializeRosterSeedPack(
      buildRosterSeedPack([{ id: "99", username: "sam", global_name: "Sam", nick: null }]),
    );
    const { job } = enqueueJob({
      discordMessageId: "seed-complete-1",
      discordChannelId: SPONSORS,
      discordThreadId: null,
      authorId: "creator-1",
      namespace: EBOARD,
      content,
    });
    claimJob(job.id, "grok-eboard");
    const posted: string[] = [];
    let fetched = 0;
    const result = await completeJobWithReply(
      job.id,
      "grok-eboard",
      {
        reply: JSON.stringify({
          mappings: [{ discord_id: "99", email: "sam@nyu.edu", name: "Sam", disc: "sam", confidence: "disc" }],
          unmatched: [{ name: "Zach", disc: null, reason: "empty_disc" }],
        }),
      },
      {
        postReplies: true,
        client: {
          channels: {
            fetch: async () => ({
              isTextBased: () => true,
              messages: {
                fetch: async () => {
                  fetched += 1;
                  throw Object.assign(new Error("Unknown Message"), { code: 10008 });
                },
              },
              send: async (opts: { content: string }) => {
                posted.push(opts.content);
                return { id: "chan-seed" };
              },
            }),
          },
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.posted).toBe(true);
    expect(result.job?.result_discord_message_id).toBe("chan-seed");
    expect(fetched).toBe(0);
    expect(getRosterBinding("99")?.email).toBe("sam@nyu.edu");
    expect(getJob(job.id)?.reply_text).not.toContain("sam@nyu.edu");
    expect(posted.join("")).toContain("Zach");
    expect(posted.join("")).not.toContain("sam@nyu.edu");
  });
});
