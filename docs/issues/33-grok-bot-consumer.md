**SUPERSEDED as the implementation contract by [#41](https://github.com/sean-lai-sh/morpheus/issues/41).** Keep the **consumer name** (Grok Bot). Poll-loop / “Grok polls `/v1/jobs`” text in the GitHub body is **stale** — Mini pushes (#37 / #42).

## Goal

Name the **consumer** so later Cursor slices do not rebuild the May 2026 in-process Pi agent.

**Grok Bot** = Cursor Grok Bot / Tech@NYU summary-and-implementation agent. It is **not** a process inside `bun run live`. It does **not** host Morpheus.

**Host** = Mac Mini (`docs/hosting.md`). AWS / Cursor cloud-agent VMs / Grok Bot's shared computer are **not** 24/7 hosts.

## The loop (required)

1. Official Discord bot on the Mini (`DISCORD_BOT_TOKEN`). Not a self-bot.
2. Mini **POSTs** a **first-pass** `{ job, snippets, first_pass: true }` to `GROK_BOT_WEBHOOK_URL` (`Authorization: Bearer GROK_BOT_WEBHOOK_SECRET`).
3. Grok Bot (one-shot) **live-searches the Morpheus index** over Tailscale (`/v1/fs/tree|search|read`) if snippets are not enough. Index paths only — not the Mini homedir.
4. Then Grok:
   - returns `{ reply }` to Mini (job complete)
   - Mini posts the member-facing answer with discord.js `message.reply` as the official bot (#30)
   - may post **operational FYIs** via Discord incoming webhooks (**#36 only**: `#sponsors` / `#opportunities` / `#speakers` / `#inbox` / hello@ inbound — not the @-reply)
   - opens a **GitHub issue** only for implementation work (fail open if `gh` missing)
5. Grok Bot never receives `DISCORD_TOKEN`. Incoming webhooks are not the conversational reply path.

## Do not build

- Self-bot / user token
- Running Morpheus on Grok Bot's box or Cursor cloud agents
- AWS / Fly as the v1 host
- SSHFS / NFS / SMB of `~` or any Mini filesystem mount
- Fat webhook as the retrieval API
- `nia-cli` or reading Nia filesystem dumps
- `@mariozechner/pi-agent-core` mention handler (#10)
- Nia-backed `search_discord` (#15)

## Implement in this order

**#41’s sequence:** **#39** host → #29 jobs → #37 first-pass POST → **#42 activate Grok Bot webhook** → **#40 Tailscale vfs** → #30 replies → #36 webhooks.

Nia was **removed in #24**. Poll-over-internet #31 is **not** how Grok receives work. Mini pushes; the worker is the Grok Bot URL (#42).

## Docs

`docs/hosting.md`, `docs/context-layer.md`, `docs/grok-bot-audit.md`, PR #24.

## Acceptance

A new Cursor agent can implement the Mini→Grok webhook without reading the May `agent-v1` issues, and without adding Nia, pi-agent-core, or AWS.
