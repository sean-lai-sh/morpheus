# Hosting: Mac Mini (Grok Bot is not the host)

**Decided.** Morpheus and the official Discord bot run on a **persistent Mac Mini on Sean's network**. Grok Bot is a **consumer** that receives jobs over an **outbound webhook**. This replaces any earlier implication of AWS, a public cloud VM, Cursor cloud-agent pods, or Grok Bot's shared computer as the 24/7 process.

| Idea | Status |
|---|---|
| AWS / cloud VM 24/7 | **Stale. Overkill. Do not design for this.** |
| Cursor cloud-agent VM | **Not a host.** Agents edit a repo and **exit**. |
| Grok Bot's shared box | **Not a host.** Shared across assistants; OK for **one-shot** jobs only. |
| Mac Mini on Sean's LAN | **Target host.** Always-on Discord gateway + Morpheus indexer/query. |

## What runs where

```
 Tech@NYU Discord
        │  Gateway (outbound WebSocket from Mini — official bot, not a self-bot)
        v
 Mac Mini  (Sean's network)
   • discord.js bot  (DISCORD_BOT_TOKEN)
   • Morpheus SQLite ingest + context
   • no public inbound IP required
        │  POST GROK_BOT_WEBHOOK_URL  (job + snippets)  — Mini connects OUT
        v
 Grok Bot  (one-shot routine / shared box / Cursor agent)
   • not 24/7, does not hold the bot token
   • posts FYIs to Discord incoming webhooks
     (#sponsors, #opportunities, #speakers, #inbox)
   • GitHub issues only for implementation work
```

Mini **outbound** destinations only:

1. Discord gateway (`wss://…` via discord.js)
2. `GROK_BOT_WEBHOOK_URL` (job dispatch)
3. Optional: Discord incoming webhooks if Mini itself posts a digest

Mini does **not** need a public inbound IP, port-forward, or AWS load balancer for this loop. Grok Bot does **not** poll Mini `/v1` over the internet (that would require inbound). Context rides in the POST body. `/v1` on Mini, if built, binds to **localhost** for on-box tools only.

## Secrets (never commit)

Documented empty in `.env.example`. Inject via Doppler **on the Mini** or the Grok Bot secret store as listed.

| Name | Lives on | Purpose |
|---|---|---|
| `DISCORD_BOT_TOKEN` | **Mini only** | Official bot token (Developer Portal → Bot). Code also accepts legacy `DISCORD_TOKEN`. **Never** on Grok Bot. |
| `DISCORD_GUILD_ID` | Mini | Guild snowflake |
| `GROK_BOT_WEBHOOK_URL` | **Mini** | HTTPS URL of the Grok Bot routine. Mini POSTs `{ job, snippets }`. |
| `MORPHEUS_API_TOKEN_GENERAL` / `_LEADERSHIP` | Mini localhost `/v1` | Namespace from which secret matched. Not a shared token. |
| `DISCORD_WEBHOOK_SPONSORS` | **Grok Bot** | Incoming webhook for `#sponsors` |
| `DISCORD_WEBHOOK_OPPORTUNITIES` | **Grok Bot** | `#opportunities` |
| `DISCORD_WEBHOOK_SPEAKERS` | **Grok Bot** | `#speakers` |
| `DISCORD_WEBHOOK_INBOX` | **Grok Bot** | proposed `#inbox` |

Do not put these in git, in `config/channels.yml`, or in PR text.

`NIA_*` stay Mini/Doppler until Nia is deleted; they are not Grok Bot secrets.

## Operator notes (Mini)

- Keep `bun run live` under launchd/`brew services` so a reboot restores the gateway.
- SQLite + `data/` stay on the Mini disk (Time Machine / local backup). Not on Grok Bot's box.
- `config/channels.yml` stays on the Mini (gitignored).
- Doppler project `morpheus-bot` on the Mini is enough; Cursor cloud agents should not receive `DISCORD_BOT_TOKEN`.
- `/health` and optional `/v1` bind to **127.0.0.1** (`HEALTH_PORT`). They are not advertised on the LAN or the internet.
