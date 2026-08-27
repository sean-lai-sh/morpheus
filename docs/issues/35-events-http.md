## Goal

Once the events table from #7 / PR #23 is on main, expose it over the **same authenticated HTTP** as messages so **Grok Bot** can read/update club events without an in-process Pi tool and without slash commands as the first entry point.

This **replaces** implementing #17 / #18 as `pi-agent-core` tools.

## Why this waits

Do not start until:

- PR #23 **events half** is merged (or cherry-picked) — `src/storage/events.ts` exists on main
- #27 HTTP `/v1` + bearer auth exists

Sandbox/docker from PR #23 is **not** a dependency.

## Routes (Bearer `MORPHEUS_API_TOKEN`)

```
GET  /v1/events?name=&date=     → findEvents
GET  /v1/events/:id
POST /v1/events                 → upsert insert; source_type=grok_bot; is_manual=1
PATCH /v1/events/:id            → body includes expectedVersion; source_type=grok_bot
```

Namespace: if `channel_id` is set, reject writes from a job whose namespace cannot see that channel (leadership-only events must not be patched from a general job).

`source_type=backfill_parser` is **not** callable over HTTP (parser stays internal).

## Out of scope

- Pi `defineTool` wrappers (#17, #18)
- `/event-status` slash command (#21)
- Fuzzy matcher can live in Grok Bot's prompt + multiple GET calls; optional later port of #17's scoring into the server

## Acceptance

- [ ] Grok Bot can list/get events with the same token as `/v1/search`
- [ ] Version conflict returns 409 JSON, not a 500
- [ ] Manual-lock parser semantics unchanged
- [ ] No `DISCORD_TOKEN` or Nia env required for these routes

## Dependencies

#7 merged, #27 HTTP auth.
