Parent: #25 / #33 / #39. GitHub issue **#40**. HTTP shape: `docs/issues/02-http-api.md`. Host: `docs/hosting.md`.

## Goal

Grok Bot (and the Discord-side consumer) has **live search** over the Morpheus **index**, with filesystem-like freedom: **tree/ls**, **grep**, **cat/read**. This is **not** a mount of the Mac Mini homedir or personal projects.

## Consumer contract (lock this)

**Live tools, not a fat-job-only model.**

1. Mini **POSTs** the Discord ping + a **first-pass** snippet pack to `GROK_BOT_WEBHOOK_URL` so Grok has something immediately (`first_pass: true`, already capped).
2. If that is not enough, Grok **pulls more** over Tailscale: `search` / `read` / `tree` on **index paths**.
3. Do **not** stuff the webhook with “the whole channel / whole index”. Pre-retrieve-everything is **not** the primary path.

## Index paths (virtual)

Paths name **indexed club context**, never OS files, rooted at a workspace id (`docs/context-layer.md` § Workspaces):

```
/{workspace}/{category}/{channel-slug}/
/{workspace}/{category}/{channel-slug}/threads/{thread-slug}/
```

- Client `path` / `pathPrefix` is checked against the token's `scope.visible` set (that workspace plus every transitive descendant). Decode encodings (`%2e%2e`, `%252e%252e`) → POSIX **normalize-then-prefix-check** → require `/` or a first segment in `scope.visible`. Reject encoded `..`, `/Users`, `~`, absolute host paths. A path that normalizes to a workspace outside scope → **404** (e.g. a `programs-dev` token on `/programs-dev/../eboard`); one that stays inside scope is fine even via `..`.
- Markdown under `data/discord/` is a local Nia-era export, not the VFS
- Personal Mini repos stay off this API

## Access

Tailscale only (`tag:morpheus`, Morpheus HTTP port, scoped token). No SSH. No NFS/SMB/SSHFS. Public internet still has **no** inbound Morpheus port.

Grok holds `MORPHEUS_BASE_URL` (tailnet) + a single scoped `MORPHEUS_API_TOKEN_*` (per `workspaces.<id>.token_env` in `channels.yml`, e.g. `_LEADERSHIP`, `_EBOARD`, `_PROGRAMS_DEV`). Mini never puts those in the Discord webhook body.

## Tools

| Tool | HTTP | Meaning |
|---|---|---|
| ls / tree | `GET /v1/fs/tree?path=` | list children of an index path |
| grep | `POST /v1/fs/search` | FTS / filters; namespace from token |
| cat | `GET /v1/fs/read?path=` | read one virtual doc (message or channel window) |

`includeDeleted` default **deny** on HTTP (search, cat, poll). `includeDeleted: true` → **400**. Cat of a deleted message → **404**. Poll may emit tombstones with empty `content` for seq catch-up. Scope from the bearer, not a client field.

## Do not build

- Fat webhook as the retrieval API
- Homedir / project share
- Public `MORPHEUS_BASE_URL`
- One shared token + a client-supplied `namespace`

This file is the **#40** slice only. Do **not** close [#41](https://github.com/sean-lai-sh/morpheus/issues/41) from the vfs PR.
