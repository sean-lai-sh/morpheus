import { describe, expect, test } from "bun:test";
import {
  SdkDispatcher,
  buildJobPrompt,
  dispatchKey,
  type JobOutcome,
  type SdkJobPayload,
} from "../src/sdk-dispatcher/dispatcher.ts";
import type {
  SdkAgentHandle,
  SdkRunResult,
  SdkRuntime,
  SdkSendOptions,
} from "../src/sdk-dispatcher/runtime.ts";
import type { Fetcher } from "../src/sdk-dispatcher/tools.ts";

const BASE = "http://127.0.0.1:8080";
const EBOARD_TOKEN = "tok-eboard-0123456789";
const API_KEY = "cur_api_key_should_never_leak";

// ---------------------------------------------------------------------------
// Fakes: no live Cursor, no live HTTP.
// ---------------------------------------------------------------------------

interface SentRun {
  agentId: string;
  prompt: string;
  customTools: NonNullable<SdkSendOptions["customTools"]> | undefined;
  finish: (result: SdkRunResult) => void;
}

function makeFakeRuntime(): {
  runtime: SdkRuntime;
  calls: { prewarm: number; create: number; resume: string[]; released: number };
  sends: SentRun[];
} {
  const calls = { prewarm: 0, create: 0, resume: [] as string[], released: 0 };
  const sends: SentRun[] = [];
  let agentCounter = 0;

  function makeAgent(agentId: string): SdkAgentHandle {
    return {
      agentId,
      async send(prompt, options) {
        let finish!: (result: SdkRunResult) => void;
        const done = new Promise<SdkRunResult>((resolve) => {
          finish = resolve;
        });
        sends.push({ agentId, prompt, customTools: options?.customTools, finish });
        return { wait: () => done };
      },
    };
  }

  return {
    calls,
    sends,
    runtime: {
      async prewarm() {
        calls.prewarm += 1;
        return async () => {
          calls.released += 1;
        };
      },
      async createAgent() {
        calls.create += 1;
        return makeAgent(`agent-${++agentCounter}`);
      },
      async resumeAgent(agentId) {
        calls.resume.push(agentId);
        return makeAgent(agentId);
      },
    },
  };
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function makeFetcher(
  route?: (url: string, init: { method: string }) => { status: number; body?: string } | undefined,
): { fetcher: Fetcher; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    fetcher: async (url, init) => {
      requests.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) });
      const hit = route?.(url, init) ?? { status: 200, body: "{}" };
      return { ok: hit.status >= 200 && hit.status < 300, status: hit.status, text: async () => hit.body ?? "" };
    },
  };
}

function payloadFor(jobId: string, over: Partial<SdkJobPayload["job"]> = {}): SdkJobPayload {
  return {
    first_pass: true,
    job: {
      id: jobId,
      namespace: "eboard",
      discord_channel_id: "1001",
      content: "what did sponsors say this week?",
      ...over,
    },
    snippets: [{ content: "Acme wants to sponsor", path: "/eboard/eboard-teams/sponsors-1001/m1" }],
  };
}

interface Harness {
  dispatcher: SdkDispatcher;
  runtime: ReturnType<typeof makeFakeRuntime>;
  requests: RecordedRequest[];
  settled: Array<{ key: string; jobId: string; outcome: JobOutcome }>;
  waitSettled: (count: number) => Promise<void>;
}

function makeHarness(opts: {
  route?: Parameters<typeof makeFetcher>[0];
  tokenFor?: (ns: string) => string | null;
  savedAgentIds?: Record<string, string>;
} = {}): Harness {
  const runtime = makeFakeRuntime();
  const { fetcher, requests } = makeFetcher(opts.route);
  const settled: Array<{ key: string; jobId: string; outcome: JobOutcome }> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const dispatcher = new SdkDispatcher({
    runtime: runtime.runtime,
    morpheusBaseUrl: BASE,
    tokenFor: opts.tokenFor ?? ((ns) => (ns === "eboard" ? EBOARD_TOKEN : null)),
    fetcher,
    ...(opts.savedAgentIds ? { savedAgentIds: opts.savedAgentIds } : {}),
    onJobSettled: (info) => {
      settled.push(info);
      for (const w of [...waiters]) {
        if (settled.length >= w.count) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
      }
    },
  });
  return {
    dispatcher,
    runtime,
    requests,
    settled,
    waitSettled: (count) =>
      settled.length >= count
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push({ count, resolve })),
  };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------

