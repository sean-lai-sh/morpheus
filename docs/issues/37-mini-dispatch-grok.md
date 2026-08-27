Parent: [#41](https://github.com/sean-lai-sh/morpheus/issues/41) (locked vision). Host: Mac Mini (`docs/hosting.md`). Live tools: [#40](https://github.com/sean-lai-sh/morpheus/issues/40). **Worker: [`42-grok-bot-activation.md`](42-grok-bot-activation.md).**

## Goal

On the **Mac Mini**, after ingest, **POST** a **thin** `{ job, snippets, first_pass: true }` to `GROK_BOT_WEBHOOK_URL`. This is the wakeup, **not** the retrieval API.

Auth: `Authorization: Bearer GROK_BOT_WEBHOOK_SECRET`. Missing URL **or** missing secret skips (warn), does not crash ingest.

That URL must hit a **live Grok Bot** (#42). Dispatch with the env unset is a skip, not an activated consumer.

Grok Bot then **live-searches the Morpheus index** over Tailscale (`/v1/fs/search|read|tree`) if the first-pass pack is not enough. Do **not** grow this POST into a full-index dump.

## Files

- `src/notify/grok-dispatch.ts` (sketched; `first_pass: true`, payload caps)
- Wire from the mention/job path (#29) after a **small** SQLite first-pass
- `.env.example` — `GROK_BOT_WEBHOOK_URL=` and `GROK_BOT_WEBHOOK_SECRET=` empty placeholders on the Mini

## Payload (first-pass only)

```json
{
  "first_pass": true,
  "job": { "id": "...", "content": "...", "namespace": "general" },
  "snippets": [{ "path": "/general/…", "content": "..." }],
  "feed_hint": "sponsors"
}
```

`capGrokPayload` already limits snippet count/bytes. Do not include `DISCORD_BOT_TOKEN`, channel webhook URLs, `MORPHEUS_BASE_URL`, Mini filesystem paths, or the bearer secret in the JSON body.

## After Grok receives it

Grok Bot returns `{ reply }` to Mini (job complete). Mini posts the member-facing answer with discord.js `message.reply` as the official bot (#30).

**Stale:** “Grok posts @-replies via incoming webhooks.” Incoming webhooks are **#36 only** (ops feed: `#sponsors` `#opportunities` `#speakers` / hello@ inbound), not conversational replies. Grok Bot never holds `DISCORD_TOKEN`. GitHub issues remain implementation-only (#31, not the job-delivery contract).

## Acceptance

- [ ] Mini with outbound HTTPS can dispatch
- [ ] Missing `GROK_BOT_WEBHOOK_URL` or `GROK_BOT_WEBHOOK_SECRET` skips (warn), does not crash ingest
- [ ] POST uses `Authorization: Bearer GROK_BOT_WEBHOOK_SECRET`
- [ ] Payload is marked `first_pass` and capped
- [ ] Docs do **not** treat this webhook as “send the whole index”
- [ ] Docs say missing URL = not activated (#42)
- [ ] @-reply path is Mini `message.reply`, not `DISCORD_WEBHOOK_*`
