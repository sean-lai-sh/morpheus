Parent: #33. Host: Mac Mini (`docs/hosting.md`).

## Goal

On the **Mac Mini**, after ingest/context, **POST** `{ job, snippets }` to `GROK_BOT_WEBHOOK_URL`. Mini connects **out**. No public inbound IP. Grok Bot is a one-shot consumer, not the host.

Do **not** have Grok Bot poll Mini `/v1` over the internet. Do **not** run `bun run live` on Cursor cloud-agent VMs or Grok Bot's shared computer.

## Files

- `src/notify/grok-dispatch.ts` (already sketched)
- Wire from the mention/job path (#29) after snippets are gathered from SQLite
- `.env.example` — `GROK_BOT_WEBHOOK_URL=` empty placeholder on the Mini

## Payload (sketch)

```json
{
  "job": { "id": "...", "content": "...", "namespace": "general" },
  "snippets": [{ "content": "..." }],
  "feed_hint": "sponsors"
}
```

Cap snippet count and bytes (`capGrokPayload` in `src/notify/grok-dispatch.ts`). Do not include `DISCORD_BOT_TOKEN` or channel webhook URLs in the payload.

## After Grok receives it

Grok Bot posts to Discord **incoming** webhooks (`docs/discord-webhooks.md`). GitHub issues only for implementation work.

## Acceptance

- [ ] Mini with only outbound HTTPS can dispatch
- [ ] Missing `GROK_BOT_WEBHOOK_URL` skips (warn), does not crash ingest
- [ ] Unit test with mocked POST
- [ ] Docs say AWS / cloud-agent host is stale
