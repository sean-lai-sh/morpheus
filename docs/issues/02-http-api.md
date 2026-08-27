Parent: #25. Depends on #26. Host: Mac Mini (`docs/hosting.md`). Bind **127.0.0.1**.

## Goal

Expose the `ContextStore` over HTTP for **on-box tools on the Mac Mini**. This is **not** the Grok Bot internet path (Mini has no public inbound IP; Grok receives context via `GROK_BOT_WEBHOOK_URL`, #37).

AWS / Cursor cloud-agent VMs / Grok Bot’s shared computer are **not** hosts.

## Auth: namespace is not a client parameter

**A client-supplied `namespace` query/body field is not authorization.** One shared `MORPHEUS_API_TOKEN` plus `namespace=leadership` would let any holder read leadership. That fails the dual-Nia isolation we are replacing.

**Required model:**

- Issue **scoped** credentials: `MORPHEUS_API_TOKEN_GENERAL` and `MORPHEUS_API_TOKEN_LEADERSHIP` (empty placeholders in `.env.example`; never commit values).
- `src/http/auth.ts`: Bearer compare (`crypto.timingSafeEqual` on hashed or padded buffers). Map the matching token → `Namespace`. Unknown/missing token → **401**.
- **Derive `namespace` server-side from the credential.** Ignore a client-supplied namespace, or **403** if it is present and does not match the token’s scope.
- Job-scoped routes (later, #30): namespace comes from the **job row**, then must match the token’s scope. Never from `?namespace=`.
- Do **not** use `DISCORD_BOT_TOKEN` as this bearer.

## Negative tests (hard requirement)

These test the **principal**, not the query string:

- [ ] General token + `GET /v1/messages/:leadershipId` → **404** (even if the client also sends `namespace=leadership`).
- [ ] General token + `POST /v1/search` body `{ query: "<exact leadership text>", namespace: "leadership" }` → **no leadership hits** (server uses general).
- [ ] General token + `GET /v1/poll` cannot return leadership documents.
- [ ] Leadership token cannot be used to complete a general job (#30), and vice versa.
- [ ] No token → 401 on every `/v1/*` except `/health`.

## Files

- `src/http/server.ts` (expand `health.ts`) — bind `127.0.0.1`.
- `src/http/auth.ts` — scoped tokens as above.
- `.env.example` — `MORPHEUS_API_TOKEN_GENERAL=` and `MORPHEUS_API_TOKEN_LEADERSHIP=` empty.
- `tests/http-v1.test.ts` — ephemeral `Bun.serve` + temp DB + **cross-scope negatives**.

## Routes (namespace from token, not from the client)

| Method | Path | Auth | Behavior |
|---|---|---|---|
| GET | `/health` | none | `{ ok, last_message_at, fts_count }`. No message bodies. No Nia fields once FTS freshness exists. |
| POST | `/v1/search` | Bearer | JSON body = search text/filters **without** a client-chosen namespace. Server sets namespace from token. 400 on missing `query`. |
| GET | `/v1/messages/:id` | Bearer | 404 if missing **or** not in the token’s namespace. |
| GET | `/v1/channels/:channelId/messages` | Bearer | Windowed read. 403/404 if the channel (use `effectiveChannelId` / parent for threads) is not in the token’s namespace. |
| GET | `/v1/poll?cursor=&limit=` | Bearer | Incremental page **in the token’s namespace only**. |

## Implementation notes

- Reuse `startHealthServer` / `stopHealthServer` so `HEALTH_PORT` hosts both.
- `limit` capped at 50.
- Never return SQL errors to clients; log internally, 500.
- CORS: default deny. Localhost-on-Mini only.
- Bind `127.0.0.1` (not `0.0.0.0`).
- Do not read `data/discord/**/*.md`.
- In-process `ContextStore` still takes `Namespace` as an argument (trusted caller). HTTP is the untrusted boundary.

## Out of scope

- Job queue routes (`/v1/jobs`) — #30.
- Public TLS / reverse proxy / AWS load balancer (stale).
- Removing Nia.

## Acceptance criteria

- [ ] Cross-scope negatives above all pass.
- [ ] `/health` has no secrets and no Nia-only fields once FTS freshness exists.
- [ ] README curl examples use `$MORPHEUS_API_TOKEN_GENERAL` placeholder only.

## Dependencies

- ContextStore + FTS5 (#26).
