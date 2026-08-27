## Goal

Expose the `ContextStore` from the FTS slice over HTTP so a **remote** Cursor/Grok agent can search/read/poll without a local `data/` dump or Nia. Serve it from the existing `Bun.serve` in `src/http/health.ts` (rename to `src/http/server.ts` if needed).

Depends on the ContextStore / FTS5 issue. Read `docs/context-layer.md` §3 HTTP table and §5 secrets.

## Files to create / modify

- `src/http/server.ts` (new or expand `health.ts`) — routes below.
- `src/http/auth.ts` (new) — Bearer token compare.
- `src/config.ts` — optional `MORPHEUS_API_TOKEN` (required in production when HTTP v1 is enabled; in `NODE_ENV=test` tests inject it).
- `.env.example` — document `MORPHEUS_API_TOKEN=` with a comment that it is a server secret, never committed. **Do not put a real value.**
- `README.md` — how to curl the API.
- `tests/http-v1.test.ts` (new) — use `Bun.serve` on an ephemeral port + temp DB.

## Routes

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/health` | none | `{ ok, last_message_at, fts_count }`. **Do not** add message bodies. Drop or stop relying on Nia fields (`nia_dirty` is currently keyed on the wrong folder anyway). |
| POST | `/v1/search` | Bearer | JSON body = `SearchQuery`. 400 on missing `namespace` or `query`. |
| GET | `/v1/messages/:id?namespace=` | Bearer | 404 if missing **or** wrong namespace. |
| GET | `/v1/channels/:channelId/messages?namespace=&after=&before=&limit=` | Bearer | Windowed read. 403/404 if channel is not in that namespace. |
| GET | `/v1/poll?namespace=&cursor=&limit=` | Bearer | Incremental page. |

All `/v1/*` except `/health`: missing/invalid token → **401**. Do not use Discord token as this bearer.

Constant-time compare for the token (`crypto.timingSafeEqual` on hashed or padded buffers).

## Implementation notes

- Reuse `startHealthServer` / `stopHealthServer` from `src/index.ts` live mode so one port (`HEALTH_PORT`) hosts both.
- `limit` capped at 50.
- Never return SQL errors to clients; log internally, 500.
- CORS: default deny. This is a bot-to-agent API, not a browser app.
- Do not read `data/discord/**/*.md` in these handlers.

## Out of scope

- Job queue routes (`/v1/jobs`) — later slice.
- TLS (terminate at reverse proxy).
- Removing Nia syncer.

## Acceptance criteria

- [ ] No token → 401 on `/v1/search`.
- [ ] Seeded general message is returned for `namespace=general` and omitted for `namespace=leadership`.
- [ ] Leadership message id with `namespace=general` → 404.
- [ ] `/health` has no secrets and no Nia-only fields once FTS freshness exists.
- [ ] README shows example `curl` with `$MORPHEUS_API_TOKEN` placeholder only.

## Dependencies

- ContextStore + FTS5 issue.
