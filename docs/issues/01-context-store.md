Parent: #25. Next: #27.

## Goal

Replace Nia as the retrieval engine with an in-process `ContextStore` backed by SQLite FTS5. Ingest already upserts `messages`; this slice adds search/read/poll **without HTTP** and **without Nia**.

Read [`docs/context-layer.md`](https://github.com/sean-lai-sh/morpheus/blob/cursor/nia-migration-plan-9afa/docs/context-layer.md) §3 for the full interface. This issue **supersedes the Nia half of #15**. Keep #15's requirements that still apply: namespace isolation, freshness, abort-friendly design (sync FTS is fine).

## Files to create / modify

- `src/context/types.ts` (new) — `Namespace`, `IndexDocument`, `SearchQuery`, `SearchHit`, `PollPage`, `ContextStore` as specified in `docs/context-layer.md` §3.
- `src/context/namespace.ts` (new) — `namespaceForChannel(channelId): Namespace` using `getChannel(id)?.isolated`.
- `src/context/store.ts` (new) — SQLite implementation.
- `src/storage/db.ts` — FTS5 virtual table + namespace-safe query helpers. Migration must be idempotent.
- `src/bot/ingest.ts` — after successful upsert/delete, call `contextStore.index` (or `indexFromRow`). Keep `appendBlock` for now (Nia rollback).
- `src/tasks/reindex.ts` — also rebuild FTS from `messages` (not just markdown).
- `tests/context-store.test.ts` (new).
- `tests/context-namespace.test.ts` (new).

## Schema sketch

```sql
-- Mirrors messages for FTS; do not FTS leadership and general in one unscoped query.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  id UNINDEXED,
  channel_id UNINDEXED,
  thread_id UNINDEXED,
  namespace UNINDEXED,
  author_name UNINDEXED,
  created_at UNINDEXED,
  tokenize = 'porter unicode61'
);

-- Keep namespace on a side table if you prefer not to put it in FTS UNINDEXED.
-- Either way, every SEARCH/read MUST filter namespace in SQL, not in JS after the fact.
```

Use an FTS content-sync trigger or explicit rebuild in `index()` — explicit is easier to test. On delete, remove or update the FTS row; tombstoned messages are excluded from default search (`deleted_at IS NULL`).

`Namespace` is derived from **parent** channel config (`effectiveChannelId`), not from `thread_id`.

## `ContextStore` behavior

- `index(doc)`: upsert FTS + rely on existing `messages` row (ingest already wrote it). If `doc.namespace` disagrees with `namespaceForChannel(doc.channelId)`, throw.
- `search(q)`: FTS match on `content`, `WHERE namespace = ?`, optional `channelHint` (id exact or name via `channels.yml`), optional `threadId`, time bounds, `LIMIT`. Return snippet (FTS `snippet()` or truncated content).
- `readMessage(id, namespace)`: `SELECT` from `messages` joined with namespace; **return null** if the row exists in the other namespace (do not  leak).
- `readChannelWindow`: chronological page, same namespace check (channel must belong to that namespace).
- `poll(namespace, cursor, limit)`: messages with `(created_at, id)` after cursor in that namespace only. Cursor v1: `${created_at}:${id}`. Empty cursor = oldest or newest? **Newest-forward from "now minus 0"** is wrong for backfill. Define: `null` cursor returns the latest page (descending) plus a cursor for the next older page **or** document both. Prefer: `null` means "give me documents with created_at > last_seen"; for bootstrap, client passes `sinceMs`. Pick one, test it, document it in the method JSDoc.

## Namespace isolation (hard requirement)

A leadership-only message (`isolated: true` channel, e.g. `#leadership-team`) must **never** appear in `search` / `readMessage` / `poll` with `namespace: "general"`, even with a perfect keyword match. Add a negative test.

## Freshness (minimal)

Export `ingestFreshness(): { lastMessageAt: number | null; ftsCount: number }` from the store so HTTP `/health` (next slice) can drop Nia fields. No Nia `last_sync_at`.

## Out of scope

- HTTP API (next issue).
- Discord mentions/jobs.
- Removing `src/nia/` or markdown files.
- Embeddings / sqlite-vec (optional later, same `ContextStore.search` signature).
- Pi-agent-core tool wrapper (`search_discord` in #15) — if you add a thin function `searchDiscord(q)` used by both HTTP and a future tool, fine; do not add Nia.

## Acceptance criteria

- [ ] `bun test` covers: insert then search hit; edit updates FTS; delete excluded; channelHint filters; leadership row absent from general search and `readMessage(..., "general")`.
- [ ] Ingest path indexes without requiring `NIA_*` env.
- [ ] `bun run reindex` rebuilds FTS from SQLite.
- [ ] No new calls into `src/nia/*`.
- [ ] `bunx tsc --noEmit` and existing tests still pass.

## Dependencies

None. Can land before HTTP.
