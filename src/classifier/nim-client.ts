import OpenAI, { APIError, RateLimitError } from "openai";
import { logger } from "../logger.ts";
import { batchResponseSchema, buildPrompt, type BatchItem, type BatchResponse } from "./prompt.ts";
import { nimLimiter } from "./ratelimit.ts";

const BASE_URL = "https://integrate.api.nvidia.com/v1";
const MODEL = process.env.NIM_MODEL ?? "z-ai/glm4.7";

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

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (_client) return _client;
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY not set in environment");
  _client = new OpenAI({ apiKey, baseURL: BASE_URL });
  return _client;
}

/**
 * Single batched classification call. Throws NimRateLimitError on 429,
 * NimTransientError on 5xx, plain Error on terminal failures.
 */
export async function classifyBatch(items: BatchItem[]): Promise<BatchResponse> {
  if (items.length === 0) return { classifications: [] };
  const { system, user } = buildPrompt(items);

  const content = await nimLimiter.schedule(async () => {
    const t0 = Date.now();
    try {
      const completion = await getClient().chat.completions.create({
        model: MODEL,
        temperature: 0,
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      const finishReason = completion.choices[0]?.finish_reason;
      const content = completion.choices[0]?.message?.content ?? "";
      logger.debug({ model: MODEL, latency_ms: Date.now() - t0, finish_reason: finishReason }, "NIM response received");
      if (!content.trim()) {
        throw new NimTransientError(
          `NIM returned empty content (finish_reason=${finishReason})`,
          500,
        );
      }
      return content;
    } catch (err) {
      const latency = Date.now() - t0;
      if (err instanceof RateLimitError) {
        const retryAfter = Number(err.headers.get("retry-after") ?? "5") * 1000;
        logger.warn({ status: 429, latency_ms: latency }, "NIM 429");
        throw new NimRateLimitError(retryAfter);
      }
      if (err instanceof APIError && (err.status ?? 0) >= 500) {
        logger.warn({ status: err.status, latency_ms: latency }, "NIM 5xx");
        throw new NimTransientError(`NIM ${err.status}`, err.status ?? 500);
      }
      throw err;
    }
  });

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
    // Try to recover the first {...} block (handles leading chain-of-thought text).
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`could not parse JSON from NIM response: ${raw.slice(0, 200)}`);
    return JSON.parse(m[0]);
  }
}
