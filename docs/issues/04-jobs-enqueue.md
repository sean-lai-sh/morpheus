Parent: #25. Next: #30 / #37. Host: Mac Mini. Official bot only.

## Goal

Turn `@bot` mentions (and replies to the bot) in allowlisted Tech@NYU channels into durable **jobs** in SQLite. No LLM. No Nia.

This **conflicts with issue #10** — do not implement #10. Gate behind `JOB_QUEUE_ENABLED` (default true when you ship).

## Untrusted Discord text

`jobs.content` is **untrusted**. It is prompt-injection input to Grok Bot. Channel allowlisting is **not** requester authorization.

Minimum MVP policy (implement in this slice or block enqueue):

1. **Role gate.** Author must have at least one role in `JOB_TRIGGER_ROLE_IDS` (comma-separated snowflakes in Mini Doppler; empty placeholder in `.env.example`). If the list is empty in production, log an error and **do not enqueue** (fail closed). Tests inject a set.
2. **Outstanding-job cap.** Max **2** `queued`+`claimed` jobs per `author_id` (configurable `JOB_MAX_OUTSTANDING_PER_AUTHOR`, default 2). Excess → no insert; log.
3. **Rate cap.** Max **5** enqueues per author per rolling hour (`JOB_MAX_PER_AUTHOR_PER_HOUR`, default 5).
4. **Namespace from the message row**, not a bare channel id: `namespaceForRow(row)` using `effectiveChannelId` / `parent_channel_id`. Unknown channel → **do not enqueue** (do not fail open to `general`). Threads of `#leadership-team` are leadership.
5. **Trigger is independent of ingest.** `src/bot/ingest.ts` strips mentions then drops `stripped.length < 6`. A bare `@Morpheus` must still enqueue. Check triggers on the **raw** Discord message; job `content` is the raw text, not a SQLite read-back (ingest may have dropped the row).

Do **not** cancel other authors’ queued jobs in the same channel (that was #13’s in-process “latest wins” and is wrong for a shared eboard channel). Optional: cancel the **same author + same thread** older `queued` jobs and post a one-line “superseded” reply in #30 — not silent `cancelled` for someone else.

## Files

- `src/storage/db.ts` — `jobs` table (`docs/context-layer.md` §4).
- `src/storage/jobs.ts` — `enqueueJob`, `getJob`, `listQueued` (by namespace), **no** `cancelQueuedInChannel` that drops other users.
- `src/bot/triggers.ts` — `isMentionTrigger`, `isReplyToBot` (pure; steal predicates from #11, no pi-agent-core).
- `src/bot/events.ts` — trigger check **alongside** ingest, not gated on `IngestResult.action === "indexed"`.
- `src/config.ts` — `JOB_QUEUE_ENABLED`, `JOB_TRIGGER_ROLE_IDS`, caps.
- Tests: `tests/storage-jobs.test.ts`, `tests/bot-triggers.test.ts`, role/cap negatives.

## Enqueue rules

1. Author is not a bot.
2. Channel (or thread **parent**) is allowlisted.
3. Role gate (#1 above).
4. Mention of `client.user.id` **or** reply to a bot message.
5. Caps (#2–#3).
6. Insert `status=queued`, namespace from `namespaceForRow`. Unique on `discord_message_id`.

Do **not** post a Discord reply here (#30). Do **not** open GitHub issues here (#31). Logging `job_id` is enough. Mini later POSTs to `GROK_BOT_WEBHOOK_URL` (#37).

## Out of scope

- HTTP `/v1/jobs`.
- Self-bots.
- Slash commands.
- In-process Pi agent (#10).

## Acceptance criteria

- [ ] Mention in allowlisted general channel, allowed role → one `queued` job `namespace=general`.
- [ ] Mention in `isolated: true` **thread** → `namespace=leadership` (not fail-open general).
- [ ] Unknown / non-allowlisted channel → no job.
- [ ] Author without trigger role → no job.
- [ ] Over outstanding/rate cap → no job.
- [ ] Bot-authored → no job.
- [ ] Duplicate `discord_message_id` does not insert a second row.
- [ ] Bare `@Morpheus` enqueues even if ingest drops as too-short.
- [ ] Existing ingest tests still pass.

## Dependencies

None strictly. #37 dispatch and #30 replies are next.
