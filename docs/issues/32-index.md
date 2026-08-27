This index is GitHub issue **#32** (create-only; #25–#31 could not be edited after filing).

Parent epic: #25. Analysis: PR #24 / `docs/context-layer.md`.

GitHub issue create from this agent could not *edit* #25 after filing, so this index is the clickable checklist.

## Implementation order (Cursor slices)

- [ ] #26 ContextStore: SQLite FTS5 search/read/poll, namespace isolation
- [ ] #27 HTTP `/v1` search, read, poll (Bearer `MORPHEUS_API_TOKEN`)
- [ ] #28 Feature-flag and delete Nia (`src/nia/`, `register-nia`)
- [ ] #29 Discord mention/reply → jobs queue (official bot, no LLM)
- [ ] #30 Job claim/complete HTTP + in-process Discord replies
- [ ] #31 Cursor/Grok poll-loop contract + GitHub issue posting (no secrets in repo)

## Do not implement

- #15 Nia retrieval half (superseded by #26)
- Nia flush in #14 (`flushNamespace`)
- Self-bot / user-token Discord clients
- Putting `DISCORD_TOKEN` or `NIA_API_KEY` on Cursor agents

## Stale on main (close when convenient)

- #3 reconcile scheduling — already in `src/crawler/live.ts`
- #5 thread attribution — largely done in PR #6
