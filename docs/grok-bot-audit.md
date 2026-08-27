# Audit: issues & PRs vs Discord → Morpheus → Grok Bot

Consumer for this work: **Cursor Grok Bot** (Tech@NYU summary / implementation agent), talked to through the **official Discord bot**, using Morpheus as a **remote queryable context layer**. Grok Bot **polls** Morpheus, then files GitHub issues and the bot posts Discord replies.

This is **not**:

- A local Nia / `data/discord` dump that a human or laptop agent `ls`s
- `nia-cli` as the retrieval API
- An in-process Pi/Claude agent (`@mariozechner/pi-agent-core`) living inside `bun run live`

Investigated: all GitHub issues (open + closed #9), PRs #6 (merged), #23 (open), #24 (this analysis), and `origin/agent` (identical to `main`, no extra commits).

---

## Target loop (breaking vs older plans)

```
 Tech@NYU Discord  --official bot token-->  Morpheus (always-on)
        ^                                         |
        | replies                                 | SQLite + HTTP /v1
        |                                         v
        +-------- complete job -----------  Grok Bot (Cursor Cloud)
                                                    |
                                                    +--> GitHub issues (Grok's gh identity)
```

**Breaking change vs agent-v1 (#10–#22):** mention does **not** call `runAgentTurn` in-process. Mention enqueues a **job**. Grok Bot is the model. Morpheus does not hold Anthropic/OpenAI keys for that path.

**Breaking change vs Nia-index-overhaul (PR #6, on main):** markdown + Nia push remain until #28, but **retrieval for Grok Bot is HTTP + FTS, never a folder of artifacts.**

---

## Open PRs (read, not assumed stale)

### [PR #24](https://github.com/sean-lai-sh/morpheus/pull/24) — this branch

Docs + issue drafts for the loop above. Keep.

### [PR #23](https://github.com/sean-lai-sh/morpheus/pull/23) — `claude/fix-issues-7-8-5VsDP`

Read in full (commits `1cd775a` + review-fix `dc3afdf`). CI green.

| Half | Verdict |
|---|---|
| **Events table** (`src/storage/events.ts`, migration, tests) | **Keep / merge.** No Nia, no filesystem dump. Useful structured context Grok Bot can later read/write via `/v1`. Follow-up on that branch adds `grok_bot` as `source_type` (in-process `agent_update` is no longer the only writer). |
| **Sandbox Docker image** (`docker/`, `build:sandbox`, gated tests) | **Park. Do not treat as required for Grok Bot.** Built for issue #19 (`run_sandbox` inside Pi). Grok Bot already has a Cursor Cloud VM. Do **not** add Docker as a dependency of the Discord ingest host. Files can stay in the tree with a warning; they are off the critical path. |

Codex/Copilot P1/P2 on the first commit were addressed in `dc3afdf` (CAS `WHERE version = ?`, partial updates, pip-installed numpy/pandas/matplotlib). Residual style nits only.

### [PR #6](https://github.com/sean-lai-sh/morpheus/pull/6) — merged

This **is** the local hierarchical markdown + dual Nia namespace dump. Correct for what it was. Grok Bot must not consume it. Exit path: #26–#28.

### `origin/agent`

No commits vs `main`. Dead name, not a hidden architecture.

---

## Issues — keep / park / superseded

### Keep (ops or Grok Bot path)

| Issue | Why |
|---|---|
| #1 `clientReady` | Official bot, one-line. Independent. |
| #4 `--channel` backfill | Human ops; still useful when adding a channel. Not the agent loop. |
| #7 events schema | **Keep.** Implemented in PR #23. Grok Bot later reads via HTTP (#35). |
| #14 resumeBackfill **pagination only** | Useful freshness before Grok sees a channel. **Drop** `flushNamespace` / Nia. |
| #22 `bun run setup` | Human CLI for `channels.yml`. **Drop** the “then run register-nia” step. Keep interactive allowlist writer. |
| #25–#32 | Nia-exit + job queue (this investigation). Refine: Grok Bot is the named consumer. |

### Superseded / do not implement as written

| Issue | Why it fights the loop |
|---|---|
| #2 backup after Nia sync | Nia-shaped. Nightly backup already exists in `live.ts`. |
| #3 reconcile cron | **Already done** in `src/crawler/live.ts`. Close. |
| #5 thread markdown attribution | **Mostly done** in PR #6. Close. |
| #9 Nia-index pi-mono | Closed; used `nia` CLI. Do not revive. |
| #10 in-process agent scaffold + mention reply | **Fights #29.** Mention must enqueue a job, not `runAgentTurn`. |
| #13 AbortController router | In-process concurrency. Job CAS + cancel-queued-in-channel replaces it. |
| #15 search_discord via **Nia** | **Superseded by #26.** Namespace isolation + FTS remain. |
| #19 sandbox runtime + Discord attachments | In-process coding agent. Grok Bot is the coding agent. |
| #20–#21 skills + `/event-status` entering Pi | Slash can later **enqueue a job** for Grok Bot; do not build a second agent runtime first. |

### Park (maybe later, not Grok Bot MVP)

| Issue | Notes |
|---|---|
| #8 sandbox **image** | Image-only; no runtime. Harmless on disk, not a deploy requirement. |
| #11 triggers/permissions/freshness | Steal trigger *predicates* into #29; drop Pi tool-policy types. |
| #12 context.ts from SQLite reply chain | Grok Bot can use `/v1/channels/:id/messages` + job content instead of an in-process history builder. Optional later. |
| #16 Drive adapter | Valuable as **HTTP** `GET /v1/drive/...` for Grok, not a Pi tool. New issue when needed. |
| #17–#18 event_status / event_update as Pi tools | Replace with `/v1/events` after #7 merges (#35). |

---

## What Grok Bot implementation slices assume

Every new slice must assume all three:

1. **Official Discord bot** (`discord.js` + `DISCORD_TOKEN` on the Morpheus host only). No self-bot, no user token.
2. **Morpheus is HTTP + SQLite**, not `data/discord/**` and not Nia. Grok Bot polls `/v1/jobs`, `/v1/search`, `/v1/messages`, `/v1/poll` with `MORPHEUS_API_TOKEN`.
3. **Grok Bot files GitHub issues** from Discord jobs (its GitHub identity). Morpheus posts Discord replies on `complete`. Leadership jobs do not open public GitHub issues by default.

Do not add `ANTHROPIC_API_KEY` / `AGENT_MODEL` / pi-agent-core to the MVP path.

---

## Branch hygiene (2026-08-27)

Inventory of `sean-lai-sh/morpheus` remotes after cleanup. Goal: next Cursor cloud agents launch onto a clean `cursor/*` namespace and are not tempted by leftover Nia/agent names.

| Ref | Action |
|---|---|
| `main` | **Kept** |
| `cursor/nia-migration-plan-9afa` + [PR #24](https://github.com/sean-lai-sh/morpheus/pull/24) | **Kept** — this analysis |
| `claude/fix-issues-7-8-5VsDP` + [PR #23](https://github.com/sean-lai-sh/morpheus/pull/23) | **Kept** — not a `cursor/*` collision; events table is mergeable for Grok Bot. Sandbox half is parked in-tree (`docker/README.md`) |
| `origin/agent` | **Deleted** — identical to `main`; abandoned name would look like an agent branch |
| `origin/nia-index-overhaul` | **Deleted** — leftover of merged PR #6 (Nia filesystem dump). History remains on `main` |

No other `cursor/*` remotes existed. No open PR was closed (the only other open PR is #23, which is worthwhile).

