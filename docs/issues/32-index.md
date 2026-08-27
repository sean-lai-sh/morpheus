This index is **historical** (GitHub #32). **Locked vision: [#41](https://github.com/sean-lai-sh/morpheus/issues/41).**

Nia was **removed in PR #24**. There is no “#28 last / soak then delete Nia” work left. Do not restore `src/nia/`.

Remaining implementation order is **#41’s list**, not the #25–#31 Nia-exit checklist:

1. #39 Mini host + Tailscale `tag:morpheus` (no public inbound, no `~` share)
2. #29 Discord mention → jobs (role gate, caps). `/cmd` follow-up, still in-product
3. #37 Mini first-pass POST (`Authorization: Bearer GROK_BOT_WEBHOOK_SECRET`)
4. #42 Grok Bot activated at `GROK_BOT_WEBHOOK_URL`
5. #40 Tailscale vfs `/v1/fs` tree/search/read (in-repo `01-context-store.md` + `02-http-api.md`, **not** frozen GitHub #26/#27)
6. #30 Idempotent Discord `message.reply`
7. #36 Operational Discord webhooks (ops feed only — not @-replies)

## Do not implement

See [`PARKED.md`](PARKED.md). In particular: #10 / #13 / #15 / #19, poll-loop #31 as the consumer contract, fat webhook retrieval, homedir mount, AWS/Fly host, `DISCORD_BOT_TOKEN` on Grok Bot.
