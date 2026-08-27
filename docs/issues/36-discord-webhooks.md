Parent: #25 / #33. GitHub issue **#36**. Parallel with #29–#31. Does **not** replace FTS/`/v1`.

## Goal

Official **Discord incoming webhooks** so Grok Bot can post operational updates **without a GitHub connector**.

Channels (parameterized logical keys → env URLs):

- `#sponsors` — inbound pitches/partnerships + outbound follow-ups
- `#opportunities` — inbound student/job/fellowship + outbound we might forward
- `#speakers` — inbound guest/talk asks + outbound invites
- **`#inbox` (proposed)** — unknown routing. We did not previously have a review channel; do not dump unknown into `#sponsors`.

## Why

Filing a GitHub issue for every hello@ FYI is too much. Morning digest + time-sensitive mail go to the matching Discord channel. GitHub issues remain for **implementation** work.

## Implement

Already sketched in this repo (`src/notify/*`, `docs/discord-webhooks.md`, `bun run post-feed`):

1. Store URLs in Doppler / Grok Bot secrets: `DISCORD_WEBHOOK_SPONSORS`, `_OPPORTUNITIES`, `_SPEAKERS`, `_INBOX`. Never commit.
2. Grok Bot POSTs JSON to the webhook (`allowed_mentions.parse = []`, 2000 cap). No GitHub MCP.
3. Operators create webhooks in Discord: channel → Integrations → Webhooks (see the doc).
4. `routeFeedChannel` / `routeFeedFromText` for kind → channel.

Optional later: Morpheus-originated digests using the same module on the persistent host.

## Out of scope

- Self-bot / user token
- Using webhooks as the search index
- Replacing mention replies (#30) — those still use the official bot user
- Assuming `gh` is installed

## Acceptance

- [ ] Docs tell an eboard member how to create the four webhooks and which env var to paste into
- [ ] Unknown kinds land in inbox, not a named feed
- [ ] Unit tests cover routing + skip-if-unset + allowed_mentions
- [ ] No webhook URL in git
