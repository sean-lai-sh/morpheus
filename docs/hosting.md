# Hosting: Mac Mini (Grok Bot is not the host)

**Decided.** Morpheus and the official Discord bot run on a **persistent Mac Mini on Sean's network**. Grok Bot is a **consumer**: it gets a thin Discord job, then **live-searches the Morpheus index** (not the Mini homedir). This replaces AWS, a public cloud VM, Cursor cloud-agent pods, Grok Bot's shared computer as the 24/7 process, and any “put the whole index in the webhook” design.

| Idea | Status |
|---|---|
| AWS / Fly / cloud VM 24/7 | **Stale. Overkill. Do not design for this.** |
| Cursor cloud-agent VM | **Not a host.** Agents edit a repo and **exit**. |
| Grok Bot's shared box | **Not a host.** Shared across assistants; OK for **one-shot** jobs only. |
| Public inbound IP + TLS reverse proxy | **Stale for MVP.** No Fly tunnel. |
| SSHFS / NFS / SMB of `~` | **Forbidden.** Personal Mini projects stay off this share. |
| Mac Mini on Sean's LAN + Tailscale | **Target host.** Always-on Discord gateway + Morpheus index HTTP. |

Slice #0: [#39](https://github.com/sean-lai-sh/morpheus/issues/39). Live index tools: [#40](https://github.com/sean-lai-sh/morpheus/issues/40).

## What runs where

```
 Tech@NYU Discord
        │  Gateway (outbound WebSocket from Mini — official bot, not a self-bot)
        v
 Mac Mini  (Sean's network, tag:morpheus)
   • discord.js bot  (DISCORD_BOT_TOKEN)
   • Morpheus SQLite index (club Discord / docs / leadership notes)
   • no public inbound IP
   • HTTP /v1/fs/* on Tailscale, Morpheus port only
        │  POST GROK_BOT_WEBHOOK_URL  { job, first_pass snippets }
        v
 Grok Bot  (one-shot consumer)
   • if first-pass isn't enough: Tailscale search / read / tree
   • returns { reply } → Mini message.reply as the official bot
   • Mini shows Discord typing in the job channel after webhook 2xx (`DISCORD_TYPING_ON_DISPATCH`, default on)
   • ops-feed FYIs via Discord incoming webhooks (#36 only; not the @-reply)
   • GitHub issues only for implementation work
```

## Transport

**Outbound from Mini (always):**

