This index is GitHub issue **#32** (create-only; #25–#31 could not be edited after filing).

Parent epic: #25. Grok Bot product spec: #33. Park agent-v1: #34. Analysis: PR #24.

## Implementation order (Cursor slices)

- [ ] #26 ContextStore: SQLite FTS5 search/read/poll, namespace isolation
- [ ] #27 HTTP `/v1` search, read, poll (Bearer `MORPHEUS_API_TOKEN`)
- [ ] #29 Discord mention/reply → jobs queue (official bot, no LLM)
- [ ] #30 Job claim/complete HTTP + in-process Discord replies
- [ ] #31 / #33 Grok Bot poll-loop + GitHub issues
- [ ] #28 Feature-flag and delete Nia
- [ ] #35 `/v1/events` after PR #23 events half merges

## Do not implement (see #34)

- #10 in-process Pi mention handler
- #13 in-process AbortController router
- #15 Nia retrieval
- #19 Morpheus-side sandbox runtime
- Self-bot / user-token Discord clients
- Putting `DISCORD_TOKEN` or `NIA_API_KEY` on Grok Bot

## Stale on main (close when convenient)

- #3 reconcile scheduling — already in `src/crawler/live.ts`
- #5 thread attribution — largely done in PR #6
