import { describe, expect, test } from "bun:test";
import { batchResponseSchema, buildPrompt } from "../src/classifier/prompt.ts";

describe("classifier/prompt", () => {
  test("buildPrompt produces system + user with all items numbered", () => {
    const items = [
      { index: 0, channelName: "eboard", authorName: "alice", content: "Meeting Thursday" },
      { index: 1, channelName: "eboard", authorName: "bob", content: "lol" },
    ];
    const { system, user } = buildPrompt(items);
    expect(system).toContain("operational");
    expect(system).toContain("discussion");
    expect(system).toContain("noise");
    expect(user).toContain("0. [#eboard] @alice: Meeting Thursday");
    expect(user).toContain("1. [#eboard] @bob: lol");
  });

  test("buildPrompt truncates very long messages", () => {
    const long = "x".repeat(2000);
    const { user } = buildPrompt([
      { index: 0, channelName: "c", authorName: "a", content: long },
    ]);
    expect(user.length).toBeLessThan(2000);
    expect(user).toContain("…");
  });
});

describe("classifier/batchResponseSchema", () => {
  test("accepts a well-formed response", () => {
    const r = batchResponseSchema.parse({
      classifications: [
        { index: 0, label: "operational", confidence: 0.9 },
        { index: 1, label: "noise", confidence: 0.7 },
      ],
    });
    expect(r.classifications.length).toBe(2);
  });

  test("rejects unknown labels", () => {
    expect(() =>
      batchResponseSchema.parse({
        classifications: [{ index: 0, label: "spam", confidence: 0.9 }],
      }),
    ).toThrow();
  });

  test("rejects out-of-range confidence", () => {
    expect(() =>
      batchResponseSchema.parse({
        classifications: [{ index: 0, label: "noise", confidence: 1.5 }],
      }),
    ).toThrow();
  });

  test("rejects empty array", () => {
    expect(() => batchResponseSchema.parse({ classifications: [] })).toThrow();
  });
});
