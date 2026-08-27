import { describe, expect, test } from "bun:test";
import { routeFeedChannel, routeFeedFromText } from "../src/notify/route.ts";

describe("routeFeedChannel", () => {
  test("sponsor kinds → sponsors", () => {
    expect(routeFeedChannel("sponsor")).toBe("sponsors");
    expect(routeFeedChannel("partnership")).toBe("sponsors");
    expect(routeFeedChannel("PITCH")).toBe("sponsors");
  });

  test("job/fellowship kinds → opportunities", () => {
    expect(routeFeedChannel("job")).toBe("opportunities");
    expect(routeFeedChannel("fellowship")).toBe("opportunities");
    expect(routeFeedChannel("student")).toBe("opportunities");
  });

  test("speaker kinds → speakers", () => {
    expect(routeFeedChannel("speaker")).toBe("speakers");
    expect(routeFeedChannel("guest")).toBe("speakers");
  });

  test("unknown never guesses a named feed", () => {
    expect(routeFeedChannel("unknown")).toBe("inbox");
    expect(routeFeedChannel("random")).toBe("inbox");
    expect(routeFeedChannel("")).toBe("inbox");
  });
});

describe("routeFeedFromText", () => {
  test("hello@ sponsor pitch → sponsors", () => {
    expect(routeFeedFromText("Acme wants to sponsor Startup Week")).toBe("sponsors");
  });

  test("fellowship email → opportunities", () => {
    expect(routeFeedFromText("Summer fellowship for NYU students")).toBe("opportunities");
  });

  test("guest speaker ask → speakers", () => {
    expect(routeFeedFromText("Can Jane be a guest speaker in April?")).toBe("speakers");
  });

  test("unmatched → inbox", () => {
    expect(routeFeedFromText("Hello, who is the current president?")).toBe("inbox");
  });
});
