Parent: [#41](https://github.com/sean-lai-sh/morpheus/issues/41). GitHub issue **#39**. Spec: [`docs/hosting.md`](../hosting.md). Slice #0.

## Goal

Keep Morpheus and the official Discord bot on a **persistent Mac Mini**. No Fly, no AWS, no public hostname, no reverse-proxy TLS slice.

**Transport (decided):**

1. **Outbound (always):** Discord gateway, `POST GROK_BOT_WEBHOOK_URL` (thin job + first-pass snippets), optional Discord incoming webhooks.
2. **Live index HTTP (Grok tools):** Tailscale-only. `tag:morpheus`, **Morpheus HTTP port only**, scoped token. Grok Bot **pulls** search/read/tree over the **index**, not over the Mini homedir.
3. **Not:** public inbound IP, SSH, NFS/SMB/SSHFS of `~`, full-disk share, cloud-agent VM as host.

Cloud agents edit a repo and exit. Grok Bot’s shared box is one-shot. Neither is the 24/7 process.

## Operator checklist (Mini)

- [ ] `doppler run -- bun run live` under launchd / `brew services`
- [ ] Mini is on the tailnet with `tag:morpheus`
- [ ] ACL: only `tag:grok-bot` (or equivalent) → `tag:morpheus` **TCP `HEALTH_PORT`**. No SSH grant.
- [ ] Bind Morpheus HTTP: production `HEALTH_HOST` = Mini Tailscale `100.x`; local smoke = `127.0.0.1`. Never `0.0.0.0`.
- [ ] Doppler on Mini: `DISCORD_BOT_TOKEN`, `GROK_BOT_WEBHOOK_URL`. Grok never gets the bot token.
- [ ] Personal projects under `~` are **not** in the index and **not** shared

## Out of scope

- AWS / Fly / Cloudflare tunnel as the v1 host
- Mounting the Mini filesystem for Grok
- Starting #26 from the frozen GitHub issue body (use in-repo `01-context-store.md`)
