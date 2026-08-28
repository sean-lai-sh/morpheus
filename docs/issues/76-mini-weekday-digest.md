Parent: #36 (and #41 ops-feed pointer). GitHub issue **#76**. Does **not** replace FTS/`/v1` or mention replies (#30).

Canonical: [https://github.com/sean-lai-sh/morpheus/issues/76](https://github.com/sean-lai-sh/morpheus/issues/76).

## Goal

Mini weekday digest from the Morpheus index, posted to the existing digest channels via `src/notify` `postFeed`. Content is **classified index hits** (sponsor / opportunity / speaker), not a dump of those channels back onto themselves, and not Gmail hello@ (that's Grok Bot / #42).

## Channels

- `#sponsors` — pitches / partnerships
- `#opportunities` — student / job / fellowship
- `#speakers` — guest / talk
- `#inbox` — unknown — **never guess a named feed**

## Implement

- Query the index (existing FTS/search) for recent **eboard-visible** hits (not leadership)
- Bucket / compose with `routeFeedFromText` / `composeDigestPosts` / `stripPingableMentions`
- Post **DIGEST** (`urgency: digest`) via `postFeed`
- Skip channel if webhook unset
- Skip empty bucket
- Idempotent per calendar day + channel
- Default **OFF** (`MINI_DIGEST_ENABLED`)
- `bun run digest` to run once
- No tokens / webhook URLs in logs or bodies

Same Doppler project/config on Mini. Not a second env flavor. Not a self-bot.

## Out of scope

- Draft PR #49
- Closing #41 or #47
- hello@ ingestion
- Changing workspace isolation
- Using webhooks as the search index