describe("prewarm / create / resume", () => {
  test("start() prewarms the local workspace once; stop() releases it", async () => {
    const h = makeHarness();
    await h.dispatcher.start();
    expect(h.runtime.calls.prewarm).toBe(1);
    await h.dispatcher.stop();
    expect(h.runtime.calls.released).toBe(1);
  });

  test("first job on a key creates an agent; follow-up reuses it (no second create)", async () => {
    const h = makeHarness();
    h.dispatcher.enqueue(payloadFor("j1"));
    await waitFor(() => h.runtime.sends.length === 1, "first send");
    expect(h.runtime.calls.create).toBe(1);
    h.runtime.sends[0]!.finish({ status: "finished", result: "answer one" });
    await h.waitSettled(1);

    h.dispatcher.enqueue(payloadFor("j2"));
    await waitFor(() => h.runtime.sends.length === 2, "second send");
    expect(h.runtime.calls.create).toBe(1);
    expect(h.runtime.calls.resume).toEqual([]);
    expect(h.runtime.sends[1]!.agentId).toBe(h.runtime.sends[0]!.agentId);
    h.runtime.sends[1]!.finish({ status: "finished", result: "answer two" });
    await h.waitSettled(2);
  });

  test("a saved agent id for the key resumes via Agent.resume instead of creating", async () => {
    const h = makeHarness({ savedAgentIds: { "1001": "agent-from-last-boot" } });
    h.dispatcher.enqueue(payloadFor("j1"));
    await waitFor(() => h.runtime.sends.length === 1, "send after resume");
    expect(h.runtime.calls.create).toBe(0);
    expect(h.runtime.calls.resume).toEqual(["agent-from-last-boot"]);
    expect(h.runtime.sends[0]!.agentId).toBe("agent-from-last-boot");
    h.runtime.sends[0]!.finish({ status: "finished", result: "resumed answer" });
    await h.waitSettled(1);
  });

  test("keys map to Discord channel, falling back to job id", () => {
    expect(dispatchKey(payloadFor("j1"))).toBe("1001");
    const noChannel = payloadFor("j9");
    delete noChannel.job.discord_channel_id;
    expect(dispatchKey(noChannel)).toBe("j9");
  });
});

describe("queue-when-busy", () => {
  test("overlapping jobs on the same key run one at a time, in order", async () => {
    const h = makeHarness();
    h.dispatcher.enqueue(payloadFor("j1"));
    await waitFor(() => h.runtime.sends.length === 1, "first send");

    h.dispatcher.enqueue(payloadFor("j2"));
    h.dispatcher.enqueue(payloadFor("j3"));
    // Still only the first run in flight.
    await new Promise((r) => setTimeout(r, 25));
    expect(h.runtime.sends.length).toBe(1);

    h.runtime.sends[0]!.finish({ status: "finished", result: "one" });
    await waitFor(() => h.runtime.sends.length === 2, "second send after first finished");
    expect(h.runtime.sends[1]!.prompt).toContain("j2");

    h.runtime.sends[1]!.finish({ status: "finished", result: "two" });
    await waitFor(() => h.runtime.sends.length === 3, "third send");
    h.runtime.sends[2]!.finish({ status: "finished", result: "three" });
    await h.waitSettled(3);
    expect(h.settled.map((s) => s.jobId)).toEqual(["j1", "j2", "j3"]);
  });

  test("different keys do not block each other", async () => {
    const h = makeHarness();
    h.dispatcher.enqueue(payloadFor("j1", { discord_channel_id: "1001" }));
    h.dispatcher.enqueue(payloadFor("j2", { discord_channel_id: "2002" }));
    await waitFor(() => h.runtime.sends.length === 2, "both sends in flight");
    expect(h.runtime.calls.create).toBe(2);
    h.runtime.sends[0]!.finish({ status: "finished", result: "a" });
    h.runtime.sends[1]!.finish({ status: "finished", result: "b" });
    await h.waitSettled(2);
  });
});

describe("claim and fail-closed guards", () => {
  test("claims via the jobs CAS before sending; refused claim skips the agent entirely", async () => {
    const h = makeHarness({
      route: (url) => (url.includes("/claim") ? { status: 409, body: `{"error":"not queued"}` } : undefined),
    });
    h.dispatcher.enqueue(payloadFor("j1"));
    await h.waitSettled(1);
    expect(h.settled[0]!.outcome).toBe("skipped-not-claimed");
    expect(h.runtime.sends.length).toBe(0);
    expect(h.runtime.calls.create).toBe(0);
  });

  test("no workspace token for the namespace → skip, no HTTP at all (fail closed)", async () => {
    const h = makeHarness();
    h.dispatcher.enqueue(payloadFor("j1", { namespace: "leadership" }));
    await h.waitSettled(1);
    expect(h.settled[0]!.outcome).toBe("skipped-no-token");
    expect(h.requests.length).toBe(0);
    expect(h.runtime.sends.length).toBe(0);
  });
});

