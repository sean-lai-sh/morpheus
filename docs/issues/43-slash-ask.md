Parent: #41. Ships with #29 (same `jobs` table). Official bot only. No in-process LLM.

## Goal

Slash commands are **in** the product ([#41](https://github.com/sean-lai-sh/morpheus/issues/41)). Mentions may be the first trigger; `/ask` is the `/cmd` that must not stay a non-goal.

`/ask` enqueues the **same** SQLite `jobs` row as `@bot` / reply-to-bot (`src/bot/enqueue.ts` → `tryEnqueueJob` with `source: "slash"`). Mini still POSTs `{ job, snippets, first_pass: true }` to `GROK_BOT_WEBHOOK_URL`. Complete still uses official-bot `message.reply` (#30).

## Command

- Name: `ask`
- Option: `question` (string, required)
- Guild-scoped registration (`applications.commands` + `DISCORD_GUILD_ID`)
- Discord requires an ACK within 3s: public `Queued.` (not the Grok answer). That ACK message id is `jobs.discord_message_id` so complete can `message.reply`.
- Same role gate, channel allowlist, namespace, and caps as mentions.
- Leadership `/ask` may Discord-reply; do not open GitHub issues from those by default.

## Out of scope

- `/event-status` into pi-agent-core (#21 parked)
- In-process LLM
- Self-bot
