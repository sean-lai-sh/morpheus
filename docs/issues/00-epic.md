Superseded in part by hierarchical workspaces — see docs/context-layer.md §Workspaces.

## Goal

Make Morpheus a **queryable context layer** for Tech@NYU: Discord ingest stays, Nia goes away, a Cursor/Grok agent can be talked to through the official Discord bot.

Do **not** treat this issue as a rewrite. Land the slices below in separate PRs. The investigation that produced this epic is in-repo: [`docs/context-layer.md`](../context-layer.md) (PR #24).

## What the code actually does today (do not re-guess)

- Official `discord.js` bot (not a self-bot). Ingest-only: MessageCreate/Update/Delete + reactions.
- **SQLite is the source of truth** (`data/morpheus.db`).
- Markdown under `data/discord/{general,leadership}/` is a **local** render Morpheus writes itself.
- Nia runtime is **gone** (`src/nia/` deleted). Mini needs **zero `NIA_*` secrets**.
- Dual namespaces: `isolated: true` in `config/channels.yml` → leadership markdown dir; everything else → general.

## Corrections to older issues

| Issue | What to do |
|---|---|
| #3 schedule reconcile | Already implemented in `src/crawler/live.ts`. Owner close: #38. |
| #5 thread attribution | Largely done in PR #6. Owner close: #38. |
| #10 mention handler | **Do not implement.** Parked. Owner close: #38. |
| #15 search_discord via Nia | **Do not implement.** Superseded by #26. Owner close: #38. |
| #2 backup after Nia sync | Nightly backup already exists. Do not wire new work to Nia success. |
| #14 resumeBackfill | Keep pagination; **drop** Nia `flushNamespace`. |
| #9 Nia-index pi-mono | Closed. Do not revive Nia indexing. |

## Checklist (implementation slices)

Each child issue is written so a Cursor agent can implement it without this chat.

- [ ] **#41** product vision (locked)
- [ ] **#0 / #39** Mini host + Tailscale `tag:morpheus` (no `~` share)
- [ ] **A.** `ContextStore` + SQLite FTS5 (#26) — in-repo `01-context-store.md` (not the frozen GitHub body)
- [ ] **D.** Discord mention → `jobs` (role gate, caps) (#29)
- [ ] **Mini first-pass** POST `{ job, snippets, first_pass: true }` (#37)
- [ ] **#42** Grok Bot activated at `GROK_BOT_WEBHOOK_URL` (queue with a worker)
- [ ] **Live vfs** Tailscale `/v1/fs` tree/search/read (#40 / #27) — scoped tokens
- [ ] **E.** Idempotent Discord replies (#30)
- [ ] **Webhooks** `#sponsors` / `#opportunities` / `#speakers` / `#inbox` (#36)
- [ ] **F.** GitHub implementation-only; fail open (#31). Not the job-delivery contract.
- [ ] **#35** events HTTP after PR #23 + `grok_bot` enum
- [x] **C.** Feature-flag Nia off, then delete `src/nia/` (#28 — landed in PR #24)

## Constraints

- Official Discord bot only (`DISCORD_BOT_TOKEN` on the **Mac Mini**). No user-token / self-bot.
- Do not commit tokens, Doppler values, or a real `config/channels.yml`. Use relative links (`../context-layer.md`), not `blob/cursor/...` branch URLs. Filed GitHub #25/#26 still pin those; owner paste in #38.
- Grok Bot gets `DISCORD_WEBHOOK_*` only. Mini gets `DISCORD_BOT_TOKEN` + `GROK_BOT_WEBHOOK_URL`. Never swap those.
- HTTP uses **scoped** tokens; namespace is derived server-side. A client-supplied namespace is not auth.
- Leadership (`isolated: true`) must never leak into general search/read/jobs.
- Markdown export may stay until C ships; do not build new retrieval on it.

## Secrets / where things run

Must stay on the **Mac Mini** (Doppler / env, never git): `DISCORD_BOT_TOKEN`, `GROK_BOT_WEBHOOK_URL`, SQLite volume. **AWS is stale / overkill.** Not Cursor VMs. Not Grok Bot’s shared computer. **No `NIA_*`.**

Must **not** be given to Grok Bot: `DISCORD_BOT_TOKEN`. Webhook URLs (`DISCORD_WEBHOOK_*`) **are** for Grok Bot's operational feed. Grok also holds `MORPHEUS_BASE_URL` (tailnet) + a scoped `MORPHEUS_API_TOKEN_*`. Activation: #42.

**Stale:** stuffing the whole index into `GROK_BOT_WEBHOOK_URL`. Mini POSTs a **first-pass** pack; Grok **live-searches** `/v1/fs` over **Tailscale** (`tag:morpheus`, HTTP port only). Public internet still has no inbound Morpheus port. Homedir is **not** shared.

`NVIDIA_API_KEY` and the `openai` package are unused leftovers (classifier removed). Do not treat them as required.
