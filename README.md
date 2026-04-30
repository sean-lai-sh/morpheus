# Morpheus

Discord intelligence bot for the club's eboard. Ingests messages into SQLite, renders them as structured markdown, and syncs to Nia for semantic search.

## How Nia indexing works

Morpheus maintains two independent Nia filesystem namespaces:

| Namespace | Env var | Content |
|-----------|---------|---------|
| General | `NIA_DISCORD_SOURCE_ID` | All channels except `#leadership-team` |
| Leadership | `NIA_DISCORD_LEADERSHIP_SOURCE_ID` | `#leadership-team` only (isolated) |

Files are written to `data/discord/general/` and `data/discord/leadership/` and pushed to Nia on a 60-second dirty-flag poll.

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

### 2. Doppler

```bash
doppler login
doppler setup --project morpheus-bot --config dev

doppler secrets set DISCORD_TOKEN=...
doppler secrets set DISCORD_GUILD_ID=...
doppler secrets set NVIDIA_API_KEY=...
doppler secrets set NIA_API_KEY=...
doppler secrets set NIA_BASE_URL=https://apigcp.trynia.ai/v2
doppler secrets set LOG_LEVEL=info HEALTH_PORT=8080
```

### 3. Discord bot

1. Create an app at <https://discord.com/developers/applications> → Bot tab
2. Enable privileged intents: `Message Content`, `Server Members`
3. Copy token to Doppler as `DISCORD_TOKEN`
4. OAuth2 scopes: `bot` + `applications.commands`, permissions: `View Channels` + `Read Message History`
5. Invite to the guild and restrict to the desired channels at the channel-permission level

### 4. Configure channels

```bash
cp config/channels.example.yml config/channels.yml
```

Edit `config/channels.yml` — set `guild_id` and replace placeholder IDs with real Discord snowflakes (right-click any channel → Copy Channel ID with Developer Mode on).

### 5. Register Nia namespaces

```bash
bun run register-nia
```

Creates both Nia filesystem namespaces and writes `NIA_DISCORD_SOURCE_ID` and `NIA_DISCORD_LEADERSHIP_SOURCE_ID` to Doppler. Pass `--force` to recreate (clean slate migration).

### 6. Initial backfill

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
bun run register-nia      # one-shot: create/recreate Nia namespaces, store IDs in Doppler
bun run typecheck         # tsc --noEmit
bun test                  # run test suite
bun run test:watch        # re-run tests on file change
```

## Tests

The suite in `tests/` covers storage (messages, users, links, crawl-state, sync-state), markdown hierarchy and thread routing, config validation, classifier prompt building, and ingest logic. Each file uses a fresh temp SQLite DB.

CI runs `bunx tsc --noEmit` and `bun test` on every push — see `.github/workflows/ci.yml`.