describe("custom tools", () => {
  async function startJob(h: Harness): Promise<SentRun> {
    h.dispatcher.enqueue(payloadFor("j1"));
    await waitFor(() => h.runtime.sends.length === 1, "send");
    return h.runtime.sends[0]!;
  }

  test("agent gets exactly the four morpheus tools", async () => {
    const h = makeHarness();
    const run = await startJob(h);
    expect(Object.keys(run.customTools ?? {}).sort()).toEqual([
      "morpheus_fs_read",
      "morpheus_fs_search",
      "morpheus_fs_tree",
      "morpheus_job_complete",
    ]);
    run.finish({ status: "finished", result: "x" });
    await h.waitSettled(1);
  });

  test("fs tools call the Tailscale API with the job's workspace bearer", async () => {
    const h = makeHarness();
    const run = await startJob(h);
    const tools = run.customTools!;

    await tools.morpheus_fs_search!.execute({ query: "sponsor", limit: 5 }, {});
    await tools.morpheus_fs_read!.execute({ path: "/eboard/eboard-teams/sponsors-1001" }, {});
    await tools.morpheus_fs_tree!.execute({}, {});

    const [claim, search, read, tree] = h.requests;
    expect(claim!.url).toBe(`${BASE}/v1/jobs/j1/claim`);
    expect(search!.url).toBe(`${BASE}/v1/fs/search`);
    expect(search!.method).toBe("POST");
    expect(JSON.parse(search!.body!)).toEqual({ query: "sponsor", limit: 5 });
    expect(read!.url).toBe(`${BASE}/v1/fs/read?path=${encodeURIComponent("/eboard/eboard-teams/sponsors-1001")}`);
    expect(tree!.url).toBe(`${BASE}/v1/fs/tree?path=${encodeURIComponent("/")}`);
    for (const r of [claim!, search!, read!, tree!]) {
      expect(r.headers.Authorization).toBe(`Bearer ${EBOARD_TOKEN}`);
    }

    run.finish({ status: "finished", result: "x" });
    await h.waitSettled(1);
  });

  test("morpheus_job_complete POSTs { reply } with the workspace bearer and leaks no secrets", async () => {
    const h = makeHarness();
    const run = await startJob(h);

    const result = await run.customTools!.morpheus_job_complete!.execute({ reply: "Sponsors: Acme is in." }, {});
    expect(JSON.stringify(result)).not.toContain(EBOARD_TOKEN);

    const complete = h.requests.find((r) => r.url.endsWith("/v1/jobs/j1/complete"));
    expect(complete).toBeDefined();
    expect(complete!.method).toBe("POST");
    expect(JSON.parse(complete!.body!)).toEqual({ reply: "Sponsors: Acme is in." });
    expect(complete!.headers.Authorization).toBe(`Bearer ${EBOARD_TOKEN}`);
    // The payload carries the reply and nothing else — no bearer, no api key, no bot token shape.
    expect(complete!.body).not.toContain(EBOARD_TOKEN);
    expect(complete!.body).not.toContain(API_KEY);
    expect(complete!.url).not.toContain(EBOARD_TOKEN);

    run.finish({ status: "finished", result: "already delivered via tool" });
    await h.waitSettled(1);
    expect(h.settled[0]!.outcome).toBe("completed-by-tool");
    // No duplicate fallback complete.
    expect(h.requests.filter((r) => r.url.endsWith("/complete")).length).toBe(1);
  });

  test("the prompt never contains the workspace bearer", async () => {
    const h = makeHarness();
    const run = await startJob(h);
    expect(run.prompt).toContain("what did sponsors say this week?");
    expect(run.prompt).toContain("Acme wants to sponsor");
    expect(run.prompt).not.toContain(EBOARD_TOKEN);
    expect(run.prompt).not.toContain(API_KEY);
    run.finish({ status: "finished", result: "x" });
    await h.waitSettled(1);
  });
});

describe("run settlement", () => {
  test("run finished without the tool → fallback complete with the run result", async () => {
    const h = makeHarness();
    h.dispatcher.enqueue(payloadFor("j1"));
    await waitFor(() => h.runtime.sends.length === 1, "send");
    h.runtime.sends[0]!.finish({ status: "finished", result: "  Here is the answer.  " });
    await h.waitSettled(1);
    expect(h.settled[0]!.outcome).toBe("completed-fallback");
    const complete = h.requests.find((r) => r.url.endsWith("/v1/jobs/j1/complete"));
    expect(JSON.parse(complete!.body!)).toEqual({ reply: "Here is the answer." });
  });

  test("run errored → POST /fail with the error message; queue keeps moving", async () => {
    const h = makeHarness();
    h.dispatcher.enqueue(payloadFor("j1"));
    h.dispatcher.enqueue(payloadFor("j2"));
    await waitFor(() => h.runtime.sends.length === 1, "send");
    h.runtime.sends[0]!.finish({ status: "error", error: { message: "model exploded" } });
    await h.waitSettled(1);
    expect(h.settled[0]!.outcome).toBe("failed");
    const fail = h.requests.find((r) => r.url.endsWith("/v1/jobs/j1/fail"));
    expect(JSON.parse(fail!.body!)).toEqual({ error: "model exploded" });

    await waitFor(() => h.runtime.sends.length === 2, "next job still runs");
    h.runtime.sends[1]!.finish({ status: "finished", result: "ok" });
    await h.waitSettled(2);
  });
});

describe("buildJobPrompt", () => {
  test("fences untrusted Discord content and instructs the complete-tool contract", () => {
    const prompt = buildJobPrompt(payloadFor("j1"));
    expect(prompt).toContain("<<<DISCORD_MESSAGE");
    expect(prompt).toContain("DISCORD_MESSAGE>>>");
    expect(prompt).toContain("morpheus_job_complete");
    expect(prompt).toContain("Do not post to Discord yourself");
  });
});
