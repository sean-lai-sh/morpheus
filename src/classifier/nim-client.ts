import { logger } from "../logger.ts";
import { batchResponseSchema, buildPrompt, type BatchItem, type BatchResponse } from "./prompt.ts";
import { nimLimiter } from "./ratelimit.ts";

const NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = process.env.NIM_MODEL ?? "nvidia/llama-3.1-nemotron-ultra-253b-v1";

export class NimRateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super(`NIM 429 rate-limited; retry after ${retryAfterMs}ms`);
  }
}

export class NimTransientError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

interface NimChoiceMessage {
  role: string;
  content: string;
}
interface NimChatResponse {
  choices: Array<{ message: NimChoiceMessage }>;
}

function getApiKey(): string {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("NVIDIA_API_KEY not set in environment");
  return key;
}

/**
 * Single batched classification call. Throws NimRateLimitError on 429,
 * NimTransientError on 5xx, plain Error on terminal failures.
 */
export async function classifyBatch(items: BatchItem[]): Promise<BatchResponse> {
  if (items.length === 0) return { classifications: [] };
  const { system, user } = buildPrompt(items);

  const result = await nimLimiter.schedule(async () => {
    const t0 = Date.now();
    const res = await fetch(NIM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const latency = Date.now() - t0;

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "5") * 1000;
      logger.warn({ status: 429, latency_ms: latency }, "NIM 429");
      throw new NimRateLimitError(retryAfter);
    }
    if (res.status >= 500) {
      const body = await res.text();
      logger.warn({ status: res.status, latency_ms: latency, body: body.slice(0, 300) }, "NIM 5xx");
      throw new NimTransientError(`NIM ${res.status}`, res.status);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`NIM ${res.status}: ${body.slice(0, 500)}`);
    }
    return (await res.json()) as NimChatResponse;
  });

  const content = result.choices[0]?.message?.content ?? "";
  const parsed = parseStrictJson(content);
  const validated = batchResponseSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `NIM response failed schema: ${validated.error.message}; content=${content.slice(0, 300)}`,
    );
  }
  return validated.data;
}

function parseStrictJson(content: string): unknown {
  // Models occasionally wrap JSON in code fences despite response_format=json_object.
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1]?.trim() ?? content.trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Try to recover the first {...} block.
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`could not parse JSON from NIM response: ${raw.slice(0, 200)}`);
    return JSON.parse(m[0]);
  }
}
