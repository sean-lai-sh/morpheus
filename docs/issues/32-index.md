This index is GitHub issue **#32** (create-only; #25–#31 could not be edited after filing). Owner close of stale issues: **#38**.

Parent epic: #25. Grok Bot: #33. Park agent-v1: #34. Hosting: `docs/hosting.md`. Analysis: PR #24.

**One cutover sequence** (#28 last). Relative links only (`docs/...`), not `blob/cursor/nia-migration-plan-9afa`.

## Implementation order (Cursor slices)

- [ ] #26 ContextStore: SQLite FTS5; `namespaceForRow`; poll by change seq
- [ ] #29 Discord mention → jobs (role gate, caps, trigger ≠ ingest)
- [ ] #37 Mini → `GROK_BOT_WEBHOOK_URL` (`docs/hosting.md`)
- [ ] #30 Idempotent Discord replies; `claimed_by` mandatory; **Send Messages in Threads**
- [ ] #36 Operational Discord webhooks `#sponsors` `#opportunities` `#speakers` `#inbox`
- [ ] #31 GitHub implementation-only (optional `gh`; fail open; allowlisted repo; approval)
- [ ] #27 HTTP `/v1` localhost-on-Mini; **scoped tokens**; namespace derived server-side
- [ ] #35 `/v1/events` after PR #23 events + `grok_bot` in `EVENT_SOURCE_TYPES`
- [ ] #28 **last** — feature-flag and delete Nia

## Do not implement (see #34 / #38)

- #10 in-process Pi mention handler
- #13 in-process AbortController router
- #15 Nia retrieval
- #19 Morpheus-side sandbox runtime
- Self-bot / user-token Discord clients
- One shared `MORPHEUS_API_TOKEN` plus client-supplied `namespace`
- Putting `DISCORD_BOT_TOKEN` or `NIA_API_KEY` on Grok Bot
- Hosting Morpheus on AWS, Cursor VMs, or Grok Bot's shared computer
- Assuming Grok always has `gh` credentials

## Stale on main (owner close — #38)

- #3 reconcile scheduling — already in `src/crawler/live.ts`
- #5 thread attribution — largely done in PR #6
