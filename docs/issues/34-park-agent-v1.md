## Goal

Stop accidental implementation of the **May 2026 agent-v1** plan (in-process Pi/Claude inside Morpheus + Nia retrieval). That plan does **not** account for Grok Bot.

**#34 alone is not enough.** #10 / #13 / #15 / #19 remain open and labeled `agent-v1` with **no parked marker on GitHub**. #15 still says implement Nia retrieval. This token cannot mutate those issues (403). In-repo marker: [`PARKED.md`](PARKED.md). Owner paste: **[#38](https://github.com/sean-lai-sh/morpheus/issues/38)**. Product vision: **[#41](https://github.com/sean-lai-sh/morpheus/issues/41)**.

Read `docs/grok-bot-audit.md` before picking up any `agent-v1` labeled issue.

## Park — do not implement as written

These fight Discord → Mac Mini → Grok Bot:

- **#10** in-process agent scaffold + placeholder mention reply (fights job queue #29)
- **#13** per-channel AbortController router (replaced by job CAS)
- **#15** `search_discord` via Nia (superseded by #26 FTS)
- **#19** `run_sandbox` tool + attaching files from a Morpheus-side Docker agent
- **#20 / #21** skills + `/event-status` entering Pi `runAgentTurn`

Slash commands may later **enqueue a Grok Bot job**; that is a new issue, not #21 as written.

## Keep / reshape

- **#7** events table — merge via PR #23 (events half, including `grok_bot` in `EVENT_SOURCE_TYPES`). Then optional localhost HTTP (#35), not Pi tools #17/#18.
- **#8** sandbox **image** — optional files on disk; **not** a deploy requirement for Grok Bot.
- **#11** trigger predicates — reuse in #29; drop Pi `namespacePolicy` tool types. Add role gate + caps (#29).
- **#12** SQLite reply-chain context — optional; first-pass snippets in the Mini→Grok POST, then live `/v1/fs` read (#40).
- **#14** resumeBackfill pagination — keep; **delete** Nia `flushNamespace`.
- **#16** Drive — later as localhost HTTP, not a Pi tool.
- **#22** setup CLI — keep; remove `register-nia` from the happy path.

## Close when convenient (already done on main) — owner: #38

- **#3** reconcile cron — implemented in `src/crawler/live.ts`
- **#5** thread attribution — PR #6

## Close / supersede — owner: #38

- **#10, #13, #15, #19** as parked/superseded
- **#2** backup-on-Nia-sync
- **#9** already closed (Nia CLI research)

## Acceptance

- [ ] Owner has closed or `[PARKED]`-commented #10, #13, #15, #19, #3, #5 (commands in #38). Docs in this repo are not a substitute for those GitHub comments.
- [ ] A Cursor agent searching open issues for "Nia retrieval" / "agent" is pointed at [`PARKED.md`](PARKED.md), #33 / #34 / #38 / #41 and does **not** implement #10 or #15 as written
