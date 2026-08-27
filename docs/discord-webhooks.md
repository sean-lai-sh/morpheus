# Discord incoming webhooks (operational feed)

Official **channel incoming webhooks** so **Grok Bot** can post workflow updates **without GitHub** (no GitHub MCP, no PAT, no connector). Not a self-bot. Not a replacement for the queryable index.

GitHub issues stay for **implementation work**. These webhooks are the **operational feed**: morning digest, hello@ triage, FYIs.

## Channels (first set)

Each channel is one capture space for **INBOUND** (landing in hello@ or Discord) and **OUTBOUND** (what Tech@NYU might send / follow up).

| Logical key | Discord channel | Typical inbound | Typical outbound |
|---|---|---|---|
| `sponsors` | `#sponsors` | sponsor pitches, partnership asks | follow-ups we might send |
| `opportunities` | `#opportunities` | student / job / fellowship / collab-for-members | opportunities we might forward |
| `speakers` | `#speakers` | speaker / guest / talk asks | invites we might send |
| `inbox` | **`#inbox` (proposed)** | anything that does not match the three | needs a human to re-file |

We had **not** previously proposed a review channel. **`#inbox`** is that bucket. Create it as an eboard-only text channel, or point `DISCORD_WEBHOOK_INBOX` at an existing triage channel. Unknown routing **must not** guess `#sponsors`.

Parameterize by **logical key → webhook URL**, not hardcoded snowflakes in code (`src/notify/channels.ts`).

## Create a webhook (Discord UI)

1. Open the Tech@NYU server → the target channel (`#sponsors`, etc.).
2. Edit channel → **Integrations** → **Webhooks** → **New Webhook** (or Server Settings → Integrations → Webhooks, then set the channel).
3. Name it e.g. `Grok feed` (this is the display name of posts, not the bot user).
4. Copy the URL. It looks like `https://discord.com/api/webhooks/{id}/{token}`. **The token is a secret.**
5. Store it in the **Grok Bot** secret store as `DISCORD_WEBHOOK_SPONSORS` (etc.). Never commit it. The Mac Mini does **not** need these URLs for the primary loop (Grok posts the feed). `.gitignore` already covers `.env`.

Repeat once per logical key. Rotate by deleting the webhook in Discord and issuing a new URL.

Bot permissions (Send Messages) are **not** required for incoming webhooks; the webhook is bound to the channel when created. The official bot token remains for gateway ingest + mention replies only.

## Where the URL is read

Empty placeholders in `.env.example`:

- `DISCORD_WEBHOOK_SPONSORS`
- `DISCORD_WEBHOOK_OPPORTUNITIES`
- `DISCORD_WEBHOOK_SPEAKERS`
- `DISCORD_WEBHOOK_INBOX`

**Grok Bot (required for FYIs):** holds `DISCORD_WEBHOOK_*` and `POST`s JSON to Discord. No GitHub. Mini does not need a public inbound IP.

**Mac Mini:** holds `DISCORD_BOT_TOKEN` + `GROK_BOT_WEBHOOK_URL`. It does not need channel webhook URLs unless you want Mini-originated digests.

Do **not** put webhook URLs in `config/channels.yml` (that file is channel snowflakes for ingest, and is easy to commit by mistake).

## Routing sketch

`routeFeedChannel(kind)` in `src/notify/route.ts`:

| `kind` (or free-text haystack) | Channel |
|---|---|
| `sponsor`, `partnership`, `pitch`, `collab` | `sponsors` |
| `student`, `job`, `internship`, `fellowship`, `opportunity` | `opportunities` |
| `speaker`, `guest`, `keynote`, `talk` | `speakers` |
| anything else, including `unknown` | `inbox` |

Direction is orthogonal: `inbound` | `outbound`. Both go to the **same** channel; the message header labels INBOUND vs OUTBOUND.

Time-sensitive hello@ vs morning digest: **same webhooks**. Prefix `URGENT` vs `DIGEST` in the payload (`urgency` field). Do not invent extra channels for that.

## When to use webhook vs GitHub vs bot reply

| Surface | Use |
|---|---|
| Channel webhook (`#sponsors` / …) | Operational FYI, digest, hello@ routing. **No GitHub connector.** |
| GitHub issue | Implementation work (code, Morpheus slices, club repo tasks). |
| Official bot `message.reply` | Reply in the thread/channel where someone @mentioned the bot (#30). Webhooks cannot act as the bot user in a reply chain. |

## Payload rules (untrusted text)

- Cap content at 2000 characters (Discord limit); truncate with a marker.
- `allowed_mentions: { parse: [], users: [], roles: [] }` so hello@ bodies cannot `@everyone` or ping roles/users.
- Never send `DISCORD_BOT_TOKEN`, `GROK_BOT_WEBHOOK_URL`, or channel webhook URLs in the message body.

## Code in this PR

- `src/notify/channels.ts` — logical keys + env var names
- `src/notify/route.ts` — kind → channel
- `src/notify/webhooks.ts` — POST to Discord incoming webhook
- `scripts/post-feed.ts` — `bun run post-feed -- --channel=sponsors --direction=inbound --kind=sponsor --text='...'`
- `tests/notify-route.test.ts`, `tests/notify-webhooks.test.ts`

This is an **output surface**. It does not index Discord, does not replace FTS/`/v1`, and does not talk to Nia.
