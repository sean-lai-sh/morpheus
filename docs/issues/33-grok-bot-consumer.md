## Goal

Name the **consumer** so later Cursor slices do not rebuild the May 2026 in-process Pi agent.

**Grok Bot** = Cursor Grok Bot / Tech@NYU summary-and-implementation agent. It is **not** a process inside `bun run live`. It does **not** host Morpheus.

**Host** = Mac Mini (`docs/hosting.md`). AWS / Cursor cloud-agent VMs / Grok Bot's shared computer are **not** 24/7 hosts.

## The loop (required)

1. Official Discord bot on the Mini (`DISCORD_BOT_TOKEN`). Mentions / ingest in allowlisted channels. Not a self-bot.
2. Mini reads SQLite context and **POSTs** `{ job, snippets }` to `GROK_BOT_WEBHOOK_URL` (outbound only; no public inbound IP).
3. Grok Bot (one-shot) then:
   - posts **operational FYIs** to Discord incoming webhooks (`#sponsors` / `#opportunities` / `#speakers` / `#inbox`)
   - opens a **GitHub issue** only for implementation work, and only if GitHub credentials exist
4. Grok Bot never receives `DISCORD_BOT_TOKEN`.

Leadership (`isolated: true`) jobs: Discord feed allowed; GitHub issue posting **off** by default.

## Do not build

- Self-bot / user token
- Running Morpheus on Grok Bot's box or Cursor cloud agents
- AWS as the v1 host
- `nia-cli` or reading Nia filesystem dumps
- `@mariozechner/pi-agent-core` mention handler (#10)
- Nia-backed `search_discord` (#15)
- Docker sandbox on the Mini as a Grok Bot dependency (#8 / #19)

## Implement in this order

#26 → #29 + Mini dispatch (#37) → webhooks (#36) → #31 (GitHub optional) → #28 last.

`/v1` (#27) is localhost-on-Mini only; Grok does not poll it over the internet.

## Docs

`docs/hosting.md`, `docs/context-layer.md`, `docs/grok-bot-audit.md`, PR #24.

## Acceptance

A new Cursor agent can implement the Mini→Grok webhook without reading the May `agent-v1` issues, and without adding Nia, pi-agent-core, or AWS.
