## Goal

Make Morpheus a **queryable context layer** for Tech@NYU: Discord ingest stays, Nia goes away, a Cursor/Grok agent can be talked to through the official Discord bot.

Do **not** treat this issue as a rewrite. Land the slices below in separate PRs. The investigation that produced this epic is in-repo: [`docs/context-layer.md`](../context-layer.md) (PR #24).

## What the code actually does today (do not re-guess)

- Official `discord.js` bot (not a self-bot). Ingest-only: MessageCreate/Update/Delete + reactions.
- **SQLite is the source of truth** (`data/morpheus.db`).
- Markdown under `data/discord/{general,leadership}/` is a **local** render Morpheus writes itself.
- Nia is a **remote push**: `PUT {NIA_BASE_URL}/fs/{id}/files` of every `.md` every 60s when dirty. This repo never searches or reads Nia. There is **no nia-cli** runtime dependency.
- Dual namespaces: `isolated: true` in `config/channels.yml` → leadership dir / `NIA_DISCORD_LEADERSHIP_SOURCE_ID`; everything else → general.

## Corrections to older issues

| Issue | What to do |
|---|---|
| #3 schedule reconcile | Already implemented in `src/crawler/live.ts`. Close it. |
| #5 thread attribution | Largely done in PR #6 (`thread_id` / `thread_name`, per-thread files). Close or shrink. |
| #2 backup after Nia sync | Nightly backup already exists. Do not wire new work to Nia success. |
| #14 resumeBackfill | Keep pagination; **drop** Nia `flushNamespace`. |
| #15 search_discord via Nia | **Superseded** by slice A (FTS ContextStore). Keep namespace isolation + freshness. |
| #10 mention handler | Must not fight slice D's job queue. Coordinate or gate behind flags. |
| #9 Nia-index pi-mono | Closed. Do not revive Nia indexing. |

## Checklist (implementation slices)

Each child issue is written so a Cursor agent can implement it without this chat.

- [ ] **A.** `ContextStore` + SQLite FTS5, namespace-isolated, ingest writes the index (#26)
- [ ] **B.** Authenticated HTTP `/v1/search` … `/v1/poll` with **scoped** tokens (#27)
- [ ] **D.** Discord mention / reply-to-bot → `jobs` table (#29)
- [ ] **E.** Job claim/complete HTTP + idempotent Discord replies (#30)
- [ ] **Webhooks** operational feed `#sponsors` / `#opportunities` / `#speakers` / `#inbox` (no GitHub for FYIs)
- [ ] **F.** GitHub issues for **implementation work only** (fail open if `gh` missing) (#31)
- [ ] **C. last** Feature-flag Nia off, then delete `src/nia/` (#28)

## Constraints

- Official Discord bot only (`DISCORD_TOKEN` from Doppler). No user-token / self-bot.
- Do not commit tokens, Doppler values, or a real `config/channels.yml`.
- Cursor/Grok agents get `MORPHEUS_API_TOKEN`, **not** `DISCORD_TOKEN`.
- Leadership (`isolated: true`) must never leak into general search/read/jobs.
- Markdown export may stay until C ships; do not build new retrieval on it.

## Secrets / where things run

Must stay on the always-on bot host (Doppler / env, never git): `DISCORD_TOKEN`, future `MORPHEUS_API_TOKEN`, current `NIA_*` until C, SQLite volume.

Must **not** be given to Grok Bot: `DISCORD_TOKEN`, `NIA_API_KEY`. Webhook URLs (`DISCORD_WEBHOOK_*`) **are** for Grok Bot's operational feed.

Can run remotely against HTTP: search, read, poll, claim/complete jobs.

`NVIDIA_API_KEY` and the `openai` package are unused leftovers (classifier removed). Do not treat them as required.
