import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const IMAGE = process.env.MORPHEUS_SANDBOX_TAG ?? "morpheus-sandbox:latest";

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  return r.status === 0;
}

function imageExists(tag: string): boolean {
  const r = spawnSync("docker", ["image", "inspect", tag], { encoding: "utf8" });
  return r.status === 0;
}

const SHOULD_RUN =
  process.env.RUN_SANDBOX_IMAGE_TESTS === "1" &&
  dockerAvailable() &&
  imageExists(IMAGE);

// These tests exercise the morpheus-sandbox image. They require Docker and the
// image to be built (`bun run build:sandbox`). Set RUN_SANDBOX_IMAGE_TESTS=1 to
// opt in. The smoke checks are skipped otherwise so CI without Docker stays green.
describe.skipIf(!SHOULD_RUN)("sandbox docker image", () => {
  test("python smoke: matplotlib + numpy + pandas import", () => {
    const r = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network=none",
        IMAGE,
        "python",
        "-c",
        'import matplotlib, numpy, pandas; print("ok")',
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("ok");
  });

  test("bash smoke: echo hello", () => {
    const r = spawnSync(
      "docker",
      ["run", "--rm", "--network=none", IMAGE, "bash", "-c", "echo hello"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  test("runs as non-root by default", () => {
    const r = spawnSync(
      "docker",
      ["run", "--rm", IMAGE, "id", "-u"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).not.toBe("0");
  });

  test("final image is under 400MB", () => {
    const r = spawnSync(
      "docker",
      ["image", "inspect", IMAGE, "--format", "{{.Size}}"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const bytes = Number.parseInt(r.stdout.trim(), 10);
    expect(Number.isFinite(bytes)).toBe(true);
    expect(bytes).toBeLessThan(400 * 1024 * 1024);
  });
});
