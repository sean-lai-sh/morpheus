# Morpheus

Discord intelligence bot for the club's eboard. Part 1: authenticated crawler that ingests allowed channels into a Nia `local_folder` source for retrieval. Part 2 (separate work) layers an agentic interface on top.

See `/Users/sean_lai/.claude/plans/serialized-tickling-scott.md` for the full design.

## Stack

- **Runtime**: Bun (TypeScript native)
- **Discord client**: discord.js v14
- **Storage**: SQLite via `bun:sqlite` (source of truth) + append-only markdown (Nia-facing render)
- **Classifier**: NVIDIA NIM free tier (`nvidia/llama-3.1-nemotron-ultra-253b-v1`), batched + rate-limited
- **Retrieval**: Nia `local_folder` source, debounced re-sync via `POST /v1/sources/{id}/sync`
- **Secrets**: Doppler (no committed `.env`)

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Doppler

```bash
# One-time per machine
doppler login

# One-time per project
doppler projects create morpheus-bot
doppler configs create dev  --project morpheus-bot
doppler configs create prod --project morpheus-bot
doppler setup --project morpheus-bot --config dev

# Set secrets (see .env.example for the full list)
doppler secrets set DISCORD_TOKEN=...        --config dev
doppler secrets set DISCORD_GUILD_ID=...     --config dev
doppler secrets set NVIDIA_API_KEY=...       --config dev
doppler secrets set NIA_API_KEY=...          --config dev
doppler secrets set NIA_BASE_URL=https://api.trynia.ai --config dev
doppler secrets set LOG_LEVEL=info HEALTH_PORT=8080 --config dev
```

### 3. Discord bot

1. https://discord.com/developers/applications → new app → Bot tab
2. Enable privileged intents: `Message Content`, `Server Members`
3. Reset token, copy to Doppler as `DISCORD_TOKEN`
4. OAuth2 URL Generator → scopes `bot` + `applications.commands`, perms `View Channels` + `Read Message History`
5. Invite to the guild and restrict to the desired channels at the channel-permission level

### 4. Channel allowlist

Edit `config/channels.yml`. Replace `guild_id` and the example channel IDs with real values.

## Commands

All entrypoints are pre-wrapped with `doppler run --` so secrets come in via env vars.

```bash
bun run backfill        # one-shot: paginate all allowed channels back to creation
bun run dev             # start live event subscriber (long-running)
bun run reconcile       # one-shot: refetch last N messages per channel and diff against SQLite
bun run reindex         # rebuild markdown from SQLite (recovery)
bun run register-nia    # one-shot: create Nia local_folder source, store UUID in Doppler
bun run rotate          # archive markdown older than RETENTION_MONTHS (no-op if blank)
bun run typecheck       # tsc --noEmit
```

## Verification (smoke test)

See the plan at `/Users/sean_lai/.claude/plans/serialized-tickling-scott.md` → **Verification** section.
