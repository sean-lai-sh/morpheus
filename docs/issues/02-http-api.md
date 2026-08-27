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

**Path-traversal acceptance (client `path` / `pathPrefix` is the general/leadership boundary):**

1. Decode encodings (including `%2e%2e` and double-encoded `%252e%252e`) before any other check.
2. POSIX **normalize-then-prefix-check**: collapse `.` / `..`, then require the result to be `/`, `/${tokenNamespace}`, or a descendant of `/${tokenNamespace}`.
3. Reject encoded `..`, `/Users`, `~`, and absolute host paths (`/home`, `/etc`, Windows drives, `//share`, …). Relative paths that escape `/` are rejected.
4. A general token on `/general/../leadership` or `/general/%2e%2e/leadership` is **404** after normalize — never a 200 leak of leadership. Do not `readdir` the Mini disk.

## Routes

| Method | Path | Auth | Tool | Behavior |
|---|---|---|---|---|
| GET | `/health` | none | — | `{ ok, last_message_at, fts_count }`. No bodies. |
| GET | `/v1/fs/tree?path=` | Bearer | ls/tree | Children of an index path. Cap 100. |
| POST | `/v1/fs/search` | Bearer | grep | FTS. Body: `{ query, pathPrefix?, limit? }`. **No** client namespace. **No** `includeDeleted` (default deny; `true` → 400). |
| GET | `/v1/fs/read?path=` | Bearer | cat | One virtual doc (message or channel window). 404 if missing, other namespace, or **deleted**. |
| GET | `/v1/messages/:id` | Bearer | cat | Same isolation as read. Deleted → **404**. |
| GET | `/v1/poll?cursor=&limit=` | Bearer | — | Optional catch-up in token namespace. Cursor = monotonic **seq**, not `created_at`. Deleted rows are **tombstones with empty `content`** (catch-up without leaking bodies). |

## Negative tests (principals, not query params)

- [ ] General token cannot tree/read/search a `/leadership/...` path (even if `namespace=leadership` is sent).
- [ ] General token + leadership message id → **404**.
- [ ] `path=/Users/sean` or `path=../` → **404**.
- [ ] Encoded `..` (`%2e%2e`, `%252e%252e`) and `/general/../leadership` with a general token → **404**.
- [ ] `~/src`, `/etc/passwd`, and other absolute host paths → **404**.
- [ ] `includeDeleted: true` on **any** `/v1/*` route (search, read, messages, poll, tree) → **400**. Cat of a deleted message → **404**. Poll may emit the tombstone with empty content.
- [ ] No token → 401 on every `/v1/*` except `/health`.

## Implementation notes

- Same `Bun.serve` as `/health`. Bind `HEALTH_HOST` (zod allowlist: `127.0.0.1`, `::1`, Tailscale `100.64/10` / `fd7a:`). Default `127.0.0.1`. Refuse `0.0.0.0`, `::`, `::0`, LAN/WAN unicasts. Tokens and bind address go through `loadEnv()` / zod (`MORPHEUS_API_TOKEN_GENERAL`, `MORPHEUS_API_TOKEN_LEADERSHIP`, `HEALTH_HOST`).
- This slice is **#40** (live vfs). Do **not** close [#41](https://github.com/sean-lai-sh/morpheus/issues/41) from this PR.
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
