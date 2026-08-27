# Morpheus

**Locked vision: [GitHub issue #41](https://github.com/sean-lai-sh/morpheus/issues/41).** Implement that. Do **not** implement May 2026 `agent-v1` issues, frozen GitHub **#26 / #31 / #33** bodies, Nia, Pi, or poll-loop “Grok polls `/v1/jobs`”.

Discord intelligence bot for the club's eboard. Ingests allowlisted channels into SQLite and renders local markdown. **Host = Mac Mini** (outbound-only). **Grok Bot = consumer.** Thin Discord job POST + first-pass snippets; Grok live-searches the Morpheus index over Tailscale (`/v1/fs` tree/grep/cat). Mini `message.reply`s as the official bot. Incoming webhooks are the [#36](https://github.com/sean-lai-sh/morpheus/issues/36) ops feed only.

Nia is **gone** (PR [#24](https://github.com/sean-lai-sh/morpheus/pull/24), `074022f` on `main`). `src/nia/` was deleted. Mini runs with **zero `NIA_*` secrets**. Do not restore Nia.

Jobs / VFS are later slices — see open PRs #43 / #44. This tree on `main` does not implement them. Do not merge those PRs from a docs cleanup.

- Vision + live slices: [#41](https://github.com/sean-lai-sh/morpheus/issues/41) · [#39](https://github.com/sean-lai-sh/morpheus/issues/39) Mini host · [#29](https://github.com/sean-lai-sh/morpheus/issues/29) enqueue · [#37](https://github.com/sean-lai-sh/morpheus/issues/37) Mini POST · [#42](https://github.com/sean-lai-sh/morpheus/issues/42) Grok worker · [#40](https://github.com/sean-lai-sh/morpheus/issues/40) live index · [#36](https://github.com/sean-lai-sh/morpheus/issues/36) ops webhooks · [#30](https://github.com/sean-lai-sh/morpheus/issues/30) official-bot reply
- Hosting: [docs/hosting.md](docs/hosting.md) · plan: [docs/context-layer.md](docs/context-layer.md) · webhooks: [docs/discord-webhooks.md](docs/discord-webhooks.md)
- Stale GitHub issues (do not implement): [docs/issues/PARKED.md](docs/issues/PARKED.md). Owner close paste: [docs/issues/38-owner-close-stale.md](docs/issues/38-owner-close-stale.md)

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
doppler secrets set GROK_BOT_WEBHOOK_SECRET=...
doppler secrets set LOG_LEVEL=info HEALTH_PORT=8080
```

Do **not** set `NIA_*`. They were removed in PR #24.

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
