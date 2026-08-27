Parent: #25. Depends on #29 and #27.

## Goal

Let an external Cursor/Grok agent **claim** queued Discord jobs, do work using `/v1/search` etc., then **complete** them. Completing posts a **Discord reply from the official bot process**. The agent never receives `DISCORD_TOKEN`.

Depends on: jobs enqueue issue + HTTP v1 issue.

## Files to create / modify

- `src/storage/jobs.ts` — `claimJob(id, claimedBy, leaseMs)`, `completeJob`, `failJob`, `requeueExpiredClaims`.
- `src/http/jobs.ts` (new) — routes mounted on the existing server.
- `src/bot/reply.ts` (new) — `postJobReply(client, job, content)` using discord.js `message.reply` or channel send; split at 2000 chars.
- `src/crawler/live.ts` or `src/index.ts` — interval (e.g. 30s) to requeue expired claims.
- `tests/jobs-claim.test.ts`, `tests/http-jobs.test.ts`.
- `.env.example` — `JOB_CLAIM_LEASE_MS` optional (default 600000). No tokens.

## Routes (all Bearer `MORPHEUS_API_TOKEN`)

```
GET  /v1/jobs?status=queued&namespace=   → list (cap 20), oldest first
POST /v1/jobs/:id/claim                  → body { claimed_by: string }
                                           CAS queued→claimed; 409 if not queued
POST /v1/jobs/:id/complete               → body {
                                             reply: string,            // posted to Discord
                                             github_issue_url?: string // stored only; posting issues is the next/docs slice
                                           }
POST /v1/jobs/:id/fail                   → body { error: string } → status=failed, no Discord reply
```

`complete` must be **idempotent**:

1. Verify job is `claimed` **and** `claimed_by` matches the caller identity.
2. Persist `reply_text` + a `completion_key` first (or in the same transaction as send metadata).
3. Post `reply` via discord.js with `allowedMentions: { parse: [] }`. Split at 2000 chars. Needs **Send Messages in Threads** for thread jobs.
4. Store `result_discord_message_id`. If Discord already accepted a send and the process dies, retry must **not** post a duplicate (look up completion_key / existing message id).
5. Set `status=completed`.

If Discord send fails before any message id exists, leave job `claimed` with `error`. Cap outstanding jobs per author. Allowlist GitHub target repos if `github_issue_url` is later attached; do not create issues from untrusted Discord text without a policy check (#31).

Claim CAS binds to `claimed_by`; a second worker with a different identity gets 409.

## Lease

`claim` sets `claimed_at`. If `now - claimed_at > JOB_CLAIM_LEASE_MS` and status is still `claimed`, a sweeper sets `queued` and clears `claimed_by`. Tests with injected clock or passed `now`.

## Security

- Same bearer as search. Do not add a second Discord-side token.
- `reply` is untrusted agent text: send as message content (Discord markdown), no eval. Optional: reject `@everyone` / `@here` unless in leadership (simple string check).
- Never echo `DISCORD_TOKEN` in job payloads or logs.

## Out of scope

- Opening GitHub issues (document URL field only).
- In-process LLM.
- Slash commands.

## Acceptance criteria

- [ ] Claim CAS: two claims → one 200, one 409.
- [ ] Complete stores reply text and transitions to `completed`.
- [ ] With a stubbed Discord client, `postJobReply` is invoked with the job's channel/message id.
- [ ] Expired claim becomes `queued` again.
- [ ] Unauthenticated `/v1/jobs` → 401.

## Dependencies

- Jobs enqueue.
- HTTP auth from `/v1` search slice.
