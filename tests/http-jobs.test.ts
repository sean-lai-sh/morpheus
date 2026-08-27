import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import {
  DEV_CHAT,
  DEV_TOKEN,
  EBOARD,
  EBOARD_TOKEN,
  LEADERSHIP,
  LEADERSHIP_TEAM,
  LEADERSHIP_TOKEN,
  PROGRAMS_DEV,
  SPONSORS,
  withWorkspaceConfig,
} from "./jobs-fixture.ts";
import { handleHttpRequest } from "../src/http/health.ts";
import { claimJob, enqueueJob, getJob } from "../src/storage/jobs.ts";
import { resetEnvForTest } from "../src/config.ts";

const db = withTempDb();
let cfg: ReturnType<typeof withWorkspaceConfig>;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  saved.DISCORD_POST_REPLIES = process.env.DISCORD_POST_REPLIES;
  process.env.DISCORD_POST_REPLIES = "false";
  cfg = withWorkspaceConfig();
});

afterAll(() => {
  cfg.cleanup();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  db.cleanup();
});

function req(
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? EBOARD_TOKEN}`;
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

function queue(id: string, namespace: string, channelId: string) {
  return enqueueJob({
    discordMessageId: id,
    discordChannelId: channelId,
    discordThreadId: null,
    authorId: "u1",
    namespace,
    content: `q ${id}`,
  }).job;
}

describe("HTTP /v1/jobs auth", () => {
  test("unauthenticated → 401", async () => {
    const res = await handleHttpRequest(req("GET", "/v1/jobs", { token: null }));
    expect(res.status).toBe(401);
  });

  test("health stays unauthenticated", async () => {
    const res = await handleHttpRequest(new Request("http://127.0.0.1/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("DISCORD_BOT_TOKEN is not accepted as this bearer", async () => {
    const res = await handleHttpRequest(req("GET", "/v1/jobs", { token: "test-token" }));
    expect(res.status).toBe(401);
  });

  test("DISCORD_BOT_TOKEN matching a workspace token is still refused", async () => {
    const savedBot = process.env.DISCORD_BOT_TOKEN;
    process.env.DISCORD_BOT_TOKEN = EBOARD_TOKEN;
    resetEnvForTest();
    try {
      const res = await handleHttpRequest(req("GET", "/v1/jobs", { token: EBOARD_TOKEN }));
      expect(res.status).toBe(401);
    } finally {
      if (savedBot === undefined) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = savedBot;
      resetEnvForTest();
    }
  });
});

describe("HTTP /v1/jobs claim/complete", () => {
  test("two claims → one 200, one 409", async () => {
    const job = queue("h-cas", EBOARD, SPONSORS);
    const a = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/claim`, { body: { claimed_by: "grok-eboard" } }),
    );
    const b = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/claim`, { body: { claimed_by: "grok-eboard" } }),
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(409);
  });

  test("claimed_by that is not the token worker identity → 409", async () => {
    const job = queue("h-identity", EBOARD, SPONSORS);
    const res = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/claim`, { body: { claimed_by: "someone-else" } }),
    );
    expect(res.status).toBe(409);
    expect(getJob(job.id)?.status).toBe("queued");
  });

  test("complete with wrong claimed_by → 409", async () => {
    const job = queue("h-wrong", EBOARD, SPONSORS);
    claimJob(job.id, "grok-eboard");
    const res = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/complete`, {
        body: { claimed_by: "w2", reply: "nope" },
      }),
    );
    expect(res.status).toBe(409);
  });

  test("complete on already-completed job returns stored id and does not re-post", async () => {
    const job = queue("h-idemp", EBOARD, SPONSORS);
    const claim = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/claim`, { body: { claimed_by: "grok-eboard" } }),
    );
    expect(claim.status).toBe(200);
    const first = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/complete`, {
        body: { claimed_by: "grok-eboard", reply: "hello", completion_key: "ck-1" },
      }),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { posted: boolean };
    expect(firstBody.posted).toBe(false); // DISCORD_POST_REPLIES=false
    const second = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/complete`, {
        body: { claimed_by: "grok-eboard", reply: "hello again", completion_key: "ck-1" },
      }),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { posted: boolean };
    expect(secondBody.posted).toBe(false);
    expect(getJob(job.id)?.status).toBe("completed");
  });
});

describe("HTTP /v1/jobs workspace boundary", () => {
  test("a programs-dev token cannot claim an eboard job", async () => {
    const job = queue("h-eboard-job", EBOARD, SPONSORS);
    const res = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/claim`, {
        token: DEV_TOKEN,
        body: { claimed_by: "grok-programs-dev" },
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("workspace mismatch");
    expect(getJob(job.id)?.status).toBe("queued");
  });

  test("an eboard token CAN claim a programs-dev job (descendant)", async () => {
    const job = queue("h-dev-job", PROGRAMS_DEV, DEV_CHAT);
    const res = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/claim`, {
        token: EBOARD_TOKEN,
        body: { claimed_by: "grok-eboard" },
      }),
    );
    expect(res.status).toBe(200);
    expect(getJob(job.id)?.claimed_by).toBe("grok-eboard");
  });

  test("the leadership token can claim anything; an eboard token cannot touch leadership", async () => {
    const job = queue("h-lead-job", LEADERSHIP, LEADERSHIP_TEAM);
    const refused = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/claim`, {
        token: EBOARD_TOKEN,
        body: { claimed_by: "grok-eboard" },
      }),
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("workspace mismatch");

    const claimed = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/claim`, {
        token: LEADERSHIP_TOKEN,
        body: { claimed_by: "grok-leadership" },
      }),
    );
    expect(claimed.status).toBe(200);

    const leak = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/complete`, {
        token: EBOARD_TOKEN,
        body: { claimed_by: "grok-eboard", reply: "leak" },
      }),
    );
    expect(leak.status).toBe(409);
    expect(getJob(job.id)?.status).toBe("claimed");

    // …and leadership reaches down into a descendant workspace too.
    const devJob = queue("h-lead-claims-dev", PROGRAMS_DEV, DEV_CHAT);
    const down = await handleHttpRequest(
      req("POST", `/v1/jobs/${devJob.id}/claim`, {
        token: LEADERSHIP_TOKEN,
        body: { claimed_by: "grok-leadership" },
      }),
    );
    expect(down.status).toBe(200);
  });
});

describe("HTTP GET /v1/jobs listing", () => {
  test("lists the token's subtree and ignores ?namespace=", async () => {
    queue("h-list-eboard", EBOARD, SPONSORS);
    queue("h-list-dev", PROGRAMS_DEV, DEV_CHAT);
    queue("h-list-lead", LEADERSHIP, LEADERSHIP_TEAM);

    const res = await handleHttpRequest(
      req("GET", "/v1/jobs?status=queued&namespace=leadership", { token: EBOARD_TOKEN }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobs: Array<{ namespace: string; discord_message_id: string }>;
      workspace: string;
      visible: string[];
    };
    expect(body.workspace).toBe(EBOARD);
    expect([...body.visible].sort()).toEqual(["eboard", "programs-dev", "programs-mentorship"]);
    expect(body.jobs.every((j) => j.namespace !== LEADERSHIP)).toBe(true);
    const ids = body.jobs.map((j) => j.discord_message_id);
    expect(ids).toContain("h-list-eboard");
    expect(ids).toContain("h-list-dev");
    expect(ids).not.toContain("h-list-lead");
  });

  test("status must be queued", async () => {
    const res = await handleHttpRequest(req("GET", "/v1/jobs?status=claimed"));
    expect(res.status).toBe(400);
  });
});
