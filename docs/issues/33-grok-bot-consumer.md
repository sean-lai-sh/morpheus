## Goal

Name the **consumer** so later Cursor slices do not rebuild the May 2026 in-process Pi agent.

**Grok Bot** = Cursor Grok Bot / Tech@NYU summary-and-implementation agent. It is **not** a process inside `bun run live`. It is **not** a human running `nia` or reading `data/discord/`.

## The loop (required)

1. Official Discord bot (discord.js, `DISCORD_TOKEN` only on the Morpheus host). Mentions and replies-to-bot in allowlisted channels.
2. Morpheus enqueues a **job** and keeps SQLite context. Exposes HTTP `/v1/search`, `/v1/messages`, `/v1/poll`, `/v1/jobs` with `MORPHEUS_API_TOKEN`.
3. Grok Bot **polls** `/v1/jobs`, claims, searches/reads, then:
   - opens a **GitHub issue** (Grok Bot's GitHub identity) with implementation suggestions when appropriate
   - `POST /v1/jobs/:id/complete` with `{ reply, github_issue_url? }`
4. Morpheus posts the Discord reply. Grok Bot never receives `DISCORD_TOKEN`.

Leadership (`isolated: true`) jobs: Discord reply allowed; GitHub issue posting **off** by default.

## Do not build

- Self-bot / user token
- `nia-cli` or reading Nia filesystem dumps
- `@mariozechner/pi-agent-core` mention handler (#10)
- Nia-backed `search_discord` (#15)
- Docker sandbox on the bot host as a Grok Bot dependency (#8 / #19)

## Implement in this order

#26 → #27 → #29 → #30 → #31 (with this issue as the product spec) → #28.

Events table from PR #23 / #7 may merge in parallel. Expose it over HTTP in a follow-up, not as a Pi tool.

## Docs

`docs/context-layer.md`, `docs/grok-bot-audit.md`, PR #24.

## Acceptance

A new Cursor agent can implement #29/#30/#31 without reading the May `agent-v1` issues, and without adding Nia or pi-agent-core.
