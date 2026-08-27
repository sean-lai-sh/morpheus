This index is GitHub issue **#32** (create-only; #25–#31 could not be edited after filing).

Parent epic: #25. Grok Bot product spec: #33. Park agent-v1: #34. Analysis: PR #24.

## Implementation order (Cursor slices)

- [ ] #26 ContextStore: SQLite FTS5 search/read/poll, namespace isolation
- [ ] #29 Discord mention/reply → jobs queue (official bot, no LLM)
- [ ] #37 Mini → `GROK_BOT_WEBHOOK_URL` dispatch (`docs/hosting.md`)
- [ ] #30 Idempotent Discord replies (official bot)
- [ ] #36 Operational Discord webhooks `#sponsors` `#opportunities` `#speakers` `#inbox`
- [ ] #31 GitHub issues for implementation only (optional `gh`)
- [ ] #27 HTTP `/v1` localhost-on-Mini only (not Grok over the internet)
- [ ] #28 **last** — feature-flag and delete Nia
- [ ] #35 `/v1/events` after PR #23 events half merges (localhost)

## Do not implement (see #34)

- #10 in-process Pi mention handler
- #13 in-process AbortController router
- #15 Nia retrieval
- #19 Morpheus-side sandbox runtime
- Self-bot / user-token Discord clients
- Putting `DISCORD_BOT_TOKEN` or `NIA_API_KEY` on Grok Bot
- Hosting Morpheus on AWS, Cursor VMs, or Grok Bot's shared computer

## Stale on main (close when convenient)

- #3 reconcile scheduling — already in `src/crawler/live.ts`
- #5 thread attribution — largely done in PR #6
