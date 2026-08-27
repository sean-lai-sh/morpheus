## Goal

Stop accidental implementation of the **May 2026 agent-v1** plan (in-process Pi/Claude inside Morpheus + Nia retrieval). That plan does **not** account for Grok Bot.

**GitHub #34 / #10 / #13 / #15 / #19 may still be OPEN** (this token 403s on close). In-repo marker: [`PARKED.md`](PARKED.md). Owner paste: **[`38-owner-close-stale.md`](38-owner-close-stale.md)** / [#38](https://github.com/sean-lai-sh/morpheus/issues/38). Product vision: **[#41](https://github.com/sean-lai-sh/morpheus/issues/41)**.

Read `docs/grok-bot-audit.md` only as history. Implement from **#41**, not from `agent-v1` labels.

## Park — do not implement as written

These fight Discord → Mac Mini → Grok Bot:

- **#10** in-process agent scaffold + placeholder mention reply (fights job queue #29)
- **#13** per-channel AbortController router (replaced by job CAS)
- **#15** `search_discord` via Nia (superseded by #40 vfs; Nia is already gone)
- **#19** `run_sandbox` tool + attaching files from a Morpheus-side Docker agent
- **#20 / #21** skills + `/event-status` entering Pi `runAgentTurn`

Slash commands may later **enqueue a Grok Bot job**; that is a new issue, not #21 as written.

## Already done / moot

- **#3** reconcile cron — implemented in `src/crawler/live.ts`
- **#5** thread attribution — PR #6
- **#2** backup-on-Nia-sync — Nia deleted in PR #24
- **#9** Nia CLI research — already closed
- **#28** Nia delete — done in PR #24. Do not soak-then-delete again.

## Park (maybe later, not Grok Bot MVP)

- **#7** events table — PR #23 **closed without merge**. #35 waits on events on main.
- **#8** sandbox **image** — optional files; **not** a deploy requirement.
- **#11** trigger predicates — reuse in #29; drop Pi tool-policy types.
- **#12** SQLite reply-chain context — optional; first-pass + live `/v1/fs`.
- **#14** resumeBackfill pagination — keep idea; Nia `flushNamespace` is gone.
- **#16** Drive — later as HTTP, not a Pi tool.
- **#22** setup CLI — later; no `register-nia`.

## Acceptance

A Cursor agent searching open issues for "Nia retrieval" / "agent" hits [`PARKED.md`](PARKED.md) + **#41** and does **not** implement #10 or #15 as written.
