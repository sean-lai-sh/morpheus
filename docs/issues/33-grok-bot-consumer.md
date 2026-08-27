Superseded in part by hierarchical workspaces — see docs/context-layer.md §Workspaces.

## Goal

Name the **consumer** so later Cursor slices do not rebuild the May 2026 in-process Pi agent.

**Grok Bot** = Cursor Grok Bot / Tech@NYU summary-and-implementation agent. It is **not** a process inside `bun run live`. It does **not** host Morpheus.

**Host** = Mac Mini (`docs/hosting.md`). AWS / Cursor cloud-agent VMs / Grok Bot's shared computer are **not** 24/7 hosts.

## The loop (required)

1. Official Discord bot on the Mini (`DISCORD_BOT_TOKEN`). Not a self-bot.
2. Mini **POSTs** a **first-pass** `{ job, snippets, first_pass: true }` to `GROK_BOT_WEBHOOK_URL`.
   Honor `job.channel_ids` / `job.scope` (MVP channel scope, temporary until proper isolation): do not tree all of `/general` unless `scope` is `leadership`. Mini `/v1/fs` tokens stay namespace-scoped.
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

**One sequence** (`docs/context-layer.md` §7): **#39** host → #26 FTS → #29 jobs → #37 first-pass POST → **#42 activate Grok Bot webhook** → **#40/#27 Tailscale vfs** → #30 replies → #36 webhooks → #31 GitHub optional → **#28 last**.

Product vision (locked): [#41](https://github.com/sean-lai-sh/morpheus/issues/41).

#31 poll-over-internet is **not** how Grok receives work. Mini pushes; the worker is the Grok Bot URL (#42). Without #42 this is a queue with no consumer.

## Docs

`docs/hosting.md`, `docs/context-layer.md`, `docs/grok-bot-audit.md`, PR #24.

## Acceptance

A new Cursor agent can implement the Mini→Grok webhook without reading the May `agent-v1` issues, and without adding Nia, pi-agent-core, or AWS.
