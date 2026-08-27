Parent: #25. Depends on #26.

## Goal

Expose the `ContextStore` from the FTS slice over HTTP for **on-box tools on the Mac Mini**. Bind to **127.0.0.1**. This is **not** the Grok Bot internet path: Mini has no public inbound IP, and Grok Bot must not poll `/v1` over the network. Live context for Grok is pushed outbound via `GROK_BOT_WEBHOOK_URL` ([#37](https://github.com/sean-lai-sh/morpheus/issues/37), [`docs/hosting.md`](../hosting.md)).

AWS / Cursor cloud-agent VMs / Grok Bot’s shared computer are **not** hosts for this server.

Depends on the ContextStore / FTS5 issue (#26). Read `docs/context-layer.md` §3 HTTP table, §5 secrets, and `docs/hosting.md`.

## Files to create / modify

- `src/http/server.ts` (new or expand `health.ts`) — routes below.
- `src/http/auth.ts` (new) — Bearer compare. **Namespace is not auth.** Issue **scoped** tokens (`MORPHEUS_API_TOKEN_GENERAL` / `MORPHEUS_API_TOKEN_LEADERSHIP`) or a single token with an embedded scope. Derive `namespace` from the credential; ignore or 403 a client-supplied namespace that does not match. Negative tests: general token cannot read a leadership message id.
- `.env.example` — document scoped tokens as empty placeholders. **Do not put a real value.**
- `README.md` — how to curl the API.
- `tests/http-v1.test.ts` (new) — use `Bun.serve` on an ephemeral port + temp DB.

## Routes

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/health` | none | `{ ok, last_message_at, fts_count }`. **Do not** add message bodies. Drop or stop relying on Nia fields (`nia_dirty` is currently keyed on the wrong folder anyway). |
| POST | `/v1/search` | Bearer | JSON body = `SearchQuery` without a client-chosen namespace (or namespace must match token scope). 400 on missing `query`. |
| GET | `/v1/messages/:id?namespace=` | Bearer | 404 if missing **or** wrong namespace. |
| GET | `/v1/channels/:channelId/messages?namespace=&after=&before=&limit=` | Bearer | Windowed read. 403/404 if channel is not in that namespace. |
| GET | `/v1/poll?namespace=&cursor=&limit=` | Bearer | Incremental page. |

All `/v1/*` except `/health`: missing/invalid token → **401**. Do not use Discord token as this bearer.

Constant-time compare for the token (`crypto.timingSafeEqual` on hashed or padded buffers).

## Implementation notes

- Reuse `startHealthServer` / `stopHealthServer` from `src/index.ts` live mode so one port (`HEALTH_PORT`) hosts both.
- `limit` capped at 50.
- Never return SQL errors to clients; log internally, 500.
- CORS: default deny. Localhost-on-Mini only; not a public API.
- Bind `127.0.0.1` (not `0.0.0.0`). Mini does not need a public inbound IP.
- Do not read `data/discord/**/*.md` in these handlers.

## Out of scope

- Job queue routes (`/v1/jobs`) — later slice.
- Public TLS / reverse proxy / AWS load balancer (stale). Grok does not poll this over the internet.
- Removing Nia syncer.

## Acceptance criteria

- [ ] No token → 401 on `/v1/search`.
- [ ] Seeded general message is returned for `namespace=general` and omitted for `namespace=leadership`.
- [ ] Leadership message id with `namespace=general` → 404.
- [ ] `/health` has no secrets and no Nia-only fields once FTS freshness exists.
- [ ] README shows example `curl` with `$MORPHEUS_API_TOKEN` placeholder only.

## Dependencies

- ContextStore + FTS5 issue.
