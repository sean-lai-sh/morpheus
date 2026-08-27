## Goal

Once the events table from #7 / PR #23 is on main, expose it over **localhost HTTP on the Mac Mini** (same `/v1` as #27). On-box tools only — Grok does not poll this over the internet. Event context for Grok can ride in the Mini→`GROK_BOT_WEBHOOK_URL` POST (#37).

This **replaces** implementing #17 / #18 as `pi-agent-core` tools. Do **not** host this API on AWS, Cursor VMs, or Grok Bot’s shared computer.

## `source_type=grok_bot` vs PR #23 `EVENT_SOURCE_TYPES`

PR #23 originally allowed only `backfill_parser` | `agent_update` | `slash_command` | `manual_seed`. A follow-up commit on that branch (`177279e`, “feat: grok_bot event source_type…”) **adds** `grok_bot` to `EVENT_SOURCE_TYPES` in `src/storage/events.ts`. The storage layer **rejects** unknown `source_type` values.

**Explicit dependency:** merge (or cherry-pick) the PR #23 events half **including** `grok_bot` in the enum, with a test that `source_type: "grok_bot"` upserts and an unknown string throws. If an older tip of #23 lands without that commit, add `grok_bot` in this slice **before** any HTTP handler writes it.

HTTP writes use `source_type=grok_bot` and `is_manual=1`. `source_type=backfill_parser` is **not** callable over HTTP.

## Auth (same as #27)

Namespace is **not** a client field. Scoped tokens; derive namespace server-side. If `channel_id` is set on an event, reject writes when the token’s namespace cannot see that channel (leadership events must not be patched with a general token). Negative cross-scope test required.

## Why this waits

- PR #23 **events half** merged, with `grok_bot` in `EVENT_SOURCE_TYPES`
- #27 scoped HTTP auth exists

Sandbox/docker from PR #23 is **not** a dependency.

## Routes (Bearer scoped token)

```
GET  /v1/events?name=&date=     → findEvents (token namespace)
GET  /v1/events/:id
POST /v1/events                 → upsert insert; source_type=grok_bot; is_manual=1
PATCH /v1/events/:id            → body includes expectedVersion; source_type=grok_bot
```

## Out of scope

- Pi `defineTool` wrappers (#17, #18)
- `/event-status` slash command (#21)

## Acceptance

- [ ] `grok_bot` is in `EVENT_SOURCE_TYPES` (from PR #23 `177279e` or added here) and tested
- [ ] General token cannot PATCH a leadership-scoped event
- [ ] On-box `/v1/events` (localhost Mini) can list/get
- [ ] Version conflict returns 409 JSON, not a 500
- [ ] No `DISCORD_BOT_TOKEN` or Nia env required for these routes

## Dependencies

#7 / PR #23 events + `grok_bot` enum, #27 scoped HTTP auth.
