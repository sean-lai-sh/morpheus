Parent: [#41](https://github.com/sean-lai-sh/morpheus/issues/41) (locked vision). GitHub issue **#42**. Follows #37. Host: [`docs/hosting.md`](../hosting.md).

## Goal

**Close the loop.** #29 enqueues a job and #37 POSTs it to `GROK_BOT_WEBHOOK_URL`. That is only a producer. Without a **live Grok Bot worker** at that URL, mentions sit in SQLite forever.

This slice is the consumer **activation**, not another poll loop. Product vision #41: Mini **pushes**; Grok Bot is **not** inbound HTTP and does **not** poll Discord. #31 as “Grok polls `/v1/jobs`” is **stale**.

## What “activated” means

1. There is a Cursor **Grok Bot** routine (`tech@nyu summary`) that accepts HTTPS POSTs.
2. Mini Doppler has `GROK_BOT_WEBHOOK_URL` set to that routine’s URL (https only) and `GROK_BOT_WEBHOOK_SECRET` for `Authorization: Bearer`.
3. On enqueue, Mini POSTs the thin first-pass pack (`first_pass: true`) — sketched in `src/notify/grok-dispatch.ts`.
4. That POST **is** the wakeup. Grok then:
   - uses first-pass snippets if they suffice, else Tailscale `/v1/fs` (#40)
   - returns `{ reply }` so Mini can `message.reply` (#30) as the official bot
   - does **not** post the @-reply via incoming webhooks
   - may POST ops-feed webhooks (**#36 only**) and optionally a GitHub issue (#31, fail open)

A scheduled “poll Mini every N minutes” Automation is **not** the primary contract.

## Operator checklist (outside this repo, but required)

- [ ] Grok Bot webhook exists and returns 2xx for a capped JSON job pack
- [ ] Mini `GROK_BOT_WEBHOOK_URL` points at it
- [ ] Grok secret store has `MORPHEUS_BASE_URL` (tailnet), scoped `MORPHEUS_API_TOKEN_*`, `DISCORD_WEBHOOK_*`
- [ ] Grok does **not** have `DISCORD_BOT_TOKEN`
- [ ] A test mention in an allowlisted channel produces a Grok run (not only a `jobs` row)

Document the Cursor-side webhook in the Grok Bot / Automation UI, not in git.

## Files in this repo

- `src/notify/grok-dispatch.ts` — Mini POST (already sketched)
- Wire from #29 after first-pass snippets
- `.env.example` — `GROK_BOT_WEBHOOK_URL=`
- This spec so the next agent does not ship a queue with no worker

## Out of scope

- Polling `/v1/jobs` over the public internet
- Hosting Morpheus on Grok Bot’s box
- Fat webhook as the retrieval API
- Implementing the Grok Bot product inside `bun run live`

## Acceptance

- [ ] Docs name `GROK_BOT_WEBHOOK_URL` as the **worker trigger** (not a nice-to-have)
- [ ] #31 is not described as how Grok receives work
- [ ] Missing URL: Mini skips dispatch (warn) and does not crash; that is **not** “activated”
- [ ] Operator checklist above is in this issue (implementation can live in Cursor; contract cannot)

## Dependencies

#37 Mini POST, #29 enqueue, #40 live index, #30 official-bot reply. Product vision #41.
