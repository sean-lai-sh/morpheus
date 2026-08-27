Parent: #25 / #33 / #39. GitHub issue **#40**. HTTP shape: `docs/issues/02-http-api.md`. Host: `docs/hosting.md`.

## Goal

Grok Bot (and the Discord-side consumer) has **live search** over the Morpheus **index**, with filesystem-like freedom: **tree/ls**, **grep**, **cat/read**. This is **not** a mount of the Mac Mini homedir or personal projects.

## Consumer contract (lock this)

**Live tools, not a fat-job-only model.**

1. Mini **POSTs** the Discord ping + a **first-pass** snippet pack to `GROK_BOT_WEBHOOK_URL` so Grok has something immediately (`first_pass: true`, already capped).
2. If that is not enough, Grok **pulls more** over Tailscale: `search` / `read` / `tree` on **index paths**.
3. Do **not** stuff the webhook with “the whole channel / whole index”. Pre-retrieve-everything is **not** the primary path.

## Index paths (virtual)

Paths name **indexed club context**, never OS files:

```
/general/{category}/{channel-slug}/
/general/{category}/{channel-slug}/threads/{thread-slug}/
/leadership/...
```

- `..`, `/Users/…`, `~/…`, absolute Unix paths → **404**
- Markdown under `data/discord/` is a local Nia-era export, not the VFS
- Personal Mini repos stay off this API

## Access

Tailscale only (`tag:morpheus`, Morpheus HTTP port, scoped token). No SSH. No NFS/SMB/SSHFS. Public internet still has **no** inbound Morpheus port.

Grok holds `MORPHEUS_BASE_URL` (tailnet) + `MORPHEUS_API_TOKEN_GENERAL` or `_LEADERSHIP`. Mini never puts those in the Discord webhook body.

## Tools

| Tool | HTTP | Meaning |
|---|---|---|
| ls / tree | `GET /v1/fs/tree?path=` | list children of an index path |
| grep | `POST /v1/fs/search` | FTS / filters; namespace from token |
| cat | `GET /v1/fs/read?path=` | read one virtual doc (message or channel window) |

`includeDeleted` default **deny** on HTTP. Namespace from the bearer, not a client field.

## Do not build

- Fat webhook as the retrieval API
- Homedir / project share
- Public `MORPHEUS_BASE_URL`
- One shared token + `namespace=leadership`
