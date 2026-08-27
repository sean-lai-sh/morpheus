import { describe, expect, test } from "bun:test";
import type { EnqueueResult, SdkJobPayload } from "../src/sdk-dispatcher/dispatcher.ts";
import { createWebhookHandler, parseJobPack, WEBHOOK_PATH } from "../src/sdk-dispatcher/server.ts";

const SECRET = "sibling-secret-0123456789";
const BASE = "http://127.0.0.1:8790";

function makeDeps(opts: { full?: boolean } = {}): {
  handler: (req: Request) => Promise<Response>;
  enqueued: SdkJobPayload[];
} {
  const enqueued: SdkJobPayload[] = [];
  const handler = createWebhookHandler({
    secret: SECRET,
    enqueue: (payload): EnqueueResult => {
      const key = payload.job.discord_channel_id ?? payload.job.id;
      if (opts.full) return { accepted: false, key, queued: 10 };
      enqueued.push(payload);
      return { accepted: true, key, queued: enqueued.length };
    },
  });
  return { handler, enqueued };
}

function post(body: unknown, auth?: string, path: string = WEBHOOK_PATH): Request {
  return new Request(`${BASE}${path}`, {
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

  test("valid bearer followed by trailing material → 401 (header is end-anchored)", async () => {
    const { handler, enqueued } = makeDeps();
    const res = await handler(post(pack, `Bearer ${SECRET} trailing-junk`));
    expect(res.status).toBe(401);
    expect(enqueued.length).toBe(0);
  });

  test("correct bearer on the documented path → 202 accepted", async () => {
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

describe("routing and limits", () => {
  test("POST anywhere but /hooks/job → 404, even authenticated", async () => {
    const { handler, enqueued } = makeDeps();
    for (const path of ["/", "/hooks", "/hooks/job/extra", "/v1/jobs"]) {
      const res = await handler(post(pack, `Bearer ${SECRET}`, path));
      expect(res.status).toBe(404);
    }
    expect(enqueued.length).toBe(0);
  });

  test("GET /health is open; other methods 405", async () => {
    const { handler } = makeDeps();
    const health = await handler(new Request(`${BASE}/health`));
    expect(health.status).toBe(200);
    const other = await handler(new Request(`${BASE}${WEBHOOK_PATH}`, { method: "GET" }));
    expect(other.status).toBe(405);
  });

  test("oversized body → 413 before parsing", async () => {
    const { handler, enqueued } = makeDeps();
    const huge = JSON.stringify({ job: { id: "j1", namespace: "eboard", content: "x".repeat(300_000) } });
    const res = await handler(post(huge, `Bearer ${SECRET}`));
    expect(res.status).toBe(413);
    expect(enqueued.length).toBe(0);
  });

  test("full per-key queue → 429, not 202", async () => {
    const { handler, enqueued } = makeDeps({ full: true });
    const res = await handler(post(pack, `Bearer ${SECRET}`));
    expect(res.status).toBe(429);
    expect(enqueued.length).toBe(0);
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
      // channel scope with no resolvable channel ids fails closed
      { job: { id: "j1", namespace: "eboard", content: "x", scope: "channel" } },
      [],
    ];
    for (const bad of bads) {
      const res = await handler(post(bad, `Bearer ${SECRET}`));
      expect(res.status).toBe(400);
    }
    expect(enqueued.length).toBe(0);
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
      scope: "channel",
      channel_ids: ["1001"],
      discord_channel_id: "1001",
    });
    expect(parsed!.snippets).toEqual([{ content: "keep", path: "/eboard/x", channelId: "1001" }]);
  });

  test("preserves scope + channel_ids; anything not `workspace` fails closed to `channel`", () => {
    const channel = parseJobPack({
      job: { id: "j3", namespace: "eboard", content: "q", scope: "channel", channel_ids: ["1001", "2002"] },
    });
    expect(channel!.job.scope).toBe("channel");
    expect(channel!.job.channel_ids).toEqual(["1001", "2002"]);

    const workspace = parseJobPack({
      job: { id: "j4", namespace: "eboard", content: "q", scope: "workspace", channel_ids: ["1001"] },
    });
    expect(workspace!.job.scope).toBe("workspace");
    expect(workspace!.job.channel_ids).toEqual([]);

    const weird = parseJobPack({
      job: { id: "j5", namespace: "eboard", content: "q", scope: "everything", discord_channel_id: "1001" },
    });
    expect(weird!.job.scope).toBe("channel");
    expect(weird!.job.channel_ids).toEqual(["1001"]);
  });

  test("channel scope falls back to discord_channel_id; without any id the pack is refused", () => {
    const fallback = parseJobPack({
      job: { id: "j6", namespace: "eboard", content: "q", discord_channel_id: "1001" },
    });
    expect(fallback!.job.channel_ids).toEqual(["1001"]);

    expect(parseJobPack({ job: { id: "j7", namespace: "eboard", content: "q" } })).toBeNull();
  });

  test("channel_ids are validated snowflakes, deduped, capped at 8", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `${1000 + i}`);
    const parsed = parseJobPack({
      job: {
        id: "j8",
        namespace: "eboard",
        content: "q",
        scope: "channel",
        channel_ids: ["../etc", "1001", "1001", ...ids],
      },
    });
    expect(parsed!.job.channel_ids!.length).toBe(8);
    expect(parsed!.job.channel_ids![0]).toBe("1001");
    expect(parsed!.job.channel_ids).not.toContain("../etc");
  });

  test("snippet paths must look like index paths: bounded, absolute, no traversal", () => {
    const parsed = parseJobPack({
      job: { id: "j9", namespace: "eboard", content: "q", discord_channel_id: "1001" },
      snippets: [
        { content: "ok", path: "/eboard/sponsors-1001/m1" },
        { content: "traversal", path: "/eboard/../leadership/x" },
        { content: "relative", path: "eboard/x" },
        { content: "backslash", path: "\\eboard\\x" },
        { content: "too-long", path: `/${"a".repeat(300)}` },
        { content: "bad-channel", channelId: "not-numeric" },
      ],
    });
    const snippets = parsed!.snippets;
    expect(snippets.length).toBe(6);
    expect(snippets[0]!.path).toBe("/eboard/sponsors-1001/m1");
    for (const s of snippets.slice(1)) expect(s.path).toBeUndefined();
    expect(snippets[5]!.channelId).toBeUndefined();
  });

  test("caps content and snippet sizes", () => {
    const parsed = parseJobPack({
      job: { id: "j10", namespace: "eboard", content: "x".repeat(10_000), discord_channel_id: "1001" },
      snippets: Array.from({ length: 30 }, () => ({ content: "y".repeat(5_000) })),
    });
    expect(parsed!.job.content.length).toBe(4_000);
    expect(parsed!.snippets.length).toBe(12);
    expect(parsed!.snippets.every((s) => s.content.length === 1_200)).toBe(true);
  });

  test("non-numeric discord channel id is dropped; job id becomes the key fallback", () => {
    const parsed = parseJobPack({
      job: { id: "j11", namespace: "eboard", content: "q", scope: "workspace", discord_channel_id: "../../etc" },
    });
    expect(parsed!.job.discord_channel_id).toBeUndefined();
  });
});
