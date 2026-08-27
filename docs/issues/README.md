# Issue drafts

These markdown files are the implementation-slice bodies for the Nia-exit / Discord-entry work. They are filed as GitHub issues on `sean-lai-sh/morpheus` (see the tracking epic). Keep this folder in sync if an issue is edited.

**Locked vision:** [#41](https://github.com/sean-lai-sh/morpheus/issues/41) — [`41-product-vision.md`](41-product-vision.md) is a pointer only; do not fork the body.

**In-repo is source of truth** for slices whose GitHub bodies are frozen (especially #25, #26, #27, #32). Never pin `blob/cursor/nia-migration-plan-9afa`.

| File | Slice | GitHub |
|---|---|---|
| `41-product-vision.md` | Locked North Star (pointer) | #41 |
| `00-epic.md` | Tracking epic + checklist | #25 |
| `01-context-store.md` | FTS5 ContextStore | #26 |
| `02-http-api.md` | Tailscale `/v1/fs` vfs; **scoped tokens** | #27 |
| `03-remove-nia.md` | Nia **removed in #24**; leftover openai/`NVIDIA_API_KEY` | #28 |
| `04-jobs-enqueue.md` | Mentions → jobs table | #29 |
| `05-jobs-claim-reply.md` | Claim/complete + Discord replies | #30 |
| `06-agent-poll-github.md` | GitHub for implementation only (poll-over-internet **stale**) | #31 |
| `32-index.md` | Clickable GitHub checklist | #32 |
| `33-grok-bot-consumer.md` | Grok Bot named as consumer | #33 |
| `34-park-agent-v1.md` | Park in-process Pi/Nia issues | #34 |
| `PARKED.md` | In-repo marker for #10/#13/#15/#19 | #38 |
| `35-events-http.md` | `/v1/events` over Tailscale (optional) | #35 |
| `36-discord-webhooks.md` | Operational feed webhooks | #36 |
| `37-mini-dispatch-grok.md` | Mini POST to GROK_BOT_WEBHOOK_URL | #37 |
| `38-owner-close-stale.md` | Owner must close/comment #10 #15 #19 #3 #5 | #38 |
| `39-mini-host.md` | Slice #0 Mini + Tailscale | #39 |
| `40-live-index-vfs.md` | Live tree/grep/cat over the index | #40 |
| `42-grok-bot-activation.md` | Worker at GROK_BOT_WEBHOOK_URL | #42 |
| `43-slash-ask.md` | `/ask` enqueues the same jobs table (#41) | follow-up to #29 |

Do not put secrets in these files.
