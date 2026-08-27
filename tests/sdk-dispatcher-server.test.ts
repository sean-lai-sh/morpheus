import { describe, expect, test } from "bun:test";
import type { SdkJobPayload } from "../src/sdk-dispatcher/dispatcher.ts";
import { createWebhookHandler, parseJobPack } from "../src/sdk-dispatcher/server.ts";

const SECRET = "sibling-secret-0123456789";
const BASE = "http://127.0.0.1:8790";

function makeDeps(): {
  handler: (req: Request) => Promise<Response>;
  enqueued: SdkJobPayload[];
} {
  const enqueued: SdkJobPayload[] = [];
  const handler = createWebhookHandler({
    secret: SECRET,
    enqueue: (payload) => {
      enqueued.push(payload);
      return { key: payload.job.discord_channel_id ?? payload.job.id, queued: enqueued.length };
    },
  });
  return { handler, enqueued };
}

function post(body: unknown, auth?: string): Request {
  return new Request(`${BASE}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: auth } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const pack = {
  first_pass: true,
  job: { id: "j1", namespace: "eboard", discord_channel_id: "1001", content: "hello" },
  snippets: [{ content: "snippet", path: "/eboard/x", channelId: "1001" }],
};

describe("webhook auth", () => {
  test("missing bearer → 401, nothing enqueued", async () => {
    const { handler, enqueued } = makeDeps();
    const res = await handler(post(pack));
    expect(res.status).toBe(401);
    expect(enqueued.length).toBe(0);
  });

  test("wrong bearer → 401, nothing enqueued", async () => {
    const { handler, enqueued } = makeDeps();
    const res = await handler(post(pack, "Bearer not-the-secret-000000"));
    expect(res.status).toBe(401);
    expect(enqueued.length).toBe(0);
  });

  test("bearer of a different length → 401 (timing-safe path)", async () => {
    const { handler, enqueued } = makeDeps();
    const res = await handler(post(pack, `Bearer ${SECRET}x`));
    expect(res.status).toBe(401);
    expect(enqueued.length).toBe(0);
  });

  test("correct bearer → 202 accepted", async () => {
    const { handler, enqueued } = makeDeps();
    const res = await handler(post(pack, `Bearer ${SECRET}`));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: boolean; key: string };
    expect(body.accepted).toBe(true);
    expect(body.key).toBe("1001");
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.job.id).toBe("j1");
  });
});

describe("request validation", () => {
  test("invalid JSON → 400", async () => {
    const { handler, enqueued } = makeDeps();
    const res = await handler(post("{not json", `Bearer ${SECRET}`));
    expect(res.status).toBe(400);
    expect(enqueued.length).toBe(0);
  });

  test("bad shapes → 400 (missing job, missing id, bad namespace, empty content)", async () => {
    const { handler, enqueued } = makeDeps();
    const bads = [
      {},
      { job: { namespace: "eboard", content: "x" } },
      { job: { id: "j1", namespace: "Not A Slug!", content: "x" } },
      { job: { id: "j1", namespace: "eboard", content: "" } },
      [],
    ];
    for (const bad of bads) {
      const res = await handler(post(bad, `Bearer ${SECRET}`));
      expect(res.status).toBe(400);
    }
    expect(enqueued.length).toBe(0);
  });

  test("GET /health is open; other methods 405", async () => {
    const { handler } = makeDeps();
    const health = await handler(new Request(`${BASE}/health`));
    expect(health.status).toBe(200);
    const other = await handler(new Request(`${BASE}/`, { method: "GET" }));
    expect(other.status).toBe(405);
  });
});

describe("parseJobPack", () => {
  test("copies only known fields — junk and lookalike secrets are dropped", () => {
    const parsed = parseJobPack({
      first_pass: true,
      bot_token: "should-never-survive",
      job: {
        id: "j2",
        namespace: "eboard",
        discord_channel_id: "1001",
        content: "question",
        DISCORD_BOT_TOKEN: "nope",
      },
      snippets: [
        { content: "keep", path: "/eboard/x", channelId: "1001", extra: "drop" },
        { content: "" },
        "garbage",
      ],
    });
    expect(parsed).not.toBeNull();
    const json = JSON.stringify(parsed);
    expect(json).not.toContain("should-never-survive");
    expect(json).not.toContain("nope");
    expect(json).not.toContain("drop");
    expect(parsed!.job).toEqual({
      id: "j2",
      namespace: "eboard",
      content: "question",
      discord_channel_id: "1001",
    });
    expect(parsed!.snippets).toEqual([{ content: "keep", path: "/eboard/x", channelId: "1001" }]);
  });

  test("caps content and snippet sizes", () => {
    const parsed = parseJobPack({
      job: { id: "j3", namespace: "eboard", content: "x".repeat(10_000) },
      snippets: Array.from({ length: 30 }, () => ({ content: "y".repeat(5_000) })),
    });
    expect(parsed!.job.content.length).toBe(4_000);
    expect(parsed!.snippets.length).toBe(12);
    expect(parsed!.snippets.every((s) => s.content.length === 1_200)).toBe(true);
  });

  test("non-numeric channel id is dropped, pack still valid", () => {
    const parsed = parseJobPack({
      job: { id: "j4", namespace: "eboard", discord_channel_id: "../../etc", content: "q" },
      snippets: [],
    });
    expect(parsed!.job.discord_channel_id).toBeUndefined();
  });
});
