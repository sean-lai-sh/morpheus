# morpheus-sandbox

Docker image for **optional** untrusted script execution (`python` + `bash` + viz libs).

## Not on the Grok Bot critical path

The Tech@NYU loop is:

**official Discord bot → Morpheus (SQLite + HTTP) → Cursor Grok Bot**

Grok Bot already runs in a Cursor Cloud VM. It does **not** need this image on the Discord ingest host. Do not treat `bun run build:sandbox` or Docker-in-Docker as a deploy requirement for Morpheus.

This image was designed for the older in-process Pi agent (`run_sandbox` tool, issue #19). That path is **parked** (see issue #34). Keep the files if we later want Morpheus itself to exec club-member scripts; they are not required to merge the **events table** half of this PR.

## Build (optional)

```bash
bun run build:sandbox
RUN_SANDBOX_IMAGE_TESTS=1 bun test tests/sandbox-image.test.ts
```
