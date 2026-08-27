Parent: #25. Depends on #26 (FTS) and #39 (Mini + Tailscale). Product: [#40](https://github.com/sean-lai-sh/morpheus/issues/40). Host: [`docs/hosting.md`](../hosting.md).

## Goal

Expose a **vfs-style HTTP API over the Morpheus index only**: **search (grep)**, **read (cat)**, **tree/list (ls)**. Grok Bot uses this **live** when the first-pass webhook snippets are not enough.

This is **not**:

- A mount of the Mac Mini homedir or personal projects (no SSHFS/NFS/SMB of `~`)
- A public internet server (no Fly/AWS inbound)
- A fat-job API that dumps the whole index into `GROK_BOT_WEBHOOK_URL`

Bind to the **Tailscale** address. ACL: `tag:morpheus`, **this HTTP port only**, scoped token, **no SSH**.

## Auth: namespace is not a client parameter

**A client-supplied `namespace` is not authorization.** Scoped secrets: `MORPHEUS_API_TOKEN_GENERAL` and `MORPHEUS_API_TOKEN_LEADERSHIP`. Derive namespace **server-side** from the bearer. Ignore or **403** a client-supplied namespace that does not match. Job routes (#30) take namespace from the **job row**.

Do **not** use `DISCORD_BOT_TOKEN` as this bearer.

## Index paths

Virtual, POSIX-looking, rooted at `/general` or `/leadership`:

```
/general/{category}/{channel-slug}
/general/{category}/{channel-slug}/threads/{thread-slug}
/leadership/...
```

`channelId` on a stored row is the Discord channel **or thread** id (`messages.channel_id`). `parentChannelId` is the parent text channel (`messages.parent_channel_id`). Tree keys on the **parent/allowlisted** channel (same as `messagesForChannelAsc`: `channel_id = ? OR parent_channel_id = ?`). Read of a message uses the row’s own `channelId` in its Discord permalink.

Reject (`404`): `..`, `/Users`, `~`, absolute host paths, any path that is not under the token’s namespace prefix.

## Routes

| Method | Path | Auth | Tool | Behavior |
|---|---|---|---|---|
| GET | `/health` | none | — | `{ ok, last_message_at, fts_count }`. No bodies. |
| GET | `/v1/fs/tree?path=` | Bearer | ls/tree | Children of an index path. Cap 100. |
| POST | `/v1/fs/search` | Bearer | grep | FTS. Body: `{ query, pathPrefix?, limit? }`. **No** client namespace. **No** `includeDeleted` (default deny; `true` → 400). |
| GET | `/v1/fs/read?path=` | Bearer | cat | One virtual doc (message or channel window). 404 if missing or other namespace. |
| GET | `/v1/messages/:id` | Bearer | cat | Same isolation as read. |
| GET | `/v1/poll?cursor=&limit=` | Bearer | — | Optional catch-up in token namespace. Cursor = monotonic **seq**, not `created_at`. |

## Negative tests (principals, not query params)

- [ ] General token cannot tree/read/search a `/leadership/...` path (even if `namespace=leadership` is sent).
- [ ] General token + leadership message id → **404**.
- [ ] `path=/Users/sean` or `path=../` → **404**.
- [ ] `includeDeleted: true` on HTTP → **400**.
- [ ] No token → 401 on every `/v1/*` except `/health`.

## Implementation notes

- Same `Bun.serve` as `/health`. Listen on Tailscale IP (`HEALTH_HOST` / default Tailscale interface), **not** a public NIC.
- `limit` capped at 50 for search, 100 for tree.
- Never return SQL errors; 500 internally.
- CORS default deny.
- Do not `readdir` the Mini disk. SQLite FTS + `messages` only.
- Discord permalink on reads: `https://discord.com/channels/{guildId}/{channelId}/{messageId}` using the row’s `channel_id` (thread id for thread messages).

## Out of scope

- Homedir / git-repo sharing
- Public TLS / AWS / Fly
- Nia
- Fat webhook retrieval (#37 stays **first-pass only**)

## Dependencies

- #26 ContextStore FTS (in-repo `01-context-store.md`, not the frozen GitHub body).
- #39 Mini + Tailscale tag/ACL.
