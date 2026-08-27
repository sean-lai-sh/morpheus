# Audit: issues & PRs vs Discord → Morpheus → Grok Bot

**Locked vision: [#41](https://github.com/sean-lai-sh/morpheus/issues/41).** This file is a 2026-08 investigation snapshot. Implement #41, not May agent-v1, not frozen GitHub #26/#31/#33, not Nia.

Consumer: **Cursor Grok Bot**. **Host = Mac Mini** ([`docs/hosting.md`](hosting.md)). Mini POSTs a **thin** `{ job, first_pass snippets }` to `GROK_BOT_WEBHOOK_URL` (`Authorization: Bearer GROK_BOT_WEBHOOK_SECRET`). Grok then **live-searches the Morpheus index** over Tailscale (`/v1/fs` tree/grep/cat) and **returns `{ reply }`**. Mini posts the @-reply with discord.js `message.reply`. Incoming webhooks are **#36 ops feed only**, not conversational replies. Index paths only — **not** the Mini homedir.

**Stale:** fat-job-only retrieval. **Stale:** Grok polling Mini `/v1` over the **public internet**. **Stale:** AWS/Fly as the 24/7 host. **Stale:** SSHFS/NFS/SMB of `~`. **Stale:** soak-then-delete Nia (already deleted). **Stale:** running `bun run live` on Cursor cloud-agent VMs or on Grok Bot’s shared computer.

This is **not**:

- A local Nia / `data/discord` dump that a human or laptop agent `ls`s
- `nia-cli` as the retrieval API
- An in-process Pi/Claude agent (`@mariozechner/pi-agent-core`) living inside `bun run live`

Nia runtime was **removed in squash-merged PR [#24](https://github.com/sean-lai-sh/morpheus/pull/24)** (`074022f` on `main`). `src/nia/` is gone. Mini boots with zero `NIA_*`.

---

## Target loop

```
 Tech@NYU Discord  --official bot token-->  Mac Mini (Morpheus, 24/7, tag:morpheus)
        │                                         |
        │                                         | POST GROK_BOT_WEBHOOK_URL
        │                                         | Authorization: Bearer GROK_BOT_WEBHOOK_SECRET
        │                                         | { job, first_pass snippets }
        │                                         v
        │                                   Grok Bot (one-shot consumer)
        │                                         |
        │                    Tailscale /v1/fs     |  (search / read / tree)
        │                    scoped token         |
        │                    returns { reply }    |
        │                                         v
        +----- Mini message.reply (official bot) -+
              Incoming webhooks = #36 ops feed only
              GitHub issues = implementation only
```

**Breaking change vs agent-v1 (#10–#22):** mention does **not** call `runAgentTurn` in-process. Mention enqueues a **job**. Grok Bot is the model.

**Breaking change vs Nia-index-overhaul (PR #6):** Nia push was **removed in #24**. Local markdown export remains. Retrieval is live Tailscale vfs over SQLite (plus a thin first-pass webhook).

---

## PRs (as of this cleanup)

| PR | State | Notes |
|---|---|---|
| [#24](https://github.com/sean-lai-sh/morpheus/pull/24) | **Merged** (`074022f`) | Nia runtime deleted. Mini + Grok Bot consumer docs. |
| [#23](https://github.com/sean-lai-sh/morpheus/pull/23) | **Closed without merge** | Events table + sandbox image. #35 waits until events exist on main. Do not implement `/v1/events` yet. |
| [#6](https://github.com/sean-lai-sh/morpheus/pull/6) | Merged | Hierarchical markdown. Nia dump half is gone. |
| [#43](https://github.com/sean-lai-sh/morpheus/pull/43) | Open | Jobs path. **Do not merge from a docs cleanup.** |
| [#44](https://github.com/sean-lai-sh/morpheus/pull/44) | Open draft | Live vfs. **Do not merge from a docs cleanup.** Do not implement from frozen GitHub #26. |

---

## Issues — keep / park / superseded

**Keep (live, parent #41):** #41 #42 #40 #39 #37 #36 #30 #29. Tiny ops: #1 `clientReady`, #4 `--channel` backfill.

**Superseded / done / parked — do not implement:** see [`docs/issues/PARKED.md`](issues/PARKED.md). Owner paste: [`docs/issues/38-owner-close-stale.md`](issues/38-owner-close-stale.md).

Do **not** implement #10 / #13 / #15 / #19 / frozen #26 / poll-loop #31. Do not add `ANTHROPIC_API_KEY` / `AGENT_MODEL` / pi-agent-core to the MVP path.

---

## What Grok Bot slices assume

1. **Official Discord bot** (`discord.js` + `DISCORD_BOT_TOKEN` on the **Mac Mini** only). No self-bot.
2. Mini POSTs a **first-pass** pack to `GROK_BOT_WEBHOOK_URL` with bearer `GROK_BOT_WEBHOOK_SECRET`. Grok **live-searches** `/v1/fs` over **Tailscale**.
3. Grok **returns `{ reply }`**; Mini `message.reply`s. Incoming webhooks are **#36 ops feed only**.
4. Vision: [#41](https://github.com/sean-lai-sh/morpheus/issues/41). Marker: [`PARKED.md`](issues/PARKED.md).
