import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withTempDb } from "./helpers.ts";
import { handleHttpRequest } from "../src/http/health.ts";
import { claimJob, enqueueJob, getJob } from "../src/storage/jobs.ts";

const GENERAL_TOKEN = "test-general-token-aaaaaaaa";
const LEAD_TOKEN = "test-leadership-token-bbbbbbbb";

const db = withTempDb();
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of [
    "MORPHEUS_API_TOKEN_GENERAL",
    "MORPHEUS_API_TOKEN_LEADERSHIP",
    "DISCORD_POST_REPLIES",
    "JOB_WORKER_GENERAL",
    "JOB_WORKER_LEADERSHIP",
  ]) {
    saved[k] = process.env[k];
  }
  process.env.MORPHEUS_API_TOKEN_GENERAL = GENERAL_TOKEN;
  process.env.MORPHEUS_API_TOKEN_LEADERSHIP = LEAD_TOKEN;
  process.env.DISCORD_POST_REPLIES = "false";
  delete process.env.JOB_WORKER_GENERAL;
  delete process.env.JOB_WORKER_LEADERSHIP;
});

afterAll(() => {
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
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? GENERAL_TOKEN}`;
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
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
});

describe("HTTP /v1/jobs claim/complete", () => {
  test("two claims → one 200, one 409", async () => {
    const { job } = enqueueJob({
      discordMessageId: "h-cas",
      discordChannelId: "c1",
      discordThreadId: null,
      authorId: "u1",
      namespace: "general",
      content: "q",
    });
    const a = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/claim`, { body: { claimed_by: "w1" } }),
    );
    const b = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/claim`, { body: { claimed_by: "w2" } }),
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(409);
  });

  test("complete with wrong claimed_by → 409", async () => {
    const { job } = enqueueJob({
      discordMessageId: "h-wrong",
      discordChannelId: "c1",
      discordThreadId: null,
      authorId: "u1",
      namespace: "general",
      content: "q",
    });
    claimJob(job.id, "w1");
    const res = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/complete`, {
        body: { claimed_by: "w2", reply: "nope" },
      }),
    );
    expect(res.status).toBe(409);
  });

  test("complete on already-completed job returns stored id and does not re-post", async () => {
    const { job } = enqueueJob({
      discordMessageId: "h-idemp",
      discordChannelId: "c1",
      discordThreadId: null,
      authorId: "u1",
      namespace: "general",
      content: "q",
    });
    const claim = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/claim`, { body: { claimed_by: "w1" } }),
    );
    expect(claim.status).toBe(200);
    const first = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/complete`, {
        body: { claimed_by: "w1", reply: "hello", completion_key: "ck-1" },
      }),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { posted: boolean; result_discord_message_id: string | null };
    expect(firstBody.posted).toBe(false); // DISCORD_POST_REPLIES=false
    const second = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/complete`, {
        body: { claimed_by: "w1", reply: "hello again", completion_key: "ck-1" },
      }),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { posted: boolean; job: { result_discord_message_id: string | null } };
    expect(secondBody.posted).toBe(false);
    expect(getJob(job.id)?.status).toBe("completed");
  });

  test("general token cannot complete a leadership job", async () => {
    const { job } = enqueueJob({
      discordMessageId: "h-lead",
      discordChannelId: "c2",
      discordThreadId: null,
      authorId: "u1",
      namespace: "leadership",
      content: "secret",
    });
    const res = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/claim`, {
        token: GENERAL_TOKEN,
        body: { claimed_by: "w1" },
      }),
    );
    expect(res.status).toBe(409);
    const leadClaim = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/claim`, {
        token: LEAD_TOKEN,
        body: { claimed_by: "lead-w" },
      }),
    );
    expect(leadClaim.status).toBe(200);
    const complete = await handleHttpRequest(
      req("POST", `/v1/jobs/${job.id}/complete`, {
        token: GENERAL_TOKEN,
        body: { claimed_by: "lead-w", reply: "leak" },
      }),
    );
    expect(complete.status).toBe(409);
    expect(getJob(job.id)?.status).toBe("claimed");
  });

  test("GET list ignores client namespace query param", async () => {
    enqueueJob({
      discordMessageId: "h-list-g",
      discordChannelId: "c1",
      discordThreadId: null,
      authorId: "u1",
      namespace: "general",
      content: "g",
    });
    enqueueJob({
      discordMessageId: "h-list-l",
      discordChannelId: "c2",
      discordThreadId: null,
      authorId: "u1",
      namespace: "leadership",
      content: "l",
    });
    const res = await handleHttpRequest(
      req("GET", "/v1/jobs?status=queued&namespace=leadership", { token: GENERAL_TOKEN }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ namespace: string }>; namespace: string };
    expect(body.namespace).toBe("general");
    expect(body.jobs.every((j) => j.namespace === "general")).toBe(true);
  });
});
