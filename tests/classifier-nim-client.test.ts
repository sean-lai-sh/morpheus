import { describe, test, expect, mock, beforeAll } from "bun:test";

// Module-level variable the mock's create fn reads so each test can set different content.
let _mockContent = "";
let _mockFinishReason = "stop";

mock.module("openai", () => {
  class APIError extends Error {
    status: number;
    headers: { get: () => null } = { get: () => null };
    constructor(msg: string, public s = 500) {
      super(msg);
      this.status = s;
    }
  }
  class RateLimitError extends APIError {
    headers = { get: (_h: string) => "5" };
  }
  return {
    default: class OpenAI {
      constructor() {}
      chat = {
        completions: {
          create: async () => ({
            choices: [
              { message: { content: _mockContent }, finish_reason: _mockFinishReason },
            ],
          }),
        },
      };
    },
    APIError,
    RateLimitError,
  };
});

beforeAll(() => {
  process.env.NVIDIA_API_KEY = "test-key";
});

// Dynamic import AFTER mock.module so nim-client binds to the mock.
const { classifyBatch, NimTransientError, NimRateLimitError } = await import(
  "../src/classifier/nim-client.ts"
);

const item = { index: 0, channelName: "eboard", authorName: "alice", content: "meeting thursday" };

describe("nim-client / empty response handling", () => {
  test("empty content throws NimTransientError, not plain Error", async () => {
    _mockContent = "";
    _mockFinishReason = "stop";
    await expect(classifyBatch([item])).rejects.toBeInstanceOf(NimTransientError);
  });

  test("whitespace-only content also throws NimTransientError", async () => {
    _mockContent = "   \n   ";
    _mockFinishReason = "stop";
    await expect(classifyBatch([item])).rejects.toBeInstanceOf(NimTransientError);
  });
});

describe("nim-client / JSON parsing", () => {
  test("valid JSON is parsed and returned", async () => {
    _mockContent = JSON.stringify({
      classifications: [{ index: 0, label: "operational", confidence: 0.9 }],
    });
    const result = await classifyBatch([item]);
    expect(result.classifications[0]?.label).toBe("operational");
  });

  test("JSON wrapped in code fences is recovered", async () => {
    _mockContent = '```json\n{"classifications":[{"index":0,"label":"noise","confidence":0.8}]}\n```';
    const result = await classifyBatch([item]);
    expect(result.classifications[0]?.label).toBe("noise");
  });

  test("JSON preceded by chain-of-thought text is recovered", async () => {
    _mockContent =
      'Let me think...\n{"classifications":[{"index":0,"label":"discussion","confidence":0.75}]}';
    const result = await classifyBatch([item]);
    expect(result.classifications[0]?.label).toBe("discussion");
  });

  test("zero items returns empty classifications without calling API", async () => {
    const result = await classifyBatch([]);
    expect(result.classifications).toEqual([]);
  });
});
