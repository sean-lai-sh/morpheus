**SUPERSEDED by [#41](https://github.com/sean-lai-sh/morpheus/issues/41).** Nia-exit epic. Nia runtime was **removed in PR #24**. Remaining work is #41’s live slices, not this checklist.

Do **not** treat this file as the North Star. Do not implement frozen GitHub #26/#31/#33. Marker: [`PARKED.md`](PARKED.md).

## What the code actually does today (do not re-guess)

- Official `discord.js` bot (not a self-bot). Ingest-only until jobs land (#29 / PR 43).
- **SQLite is the source of truth** (`data/morpheus.db`).
- Markdown under `data/discord/{general,leadership}/` is a **local** render Morpheus writes itself.
- Nia runtime is **gone** (`src/nia/` deleted). Mini needs **zero `NIA_*` secrets**. Do not delete it again.
- Dual namespaces: `isolated: true` in `config/channels.yml` → leadership markdown dir; everything else → general.

## Live slices (parent: #41)

- [ ] **#41** product vision (locked)
- [ ] **#39** Mini host + Tailscale `tag:morpheus` (no `~` share)
- [ ] **#29** Discord mention → `jobs` (role gate, caps)
- [ ] **#37** Mini POST `{ job, snippets, first_pass: true }` (`Authorization: Bearer GROK_BOT_WEBHOOK_SECRET`)
- [ ] **#42** Grok Bot activated at `GROK_BOT_WEBHOOK_URL`
- [ ] **#40** Tailscale `/v1/fs` tree/search/read (in-repo `01-context-store.md` / `02-http-api.md`, not frozen GitHub #26/#27)
- [ ] **#30** Idempotent Discord `message.reply`
- [ ] **#36** Webhooks `#sponsors` / `#opportunities` / `#speakers` / `#inbox` (ops feed only)
- [x] **Nia deleted** (#28 — landed in PR #24)

## Constraints

- Official Discord bot only (`DISCORD_BOT_TOKEN` on the **Mac Mini**). No user-token / self-bot.
- Grok Bot gets `DISCORD_WEBHOOK_*` only. Mini gets `DISCORD_BOT_TOKEN` + `GROK_BOT_WEBHOOK_URL` + `GROK_BOT_WEBHOOK_SECRET`. Never swap those.
- HTTP uses **scoped** tokens; namespace is derived server-side. A client-supplied namespace is not auth.
- **AWS is stale / overkill.** Not Cursor VMs. Not Grok Bot’s shared computer. **No `NIA_*`.**
- Mini POSTs a **first-pass** pack; Grok **live-searches** `/v1/fs` over **Tailscale**. Homedir is **not** shared.

`NVIDIA_API_KEY` and the `openai` package are unused leftovers. Do not treat them as required.
