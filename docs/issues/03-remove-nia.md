Parent: #25. Depends on #26 (FTS) and **#37 Mini→Grok dispatch**. **Last** in the cutover (do not delete Nia before Mini can retrieve SQLite context and POST it to Grok). AWS-as-host is **stale**. `/v1` (#27) is localhost-on-Mini, not a Grok internet dependency.

## Goal

Stop depending on Nia for indexing. After ContextStore + HTTP exist, turn the syncer off by default, then delete the vendor code.

Read `docs/context-layer.md` §2 (coupling inventory) and §5.

## Phase 1 — flag (can ship in the same PR as Phase 2 if HTTP is already on main)

- Add `NIA_SYNC_ENABLED` optional env, default **`false`** once FTS search exists (if this lands first, default `true` only while FTS is missing — prefer default false and keep markdown export).
- `startSyncer()` / `flushNow()` in `src/index.ts` no-op when disabled.
- `src/http/health.ts` (or `server.ts`): stop reporting `nia_*` or report `{ nia_sync: "disabled" }`.
- Fix the existing bug: health currently calls `getSyncState(DISCORD_DIR)` but the syncer dirties `GENERAL_DIR` and `LEADERSHIP_DIR`. Do not "fix" by querying Nia; query FTS/ingest freshness instead.
- `.env.example` / README: Nia vars marked deprecated. Remove `NVIDIA_API_KEY` from the documented required Doppler set (unused).
- `NIA_BASE_URL` zod default (`https://api.trynia.ai`) disagrees with `client.ts` (`https://apigcp.trynia.ai/v2`). Irrelevant once deleted; do not spend time "fixing" unless Phase 1 still ships with sync on.

## Phase 2 — delete

Remove:

- `src/nia/client.ts`, `src/nia/syncer.ts`
- `scripts/register-nia-source.ts`
- `package.json` script `register-nia`
- Env schema keys `NIA_API_KEY`, `NIA_BASE_URL`, `NIA_DISCORD_SOURCE_ID`, `NIA_DISCORD_LEADERSHIP_SOURCE_ID`
- Table `nia_sync_state` — add a migrate-alter `DROP TABLE IF EXISTS nia_sync_state` (or leave the table unused; dropping is cleaner)
- `src/storage/sync-state.ts` if nothing else uses dirty flags. If markdown export still wants a dirty bit for a future exporter, rename the table away from `nia_*`.
- README sections "How Nia indexing works" and "Register Nia namespaces" — replace with Context API.
- Comments in `src/bot/ingest.ts` about "NIA indexes all content at query time"
- `config/channels.example.yml` comments that mention Nia source IDs (`isolated: true` stays; it now means `namespace=leadership`)

Keep:

- `isolated` channel flag and dual namespace
- Markdown renderer (`src/storage/markdown.ts`) until a follow-up explicitly drops the dump
- `data/` gitignore

Optional follow-up (not required here): remove unused `openai` dependency and `NVIDIA_API_KEY`.

## Out of scope

- Rewriting ingest or crawlers.
- Embeddings.

## Acceptance criteria

- [ ] `bun run live` with no `NIA_*` env starts (given Discord vars + scoped `MORPHEUS_API_TOKEN_*` if localhost `/v1` requires them).
- [ ] `rg -i nia src scripts` has no remaining runtime references (docs history is fine).
- [ ] `bun test` / `tsc` pass.
- [ ] README no longer tells operators to run `bun run register-nia`.

## Dependencies

- ContextStore FTS (so search still exists).
- Mini FTS (#26) + outbound Grok dispatch (#37) preferred before deleting, so Grok has a replacement without Nia or a public Mini IP. HTTP `/v1` is localhost-on-Mini only.
