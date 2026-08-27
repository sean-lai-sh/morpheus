Parent: #25. Depends on #26 (FTS) and #39 (Mini + Tailscale). Product: [#40](https://github.com/sean-lai-sh/morpheus/issues/40). Host: [`docs/hosting.md`](../hosting.md).

## Goal

Expose a **vfs-style HTTP API over the Morpheus index only**: **search (grep)**, **read (cat)**, **tree/list (ls)**. Grok Bot uses this **live** when the first-pass webhook snippets are not enough.

This is **not**:

- A mount of the Mac Mini homedir or personal projects (no SSHFS/NFS/SMB of `~`)
- A public internet server (no Fly/AWS inbound)
- A fat-job API that dumps the whole index into `GROK_BOT_WEBHOOK_URL`

Bind to the **Tailscale** address. ACL: `tag:morpheus`, **this HTTP port only**, scoped token, **no SSH**.

## Auth: namespace is not a client parameter

**A client-supplied `namespace` is not authorization.** One scoped bearer per workspace, declared as `workspaces.<id>.token_env` in `config/channels.yml` (e.g. `MORPHEUS_API_TOKEN_LEADERSHIP`, `MORPHEUS_API_TOKEN_EBOARD`, `MORPHEUS_API_TOKEN_PROGRAMS_DEV`). Derive scope **server-side** from whichever token matched (`scopeFor`) — that workspace plus every transitive descendant, never upward or sideways. A client-supplied `namespace` that does not equal the token's root workspace → **403**. Job routes (#30) take scope from the **job row**'s workspace.

Do **not** use `DISCORD_BOT_TOKEN` as this bearer.

## Index paths

Virtual, POSIX-looking, rooted at a workspace id (see `docs/context-layer.md` § Workspaces for the tree):

```
/{workspace}/{category}/{channel-slug}
/{workspace}/{category}/{channel-slug}/threads/{thread-slug}
/{workspace}/{category}/{channel-slug}[/threads/{thread-slug}]/{messageId}
```

`GET /v1/fs/tree?path=/` lists the workspaces visible from the token's scope, flat and sorted.

`channelId` on a stored row is the Discord channel **or thread** id (`messages.channel_id`). `parentChannelId` is the parent text channel (`messages.parent_channel_id`). Tree keys on the **parent/allowlisted** channel (same as `messagesForChannelAsc`: `channel_id = ? OR parent_channel_id = ?`). Read of a message uses the row’s own `channelId` in its Discord permalink.

**Path-traversal acceptance (client `path` / `pathPrefix` is checked against the token's `scope.visible` set):**

1. Decode encodings (including `%2e%2e` and double-encoded `%252e%252e`) before any other check.
2. POSIX **normalize-then-prefix-check**: collapse `.` / `..`, then require the first path segment to be `/` or a workspace id in `scope.visible`.
3. Reject encoded `..`, `/Users`, `~`, and absolute host paths (`/home`, `/etc`, Windows drives, `//share`, …). Relative paths that escape `/` are rejected.
4. A narrow token normalizing into a workspace **outside** its scope is **404** — never a 200 leak. A path that normalizes into a workspace still **inside** scope is fine even if it walked through `..` to get there (e.g. an `eboard` token on `/eboard/../programs-dev/...` → 200). Do not `readdir` the Mini disk.

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

- [ ] A `programs-dev` token cannot tree/read/search `/programs-mentorship` (sideways, same parent) → **404**.
- [ ] An `eboard` token cannot tree/read/search `/leadership` (upward) → **404**.
- [ ] `/programs-dev/../eboard` from a `programs-dev` token → **404** (normalizes outside scope).
- [ ] A `namespace=` query param that does not equal the token's root workspace → **403**.
- [ ] A category name used as the first path segment (no matching workspace id) → **404**.
- [ ] `path=/Users/sean` or `path=../` → **404**.
- [ ] Encoded `..` (`%2e%2e`, `%252e%252e`) resolving outside the token's scope → **404**.
- [ ] `~/src`, `/etc/passwd`, and other absolute host paths → **404**.
- [ ] `includeDeleted: true` on **any** `/v1/*` route (search, read, messages, poll, tree) → **400**. Cat of a deleted message → **404**. Poll may emit the tombstone with empty content.
- [ ] No token → 401 on every `/v1/*` except `/health`.

## Implementation notes

- Same `Bun.serve` as `/health`. Bind `HEALTH_HOST` (zod allowlist: `127.0.0.1`, `::1`, Tailscale `100.64/10` / `fd7a:`). Default `127.0.0.1`. Refuse `0.0.0.0`, `::`, `::0`, LAN/WAN unicasts. Bind address goes through `loadEnv()` / zod (`HEALTH_HOST`); tokens are loaded per-workspace via `loadWorkspaceTokens()` (`workspaces.<id>.token_env` in `channels.yml`).
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