1. Discord gateway (`wss://…` via discord.js)
2. `GROK_BOT_WEBHOOK_URL` — **thin** job + first-pass snippets, not the whole index
3. Discord incoming webhooks when Mini posts the weekday digest (`MINI_DIGEST_ENABLED`, #76)

**Live index HTTP (Grok pulls more):** Tailscale overlay only.

- Destination: Mini tagged `tag:morpheus`
- Port: Morpheus HTTP (`HEALTH_PORT`) **only**
- Auth: one scoped `MORPHEUS_API_TOKEN_*` per workspace (`workspaces.<id>.token_env` in `channels.yml`, e.g. `_LEADERSHIP`, `_EBOARD`, `_PROGRAMS_DEV`; scope = that workspace plus descendants, from whichever token matched)
- ACL sketch: `tag:grok-bot` → `tag:morpheus` TCP that port. **No SSH.** No other ports.
- Bind `HEALTH_HOST` (zod allowlist: `127.0.0.1`, `::1`, Tailscale `100.64/10` or `fd7a:`). Default `127.0.0.1`. Never `0.0.0.0`, `::`, `::0`, or LAN/WAN unicasts.
- Encrypted by Tailscale; do not publish a public hostname or AWS load balancer.

**Not a filesystem mount.** Paths on `/v1/fs` are **index paths** (channels, threads, leadership notes). They are not `/Users/sean`, `~/src`, or `data/` on disk. Do not design SSHFS/NFS/SMB of the homedir.

## Secrets (never commit)

Documented empty in `.env.example`. Inject via Doppler **on the Mini** or the Grok Bot secret store as listed.

| Name | Lives on | Purpose |
|---|---|---|
| `DISCORD_BOT_TOKEN` | **Mini only** | Official bot token. Legacy alias: `DISCORD_TOKEN`. **Never** on Grok Bot. |
| `DISCORD_GUILD_ID` | Mini | Guild snowflake |
| `GROK_BOT_WEBHOOK_URL` | **Mini** | HTTPS URL of the Grok Bot routine. Thin job POST. |
| `GROK_BOT_WEBHOOK_SECRET` | **Mini** | Sender key. Mini sends `Authorization: Bearer`. Not in the JSON body. Never on Grok as `DISCORD_BOT_TOKEN`. |
| Per-workspace `MORPHEUS_API_TOKEN_*` (`workspaces.<id>.token_env`, e.g. `_LEADERSHIP`, `_EBOARD`, `_PROGRAMS_DEV`) | Mini + Grok (matching scope) | Tailscale `/v1/fs` + optional job complete. Scope = that workspace plus descendants, from whichever token matched. |
| `MORPHEUS_BASE_URL` | **Grok Bot** | Tailnet URL of Mini Morpheus HTTP. Not a public URL. |
| `DISCORD_WEBHOOK_SPONSORS` | **Grok Bot** (+ Mini when digest on) | Incoming webhook for `#sponsors` |
| `DISCORD_WEBHOOK_OPPORTUNITIES` | **Grok Bot** (+ Mini when digest on) | `#opportunities` |
| `DISCORD_WEBHOOK_SPEAKERS` | **Grok Bot** (+ Mini when digest on) | `#speakers` |
| `DISCORD_WEBHOOK_INBOX` | **Grok Bot** (+ Mini when digest on) | proposed `#inbox` |
| `MINI_DIGEST_ENABLED` | **Mini** | Weekday digest (#76). Default `false`. Same Doppler project — not a second env flavor. |

Do not put these in git, in `config/channels.yml`, or in PR text. Do not put `MORPHEUS_BASE_URL` or API tokens in the Discord webhook payload.

Mini Doppler does **not** need `NIA_*`. Nia is unsupported; delete leftover Nia secrets.

## Coordinator (tasks + meetings)

Ported from [techmate](https://github.com/fahimmehraj/techmate) as a Mini-side slice. No Inngest, no planner UI, no Google secrets on the Mini.

- `/task` create is fail-closed on `JOB_TRIGGER_ROLE_IDS` and allowlisted channels. `/meet` create|cancel|seed and mention-booking are **Eboard-only** (snowflakes `1203562091500404782`, plus Leadership `1203562091517321230` and Senior Adv `1322388298634756156`). A member with none of those roles cannot book. `/ask` and `/background` still use `JOB_TRIGGER`.
- Task reminder DMs are sent by the official discord.js bot (Mini holds `DISCORD_BOT_TOKEN`). Grok never gets that token.
- Calendar create/cancel is an outbox row that becomes a `jobs` row POSTed to `GROK_BOT_WEBHOOK_URL`. Grok (hello@) owns Calendar. The job pack is JSON with meeting times, `audience` (`picked` | `f26_roster`), and participant snowflakes — never emails, never the bot token.
- `/meet seed` is a one-shot Grok job (`roster.seed`): Mini sends guild members (id/username/global_name/nick); Grok reads F26 sheet `1NlApvtFAhFTMNafGoVksrYpJhi_oz5dlA6pml5VQ3rw` gid `1079418365` as hello@ and completes `{ mappings, unmatched }`. Mini persists `roster_bindings` (discord_id → email). Seed emails are not logged or POSTed back out. Empty Disc stays unmatched. The slash ack is ephemeral; complete announces with `channel.send` (names/counts only) — do not `message.reply` the ephemeral ack.
- After seed, `/meet` picker and `@mention` attendees resolve by snowflake only. Detect mapped roster roles by snowflake (`<@&1203562091500404782>` / picker value), not the word “eboard”. That role means the F26 Preferred Email dump plus extra @users who already have `roster_bindings`. Unmapped @users are refused — do not invent emails. Not live Discord role expansion.
- Four empty-Disc people (Marc, Zachary, Khidir, Fahim) are upserted into `roster_bindings` on Mini migrate. Cloud agents cannot write the live Mini SQLite — deploy this commit and restart `bun run live` on the host. Do not bind `1379449057474379819` (khidir_41052). Seed announces names/counts only.
- `outbox_events` is written in the same SQLite transaction as the mutation. `bun run live` tries an immediate 1.5s dispatch, then a minute-level in-process sweeper recovers `pending` rows.

## Operator notes (Mini)

- Keep `bun run live` under launchd/`brew services` so a reboot restores the gateway.
- Weekday digest is default OFF. When `MINI_DIGEST_ENABLED=true` and the four `DISCORD_WEBHOOK_*` URLs are in the same Doppler project, cron or launchd can run `doppler run -- bun run digest` on weekday mornings. Unset webhook or empty bucket skips that channel.
- SQLite + `data/` stay on the Mini disk (Time Machine / local backup). Not on Grok Bot's box. **Not** shared as a network filesystem.
- `config/channels.yml` stays on the Mini (gitignored).
- Doppler project `morpheus-bot` on the Mini holds the bot token; Cursor cloud agents should not receive `DISCORD_BOT_TOKEN`.
- Personal Mini projects stay local. The index is club Discord (and later club docs), nothing else.
