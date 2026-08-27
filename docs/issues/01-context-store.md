Parent: #25. Next: #27 / #40. **Blocked on #39 (Mini + Tailscale).** Do **not** implement from the frozen GitHub #26 body.

## Goal

Replace Nia as the retrieval engine with an in-process `ContextStore` backed by SQLite FTS5 so Grok can **live grep/cat/ls the index** (HTTP in #27/#40). Ingest already upserts `messages`.

This **supersedes the Nia half of #15**. Owner close #15: #38.

## `channelId` vs schema (do not contradict `messages`)

`messages.channel_id` is the **thread’s own id** for thread messages. `parent_channel_id` is the parent text channel. That is why `effectiveChannelId(row)` exists (`src/storage/messages.ts` on `main` @ `291a3ef`).

`IndexDocument` **must** carry both:

- `channelId` = `messages.channel_id` (row’s own channel)
- `parentChannelId` = `messages.parent_channel_id`

`readChannelWindow({ channelId })` keys on the **parent/allowlisted** id and **includes threads** (`WHERE channel_id = ? OR parent_channel_id = ?`). `SearchHit.channelId` is the row’s own id; round-trip to tree/read uses `parentChannelId` + index `path`. Discord permalink uses the row’s `channelId`.

## `namespaceForRow` (must not fail open)

`namespaceForRow(row): Namespace | null` using `effectiveChannelId` then `getChannel(parent)?.isolated`. **Do not** write `namespaceForChannel(channelId)` that maps unknown ids to `general` — thread ids are never in `channels.yml`, so a leadership thread would leak. Callers **hard-fail** on `null`. Positive test: thread of `isolated: true` parent → `leadership`.

## Poll cursor (decide here)

**`INTEGER seq`** on `messages`, bumped on **every** write in `upsertMessage`, `markDeleted`, and `setReactions`. Cursor = `${seq}:${id}`. **Not** `(created_at, id)` — hourly backfill writes old `created_at`; edits/deletes do not move it. Snowflake `id` is TEXT: use `CAST(id AS INTEGER)` for `after`/`before` bounds.

## Files

- `src/context/types.ts` — as `docs/context-layer.md` §3 (`tree`, `readPath`, `permalink`).
- `src/context/namespace.ts` — `namespaceForRow` only.
- `src/context/store.ts` — SQLite + **virtual** index paths (not Mini `data/` or `~`).
- `src/storage/db.ts` — FTS5. Prefer external-content `content='messages'`; resolve namespace at query time from config. Flipping `isolated` requires `bun run reindex`.
- `src/bot/ingest.ts` — `contextStore.index` after upsert/delete. Keep `appendBlock` until #28.
- `src/tasks/reindex.ts` — rebuild FTS from `messages`.
- Tests: thread→leadership, seq poll after edit/delete, `channelId` vs `parentChannelId`.

## VFS extras

- `tree(path, namespace)` / `readPath` — `/general/{category}/{channel-slug}/…`, never OS paths.
- `search` default `deleted_at IS NULL`. HTTP later default-denies `includeDeleted`.

## Out of scope

- HTTP (next: #27/#40 over Tailscale).
- Homedir share.
- Fat webhook as the retrieval API.
- Nia / #15 / pi-agent-core.

## Acceptance

- [ ] Leadership **thread** absent from general search.
- [ ] Edit/delete appears in `poll` after a cursor that passed the original `created_at`.
- [ ] Thread row: `channelId` is thread id; `parentChannelId` is parent.
- [ ] `bun run reindex` rebuilds FTS.
- [ ] No `src/nia/*` calls.

## Dependencies

#39 Mini host. Live tools HTTP is #27/#40 — do not skip them in favor of stuffing the webhook.
