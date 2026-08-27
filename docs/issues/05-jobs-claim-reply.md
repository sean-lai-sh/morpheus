Parent: #25. Depends on #29. Host: Mac Mini. Official bot posts replies. Jobs go **out** via `GROK_BOT_WEBHOOK_URL` (#37); Grok is activated by that POST (#42). Product vision: [#41](https://github.com/sean-lai-sh/morpheus/issues/41).

## Goal

Official bot **replies** when a job completes (`message.reply`). Grok Bot does **not** poll these routes over the public internet. If `/v1/jobs` exists for complete/fail, it binds the **Tailscale** address (`tag:morpheus`, Morpheus port only) with **scoped** tokens (#27). Grok never receives `DISCORD_BOT_TOKEN`.

## Bind claims to worker identity

`claimed_by` match is **mandatory**, not optional.

- `claim`: CAS `queued` → `claimed` with `claimed_by` = authenticated worker id (from the scoped token / a `claimed_by` header that must match a configured worker name for that token). Second worker with a different identity → **409**.
- `complete` / `fail`: job must be `claimed` **and** `claimed_by` must equal the caller. Otherwise **409**. A shared “complete anyone’s job” token is not allowed.
- Scoped tokens: a **general** token cannot claim or complete a **leadership** job (namespace taken from the **job row**, never from a query param). Negative test required.

## Idempotent complete (no duplicate Discord replies)

Decide this here (do not leave a coin-flip):

1. Persist `reply_text` + `completion_key` (or existing `result_discord_message_id`) in the same transaction **before** calling Discord.
2. Post via discord.js. If Discord already accepted a send, retry **must not** post again (lookup `result_discord_message_id` / `completion_key`).
3. If the job is already `completed`, return the stored `result_discord_message_id` and **do not** re-post (**200** idempotent).
4. If Discord send fails **before** any message id exists, leave status `claimed` with `error` set (so the same worker can retry). Do **not** `fail` the job solely because Discord 5xx’d — that would invite a second worker after lease expiry to post a first reply while the first worker also retries.
5. Lease sweeper may return expired `claimed` jobs to `queued` **only if** `result_discord_message_id` is null **and** `completion_key` is null. If a send is in flight / recorded, do not requeue.

## Discord send

```ts
message.reply({
  content, // capped at 2000; split remainder into follow-ups
  allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
});
```

That is the mention defense. **Do not** use a substring scan for `@everyone` / `@here` (misses `<@&roleId>` / lookalikes). **Do not** exempt leadership — that is where you least want a ping.

Needs **Send Messages** and **Send Messages in Threads** (thread-origin jobs). Add both to README / Developer Portal checklist. Incoming webhooks are a different surface (`docs/discord-webhooks.md`).

Cap `reply` at 2000 chars per message (Discord). Cap `github_issue_url` to a URL on the allowlisted repo (#31) or reject.

## Routes (Tailscale; namespace from token + job row)

```
GET  /v1/jobs?status=queued     → list in the *token’s* namespace only (no ?namespace=)
POST /v1/jobs/:id/claim         → body { claimed_by }; CAS; 409 if not queued or wrong scope
POST /v1/jobs/:id/complete      → body { reply, github_issue_url? }
POST /v1/jobs/:id/fail          → body { error }
```

## Files

- `src/storage/jobs.ts` — `claimJob`, `completeJob`, `failJob`, `requeueExpiredClaims`.
- `src/http/jobs.ts` — scoped auth from #27.
- `src/bot/reply.ts` — `postJobReply` with `allowedMentions` as above.
- Tests: CAS, idempotent complete, cross-scope 409, expired claim without duplicate send.

## Security

- Same scoped bearers as #27. Do not add `DISCORD_BOT_TOKEN` to Grok.
- `reply` is untrusted agent text: Discord markdown, no eval.
- Never echo `DISCORD_BOT_TOKEN`, webhook URLs, or API tokens in payloads or logs.
- Outstanding-job caps live on enqueue (#29).

## Out of scope

- Opening GitHub issues (URL field only; posting is #31 and must fail open).
- In-process LLM / #10.
- Slash commands.

## Acceptance criteria

- [ ] Two claims → one 200, one 409.
- [ ] Complete with wrong `claimed_by` → 409.
- [ ] Complete on already-completed job → no second Discord post.
- [ ] General token cannot complete a leadership job.
- [ ] `postJobReply` uses `allowedMentions.parse === []` (and empty users/roles).
- [ ] Thread jobs documented as needing **Send Messages in Threads**.
- [ ] Unauthenticated `/v1/jobs` → 401.

## Dependencies

- #29 jobs enqueue.
- #27 scoped HTTP auth if routes are served (Tailscale bind, not a public NIC).
- #42 Grok Bot actually running at `GROK_BOT_WEBHOOK_URL`.
