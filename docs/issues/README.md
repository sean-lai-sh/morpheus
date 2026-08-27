# Issue drafts

**Locked vision:** [#41](https://github.com/sean-lai-sh/morpheus/issues/41) — [`41-product-vision.md`](41-product-vision.md) is a pointer only; do not fork the body.

Cursor/Grok agents: start at **#41**. Ignore May `agent-v1` issues, frozen GitHub **#26 / #31 / #33** bodies, Nia, and poll-loop “Grok polls `/v1/jobs`”. Nia was **removed in PR #24**. Marker: [`PARKED.md`](PARKED.md).

In-repo files below are slice notes. GitHub bodies for closed/stale numbers may still be open (this identity often 403s on close/comment). Treat GitHub **#25–#28, #31–#35, #38, #2–#22** as historical unless listed in the live table.

## Live (parent: #41)

| File | Slice | GitHub |
|---|---|---|
| `41-product-vision.md` | Locked North Star (pointer) | **#41** |
| `39-mini-host.md` | Slice #0 Mini + Tailscale | **#39** |
| `04-jobs-enqueue.md` | Mentions → jobs table | **#29** |
| `37-mini-dispatch-grok.md` | Mini POST to `GROK_BOT_WEBHOOK_URL` | **#37** |
| `42-grok-bot-activation.md` | Worker at `GROK_BOT_WEBHOOK_URL` | **#42** |
| `40-live-index-vfs.md` | Live tree/grep/cat over the index | **#40** |
| `01-context-store.md` | FTS5 ContextStore (implement this, **not** frozen GitHub #26) | #40 / PR 44 |
| `02-http-api.md` | Tailscale `/v1/fs`; **scoped tokens** (not frozen GitHub #27) | #40 / PR 44 |
| `05-jobs-claim-reply.md` | Claim/complete + Discord `message.reply` | **#30** |
| `36-discord-webhooks.md` | Operational feed webhooks | **#36** |

## Historical (removed / superseded — do not implement)

| File | Why | GitHub |
|---|---|---|
| `00-epic.md` | Nia-exit epic; remaining work is #41 | #25 |
| `03-remove-nia.md` | Nia **already deleted** in #24 | #28 |
| `06-agent-poll-github.md` | Poll-loop **stale**; GitHub issues = implementation only | #31 |
| `32-index.md` | Older Nia-exit checklist; superseded by #41 | #32 |
| `33-grok-bot-consumer.md` | Consumer **name** lives on in #41; poll-loop text is stale | #33 |
| `34-park-agent-v1.md` | Park May Pi/Nia | #34 |
| `35-events-http.md` | Needs events table on main; PR #23 closed unmerged | #35 |
| `PARKED.md` | In-repo do-not-implement list | — |
| `38-owner-close-stale.md` | Owner paste to close GitHub clutter | #38 |

Do not put secrets in these files. Do not implement jobs/vfs in a docs-only PR. Do not merge PRs #43 / #44 from this cleanup.
