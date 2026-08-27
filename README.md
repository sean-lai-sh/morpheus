# Morpheus

Discord intelligence bot for the club's eboard. Ingests allowlisted channels into SQLite and renders local markdown. Retrieval is SQLite on the Mac Mini (FTS / `/v1/fs` in later slices) — **not Nia**. Mini runs with **zero `NIA_*` secrets**.

**Direction (2026-08):** **Host = Mac Mini.** **Grok Bot = consumer** with **live index search** over Tailscale (tree/grep/cat), not a Mini homedir mount. Thin Discord job POST + first-pass snippets; pull more via `/v1/fs`. See [docs/hosting.md](docs/hosting.md). **PR #24 does not implement jobs, FTS, `/v1/fs`, or mention replies** — those are later slices. Locked vision: [#41](https://github.com/sean-lai-sh/morpheus/issues/41).

- Plan: [docs/context-layer.md](docs/context-layer.md) · hosting: [docs/hosting.md](docs/hosting.md) · webhooks: [docs/discord-webhooks.md](docs/discord-webhooks.md)
- **Locked vision: [#41](https://github.com/sean-lai-sh/morpheus/issues/41)** · Issue/PR audit: [docs/grok-bot-audit.md](docs/grok-bot-audit.md)
- Grok Bot spec: [#33](https://github.com/sean-lai-sh/morpheus/issues/33) · activation: [docs/issues/42-grok-bot-activation.md](docs/issues/42-grok-bot-activation.md) · live index: [#40](https://github.com/sean-lai-sh/morpheus/issues/40) · Mini host: [#39](https://github.com/sean-lai-sh/morpheus/issues/39)
- Parked agent-v1: [docs/issues/PARKED.md](docs/issues/PARKED.md) · owner close: [#38](https://github.com/sean-lai-sh/morpheus/issues/38)
- Slices: [#32](https://github.com/sean-lai-sh/morpheus/issues/32) · Nia removed in this PR · #39 host → FTS → jobs → first-pass POST → **activate Grok Bot** → Tailscale `/v1/fs` → webhooks → GitHub optional

## Local markdown export

SQLite is the source of truth. Markdown under `data/discord/{general,leadership}/` is a local render (`isolated: true` → leadership namespace). It is **not** pushed to Nia.

### File structure

```
data/discord/
  general/
    {category}/
      {channel-name}-{last4id}/
        main.md          ← non-thread messages
        threads/
          {thread-name}-{last4id}.md   ← one file per thread
  leadership/
    eboard-teams/
      leadership-team-{id}/
        main.md
        threads/
          ...
```

Each thread file header includes `starter_message_id` (the message that spawned the thread — Discord guarantees `thread.id === starter_message.id`) and `parent_channel_id` so provenance is always recoverable.

### Channel config (`config/channels.yml`)

```yaml
guild_id: "your-guild-id"
channels:
  - id: "channel-snowflake"
    name: "channel-name"
    category: "eboard-teams"   # maps to directory prefix under general/ or leadership/
    include_threads: true
    isolated: false            # set true on leadership-team to route to leadership namespace
```

`category` is optional — channels without it resolve directly under the namespace root.

## Quickstart

### 1. Install dependencies

```bash
bun install
```

### 2. Doppler (Mini only)

```bash
doppler login
doppler setup --project morpheus-bot --config dev

doppler secrets set DISCORD_BOT_TOKEN=...
doppler secrets set DISCORD_GUILD_ID=...
doppler secrets set GROK_BOT_WEBHOOK_URL=...
doppler secrets set LOG_LEVEL=info HEALTH_PORT=8080
```

Do **not** set `NIA_*`. Delete them from Doppler if they still exist.

Grok Bot (not Mini) holds `DISCORD_WEBHOOK_SPONSORS` / `_OPPORTUNITIES` / `_SPEAKERS` / `_INBOX`. Never commit any of these.

Run Morpheus on the **Mac Mini** (`docs/hosting.md`). Do not run `bun run live` on AWS, Cursor cloud agents, or Grok Bot's shared computer.

`bun run live` / `bun run backfill` wrap `doppler run --` (Mini). **Doppler-free** (CI / cloud VM, env already in the process):

```bash
bun src/index.ts live
```

`bun.lock` is tracked so `bun install --frozen-lockfile` does not float.

### 3. Discord bot

1. Create an app at <https://discord.com/developers/applications> → Bot tab
2. Enable privileged intents: `Message Content`, `Server Members`
3. Copy token to Doppler as `DISCORD_BOT_TOKEN`
4. OAuth2 scopes: `bot` + `applications.commands`, permissions: `View Channels` + `Read Message History`. **For mention replies (#30) also grant Send Messages and Send Messages in Threads.**
5. Invite to the guild and restrict to the desired channels at the channel-permission level
6. Set `JOB_TRIGGER_ROLE_IDS` (eboard role snowflakes). Empty list fail-closes enqueue. Mentions (`@bot` / reply-to-bot) and `/ask` enqueue the same SQLite `jobs` table; Mini POSTs a thin first-pass pack to `GROK_BOT_WEBHOOK_URL`. Replies post via `message.reply` as this bot — Grok never holds `DISCORD_BOT_TOKEN`.

### 4. Configure channels

```bash
cp config/channels.example.yml config/channels.yml
```

Edit `config/channels.yml` — set `guild_id` and replace placeholder IDs with real Discord snowflakes (right-click any channel → Copy Channel ID with Developer Mode on).

### 5. Initial backfill

```bash
bun run backfill          # paginate all allowed channels back to creation
bun run refresh-members   # populate display names for historical messages
```

## Commands

```bash
bun run backfill          # one-shot: full channel history + threads
bun run refresh-members   # one-shot: bulk-populate display names from guild members
bun run dev               # long-running: live event subscriber
bun run reconcile         # one-shot: diff last N messages per channel against SQLite
bun run reindex           # rebuild markdown from SQLite (recovery path)
bun run typecheck         # tsc --noEmit
bun test                  # run test suite
bun run test:watch        # re-run tests on file change
```

## Tests

The suite in `tests/` covers storage (messages, users, links, crawl-state, export dirty flags), markdown hierarchy and thread routing, config validation, classifier prompt building, and ingest logic. Each file uses a fresh temp SQLite DB.

CI runs `bun install --frozen-lockfile`, `bunx tsc --noEmit`, and `bun test` on every push — see `.github/workflows/ci.yml`. No Doppler. No `DISCORD_TOKEN`. No `NIA_*`. `backupDb()` follows `MORPHEUS_DB_PATH` (tests cover this).
