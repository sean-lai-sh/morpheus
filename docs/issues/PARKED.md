# PARKED / SUPERSEDED — do not implement as written

**Product vision (locked):** [#41](https://github.com/sean-lai-sh/morpheus/issues/41).

GitHub may still show these as OPEN (Cursor tokens often 403 on close/comment). **This file is the in-repo marker.** Searching “Nia retrieval”, “search_discord”, “runAgentTurn”, “Grok polls `/v1/jobs`”, or “soak then delete Nia” must hit this page and stop.

Owner paste to actually close GitHub: [`38-owner-close-stale.md`](38-owner-close-stale.md).

## Live work (only these)

#41 vision · #39 Mini host · #29 enqueue · #37 Mini POST · #42 Grok worker · #40 live index vfs · #36 ops webhooks · #30 official-bot reply.

Tiny independent ops (not the agent loop): #1 `clientReady`, #4 `--channel` backfill.

## Do not implement — Nia-exit / poll-loop (superseded by #41 / done in #24)

| Issue | Why |
|---|---|
| #25 | Epic migrate off Nia. Nia is gone. Remaining work is #41 slices. |
| #26 | Frozen GitHub body (poll-by-`created_at`, client namespace). Use in-repo `01-context-store.md` / #40 / PR 44. |
| #27 | Frozen GitHub `/v1`. Use `02-http-api.md` / #40 (scoped tokens, `/v1/fs`, no client namespace). |
| #28 | **Done** in PR #24. `src/nia/` gone. Mini boots with zero `NIA_*`. Do not delete Nia again. |
| #31 | Poll-loop as how Grok receives work. Replaced by Mini POST #37 + Grok worker #42. |
| #32 | Nia-exit index linking #25–#31. Superseded by #41. |
| #33 | “Grok polls `/v1/jobs`” writeup. Consumer **name** lives in #41; Mini pushes. |
| #34 | Park agent-v1 meta. Close after May issues close. |
| #35 | `/v1/events`. Depends on PR #23 events table; **#23 closed without merge**. Do not implement until events exist on main. |
| #38 | Owner close-list. Close once the numbers below are actually closed. |

## Do not implement — May 2026 agent-v1 (Pi / Nia / sandbox)

| Issue | Why |
|---|---|
| #2 | Backup-on-Nia-sync. Nia is gone. Nightly backup already exists in `live.ts`. |
| #3 | Reconcile cron — **done** in `src/crawler/live.ts`. |
| #5 | Thread attribution — **done** in PR #6. |
| #7 | Events table. PR #23 closed unmerged. Not Pi tools. Park until events land on main. |
| #8 | Sandbox **image**. Optional files; not a Grok Bot deploy requirement. |
| #10 | In-process agent scaffold + mention reply. Fights job queue #29. |
| #11 | Pi trigger/tool-policy types. Steal predicates into #29 only. |
| #12 | In-process reply-chain context. Grok uses first-pass + `/v1/fs`. |
| #13 | Per-channel AbortController. Job CAS replaces it. |
| #14 | resumeBackfill + Nia `flushNamespace`. Pagination maybe later; Nia flush is gone. |
| #15 | `search_discord` via **Nia**. Use #40 vfs. Do not implement Nia retrieval. |
| #16 | Drive as a Pi tool. Later HTTP if needed. |
| #17 / #18 | `event_status` / `event_update` as Pi tools. Blocked on events on main (#35). |
| #19 | Morpheus-side sandbox runtime. Grok Bot is the coding agent. |
| #20 / #21 | Skills + `/event-status` into Pi `runAgentTurn`. Slash may later **enqueue** a Grok job (#41). |
| #22 | Setup CLI as written (register-nia happy path). Nia is gone. |

Do **not** restore `src/nia/`. Do **not** add poll-loop scripts. Do **not** implement self-bot / Pi / fat-job / homedir mount.
