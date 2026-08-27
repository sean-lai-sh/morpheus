## Goal

Stop accidental implementation of the **May 2026 agent-v1** plan (in-process Pi/Claude inside Morpheus + Nia retrieval). That plan does **not** account for Grok Bot.

Read `docs/grok-bot-audit.md` before picking up any `agent-v1` labeled issue.

## Park — do not implement as written

These fight Discord → Morpheus → Grok Bot:

- **#10** in-process agent scaffold + placeholder mention reply (fights job queue #29)
- **#13** per-channel AbortController router (replaced by job CAS)
- **#15** `search_discord` via Nia (superseded by #26 FTS)
- **#19** `run_sandbox` tool + attaching files from a Morpheus-side Docker agent
- **#20 / #21** skills + `/event-status` entering Pi `runAgentTurn`

Slash commands may later **enqueue a Grok Bot job**; that is a new issue, not #21 as written.

## Keep / reshape

- **#7** events table — merge via PR #23 (events half). Then HTTP in a follow-up, not Pi tools #17/#18.
- **#8** sandbox **image** — optional files on disk; **not** a deploy requirement for Grok Bot.
- **#11** trigger predicates — reuse in #29; drop Pi `namespacePolicy` tool types.
- **#12** SQLite reply-chain context — optional; Grok can use `/v1` windows instead.
- **#14** resumeBackfill pagination — keep; **delete** Nia `flushNamespace`.
- **#16** Drive — later as HTTP for Grok, not a Pi tool.
- **#22** setup CLI — keep; remove `register-nia` from the happy path.

## Close when convenient (already done on main)

- **#3** reconcile cron — implemented in `src/crawler/live.ts`
- **#5** thread attribution — PR #6

## Close / supersede

- **#2** backup-on-Nia-sync
- **#9** already closed (Nia CLI research)

## Acceptance

A Cursor agent searching open issues for "agent" sees this issue and #33 **before** implementing #10 or #15.
