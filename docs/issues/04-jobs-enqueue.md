Parent: #25. Next: #30.

## Goal

Turn `@bot` mentions (and replies to the bot) in allowlisted Tech@NYU channels into durable **jobs** in SQLite. No LLM in this slice. No Nia. Official bot only.

This is the inbound half of `docs/context-layer.md` §4. It **conflicts with issue #10** if both attach a mention handler that replies immediately — gate this behind `JOB_QUEUE_ENABLED` (default true when you ship) or land it instead of #10's placeholder reply.

## Files to create / modify

- `src/storage/db.ts` — `jobs` table (schema in `docs/context-layer.md` §4).
- `src/storage/jobs.ts` (new) — `enqueueJob`, `getJob`, `listQueued`, `cancelQueuedInChannel`.
- `src/bot/triggers.ts` (new) — `isMentionTrigger(msg, botUserId)`, `isReplyToBot(msg, botUserId)` (pure; see #11 for test cases). You may implement #11's trigger module here and close the overlap, **without** pi-agent-core.
- `src/bot/events.ts` — after ingest, if trigger matches and channel allowlisted, enqueue. Still ingest the message as today.
- `src/config.ts` — `JOB_QUEUE_ENABLED` optional, default true once ready.
- `tests/storage-jobs.test.ts`, `tests/bot-triggers.test.ts`.

## Enqueue rules

1. Author is not a bot (including not this bot).
2. Channel (or thread parent) is allowlisted.
3. Mention of `client.user.id` **or** reply to a message authored by the bot.
4. Insert job `status=queued`, `namespace` from `isolated` flag of the parent channel.
5. Unique on `discord_message_id` (re-delivery / edit: do not duplicate; updates to content may `UPDATE` if still `queued`).
6. Optional: when a new job is enqueued, mark other `queued` jobs in the same `discord_channel_id` as `cancelled` (latest-wins, same idea as #13 without AbortController). Document the choice in JSDoc and tests.

Do **not** post a Discord reply in this slice (that is the claim/complete issue). Logging `job_id` at info is enough.

## Out of scope

- HTTP `/v1/jobs`.
- Calling Cursor APIs.
- Slash commands.
- Self-bots / scanning all messages for LLM.

## Acceptance criteria

- [ ] Mention in allowlisted general channel → one `queued` job with `namespace=general`.
- [ ] Mention in `isolated: true` channel → `namespace=leadership`.
- [ ] Mention in non-allowlisted channel → no job.
- [ ] Bot-authored message → no job.
- [ ] Duplicate `discord_message_id` does not insert a second row.
- [ ] Existing ingest tests still pass (jobs are additive).

## Dependencies

None strictly. HTTP claim/complete is the next slice.
