This index is GitHub issue **#32** (create-only). Owner close of stale issues: **#38**. **Locked vision: [#41](https://github.com/sean-lai-sh/morpheus/issues/41).**

Parent epic: #25. Grok Bot: #33. Host: #39. Live index: #40. Activation: #42. Park agent-v1: #34 / [`PARKED.md`](PARKED.md). Analysis: PR #24.

**One cutover** (#28 last). Relative links only — never `blob/cursor/nia-migration-plan-9afa`.

## Implementation order

- [ ] **#41** product vision (locked — do not re-litigate)
- [ ] #39 Mini host + Tailscale `tag:morpheus` (no public inbound, no `~` share)
- [ ] #26 ContextStore FTS (`namespaceForRow`, `channelId`+`parentChannelId`, poll **seq**) — in-repo `01-context-store.md`, **not** the frozen GitHub body
- [ ] #29 Discord mention → jobs (role gate, caps, trigger ≠ ingest). `/cmd` follow-up, still in-product (#41)
- [ ] #37 Mini first-pass POST (`first_pass: true`, not a full-index dump)
- [ ] **#42** Grok Bot **activated** at `GROK_BOT_WEBHOOK_URL` (queue with a worker)
- [ ] #40 / #27 Tailscale vfs: `/v1/fs/tree|search|read`, scoped tokens
- [ ] #30 Idempotent Discord replies; `claimed_by` mandatory; **Send Messages in Threads**
- [ ] #36 Operational Discord webhooks `#sponsors` `#opportunities` `#speakers` `#inbox`
- [ ] #31 GitHub implementation-only (fail open; allowlisted repo; approval). **Not** how Grok receives work
- [ ] #35 `/v1/events` after PR #23 + `grok_bot` enum
- [ ] #28 **last** — feature-flag and delete Nia (acceptance = `rg`/`tsc`/`bun test`, no Doppler)

## Do not implement

- #10 / #13 / #15 / #19 (owner: #38; in-repo marker: [`PARKED.md`](PARKED.md))
- Fat webhook as the retrieval API
- Homedir / SSHFS / NFS / SMB of the Mini
- One shared `MORPHEUS_API_TOKEN` plus client-supplied `namespace`
- `DISCORD_BOT_TOKEN` on Grok Bot
- AWS / Fly / Cursor VM as 24/7 host
- Poll-loop #31 as the consumer contract
