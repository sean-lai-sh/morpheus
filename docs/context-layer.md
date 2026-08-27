# Morpheus as a queryable context layer

**Locked vision: [#41](https://github.com/sean-lai-sh/morpheus/issues/41).** Implement that. This document is investigation + interface sketches. Do **not** implement May `agent-v1`, frozen GitHub #26/#31/#33, Nia, or poll-loop “Grok polls `/v1/jobs`”.

Nia runtime was **removed in PR [#24](https://github.com/sean-lai-sh/morpheus/pull/24)** (`074022f` on `main`). `src/nia/` is gone. Mini needs zero `NIA_*`. Do not soak-then-delete Nia again; do not restore it.

**Host (decided):** persistent **Mac Mini** on Sean's network — official Discord gateway + Morpheus **index**. **Not AWS**. **Not** a Cursor cloud-agent VM. **Not** Grok Bot's shared computer. Live Grok tools reach the index over **Tailscale only** (`tag:morpheus`, HTTP port, scoped token). `HEALTH_HOST` production = Tailscale `100.x`; loopback for local smoke. Not a homedir mount. See [`docs/hosting.md`](hosting.md).

Jobs / FTS / `/v1/fs` / mention replies are **later slices** (open PRs #43 / #44 — do not merge from a docs PR). Marker: [`docs/issues/PARKED.md`](issues/PARKED.md).

The consumer is **Cursor Grok Bot**: Discord → **Mac Mini** (thin job POST) → Grok **live-searches the Morpheus index over Tailscale**. Do not implement #15's Nia retrieval or #10's in-process mention reply.

---

## 1. Architecture map

**Today on `main` (after #24):** Discord gateway → ingest → SQLite → local markdown export. **No Nia push.**

**Target loop (thin Discord job + live index tools):**

```
 Discord  --gateway WS (out from Mini)-->  Mac Mini  tag:morpheus
                                             • official bot (DISCORD_BOT_TOKEN)
                                             • Morpheus SQLite index (club only)
                                             • no public inbound IP
                      POST GROK_BOT_WEBHOOK_URL
                      Authorization: Bearer GROK_BOT_WEBHOOK_SECRET
                                             • { job, first_pass snippets }
                      -------------------->  Grok Bot (one-shot)
                                             • if needed: Tailscale
                                               GET/POST /v1/fs/tree|search|read
                                               scoped token, index paths only
                                             • returns { reply } → Mini message.reply
                                             • incoming webhooks = #36 ops feed only
                                             • GitHub issues = implementation only
```

Do **not** run `bun run live` on Grok Bot's machine or on Cursor cloud agents. Do **not** share `~` over SSHFS/NFS/SMB.

**In-process on the Mini today:**

```
 src/bot/client.ts  ── login, intents
        │
        ├─ live:     src/crawler/live.ts
        │              ├─ src/bot/events.ts  (MessageCreate/Update/Delete, reactions)
        │              ├─ cron reconcile (every N hours)
        │              ├─ hourly auto-backfill of incomplete channels
        │              └─ nightly SQLite backup
        ├─ backfill: src/crawler/backfill.ts  (history + optional threads)
        └─ reconcile: src/crawler/reconcile.ts (last N messages vs SQLite)
                │
                ▼
        src/bot/ingest.ts
                │
                ├─ allowlist (config/channels.yml)
                ├─ hard filters (bots, too-short, pure media)
                ├─ SQLite upsert   ← SOURCE OF TRUTH
                ├─ GDrive link extract
                └─ append markdown block (local export only; not pushed to Nia)
                        │
                        ▼
              data/discord/{general|leadership}/.../*.md
```

### Entry points (`src/index.ts`)

| Command | Script | What it does |
|---|---|---|
| `live` | `bun run live` / `dev` | Gateway subscriber + `/health` + scheduled reconcile/backfill/backup. Long-running. **No Nia syncer.** |
| `backfill` | `bun run backfill` | One-shot history crawl. |
| `reconcile` | `bun run reconcile` | One-shot lookback. |
| `reindex` | `bun run reindex` | Rebuild markdown from SQLite. |
| `rotate` | `bun run rotate` | Archive old markdown. Currently only scans **flat** files under `data/discord/*.md` (legacy). Hierarchical layout from PR #6 is not rotated. |

One-shot scripts: `scripts/list-channels.ts`, `scripts/refresh-members.ts`, `scripts/post-feed.ts`. (`register-nia-source.ts` was deleted in #24.)

### How indexing is triggered

1. **Live:** `Events.MessageCreate` / `MessageUpdate` / `MessageDelete` / reaction add/remove → `ingestMessage` / `ingestDelete` / `handleReactionChange`.
2. **Backfill:** paginate `channel.messages.fetch({ before })` from `oldest_seen_id` back to channel creation; optional active + archived threads.
3. **Reconcile:** refetch last `defaults.reconcile_lookback` (default 200) messages; tombstone SQLite rows in that window that Discord no longer returns.
4. **Markdown:** every insert/edit/delete/reaction that changes stored content calls `appendBlock` → append-only `.md`. Local export only.

There is no inbound "index this URL" API. The only sources are Discord channels listed in `config/channels.yml`.

### Where artifacts land

Local (gitignored `data/`):

```
data/
  morpheus.db              SQLite source of truth (override: MORPHEUS_DB_PATH)
  backups/morpheus-*.db    nightly copy next to the live DB (honors MORPHEUS_DB_PATH)
  discord/
    general/{category?}/{channel-slug-last4}/
      main.md
      threads/{thread-slug-last4}.md
    leadership/...         channels with isolated: true
  discord-archive/         rotate() target
```

Nia remote namespaces **no longer exist in this repo**.

### How search / read works today

**Not on `main` yet.** FTS + `/v1/fs` are #40 / in-repo `docs/issues/01-context-store.md` + `02-http-api.md` (open draft PR #44). Do **not** implement from frozen GitHub #26 (poll-by-`created_at`, client namespace).

- SQLite has `messages`, `links`, `users`, `crawl_state`, `sync_state` (local dirty flags for markdown export). Queries are by id / channel / parent, not FTS.
- Markdown is append-only logs. Edits append a new `EDIT` block; deletes append a tombstone.
- `/health` reports ingest `last_message_at` (no `nia_*` fields).

---

## 2. Historical Nia coupling (removed in #24)

Do not reintroduce these. They are gone from `main`:

| Was | Status |
|---|---|
| `src/nia/client.ts`, `src/nia/syncer.ts` | **Deleted** |
| `scripts/register-nia-source.ts` | **Deleted** |
| `NIA_*` env keys | **Removed** from config / `.env.example` |
| 60s dirty-flag full-tree PUT to Nia | **Gone** |
| `/health` `nia_dirty` / `nia_last_sync_at` | **Gone** |

Leftover, unused: `NVIDIA_API_KEY` (classifier removed). `openai` may still be in `package.json` with no imports.

### What was *not* coupled to Nia (keep)

Discord gateway, ingest filters, SQLite schema for messages/links/users/crawl_state, markdown *rendering* (human export), channel allowlist + `isolated` namespace split, health server process, tests.

---

## 3. Live index (Nia already gone)

Goal: Grok Bot can **live-search the Morpheus index** (tree / grep / cat) over Tailscale, after a thin Discord job POST. No Nia. No public inbound IP. No Mini homedir share. AWS is **stale**.

SQLite is the source of truth. The markdown tree is an optional local export; it must not be the retrieval API. Nia was a derived replica and is **deleted**.

### Recommended shape

Keep ingest as-is. Add a `ContextStore` in-process (FTS5). Mini POSTs a **first-pass** snippet pack to `GROK_BOT_WEBHOOK_URL`. Grok pulls more via **vfs HTTP** (`/v1/fs/*`) on Tailscale.

```
 Discord ingest  →  SQLite (messages + fts)
                         │
                         ├── Mini POST GROK_BOT_WEBHOOK_URL  { job, first_pass }
                         │     Authorization: Bearer GROK_BOT_WEBHOOK_SECRET
                         ├── Tailscale /v1/fs/tree|search|read  (Grok live tools)
                         └── optional markdown export (no Nia push)
```

Nia runtime was **removed in PR #24**. Mini needs zero `NIA_*` secrets. Markdown export stays local (`isolated: true` → leadership).

### Interfaces (implement these; do not call Nia)

```ts
type Namespace = "general" | "leadership";

export interface IndexDocument {
  id: string;                 // Discord message snowflake
  namespace: Namespace;
  /** messages.channel_id — the thread id for thread messages, NOT the parent. */
  channelId: string;
  /** messages.parent_channel_id — parent text channel, or null. */
  parentChannelId: string | null;
  threadId: string | null;
  threadName: string | null;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;          // epoch ms (Discord create; not a poll cursor)
  editedAt: number | null;
  deletedAt: number | null;
  /** Monotonic ingest seq; bumped on upsert / edit / delete / reactions. Poll cursor. */
  seq: number;
  /** https://discord.com/channels/{guild}/{channelId}/{id} using row channel_id */
  permalink: string;
}

export interface SearchQuery {
  query: string;
  namespace: Namespace;       // REQUIRED in-process. HTTP derives this from the token.
  pathPrefix?: string;        // index path, e.g. /general/eboard-teams/sponsors-xxxx
  channelHint?: string;       // channel id or name
  threadId?: string;
  sinceMs?: number;
  untilMs?: number;
  includeDeleted?: boolean;   // default false; HTTP must reject true
  limit?: number;             // 1..50, default 10
}

export interface SearchHit {
  id: string;
  score: number;
  snippet: string;
  path: string;               // index path
  channelId: string;          // row's own channel (thread id if thread)
  parentChannelId: string | null;
  threadId: string | null;
  authorName: string;
  createdAt: number;
  permalink: string;
}

export interface PollPage {
  cursor: string;             // opaque `${seq}:${id}` — NOT created_at
  documents: IndexDocument[];
}

export interface IndexNode {
  path: string;
  kind: "dir" | "doc";
  name: string;
}

export interface ContextStore {
  index(doc: IndexDocument): void;
  search(q: SearchQuery): SearchHit[];
  readMessage(id: string, namespace: Namespace): IndexDocument | null;
  readPath(path: string, namespace: Namespace): IndexDocument | IndexNode[] | null;
  tree(path: string, namespace: Namespace): IndexNode[];
  readChannelWindow(opts: {
    namespace: Namespace;
    /** Parent/allowlisted text channel id (effectiveChannelId). Includes threads. */
    channelId: string;
    afterId?: string;
    beforeId?: string;
    limit?: number;
  }): IndexDocument[];
  poll(namespace: Namespace, cursor: string | null, limit?: number): PollPage;
}
```

`index()` is called from `ingest.ts` after upsert (same place that currently `appendBlock`s). Backfill/reindex rebuilds FTS from `messages`.

**Namespace isolation:** `isolated: true` in `channels.yml` → `leadership`. Resolve via `namespaceForRow` / `effectiveChannelId` (thread ids are not in `channels.yml`). A `general` search must not return leadership rows even on exact match. **HTTP does not take a client-chosen namespace** — see below.

### HTTP (Tailscale vfs over the index)

Bind to the **Tailscale** address (`tag:morpheus`, Morpheus port only). Grok holds `MORPHEUS_BASE_URL` (tailnet) + a **scoped** token. Public internet still has no inbound port. **Not** a homedir mount.

**Namespace is not auth.** Scoped secrets `MORPHEUS_API_TOKEN_GENERAL` / `_LEADERSHIP`. Derive namespace **server-side**. Job routes take namespace from the **job row**. Negative tests: general token cannot read `/leadership/...` even if it sends `namespace=leadership`.

| Method | Path | Tool |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/v1/fs/tree?path=` | ls / tree |
| POST | `/v1/fs/search` | grep (no `includeDeleted` on HTTP) |
| GET | `/v1/fs/read?path=` | cat |
| GET | `/v1/messages/:id` | cat by id |
| GET | `/v1/poll?cursor=` | optional seq catch-up |

Poll cursor is monotonic **`seq`**, bumped on every write (`upsertMessage` / `markDeleted` / `setReactions`). Never `created_at` (backfill, edits, and deletes would be silent). Order snowflake ids with `CAST(id AS INTEGER)`.

Do not expose raw SQL, Mini `data/` paths, `~`, or Discord tokens. Third-party egress: club Discord text leaves the Mini toward Cursor/xAI when Grok runs — snippets in the first-pass POST plus whatever Grok reads over Tailscale. Leadership isolation is necessary but not the whole privacy story; cap payloads; do not ship deleted messages.

### Why Nia is not coming back

Nia is **gone** (PR #24). Do not restore it as a query engine:

- Required `NIA_API_KEY` on every consumer.
- Markdown dump: no structured filters without parsing files.
- Full-tree PUT every 60s raced the agent ("flush Nia before every turn" in #14).
- This repo never implemented Nia search.

v1 FTS will miss some semantic paraphrases. That is acceptable; add embeddings behind `ContextStore.search` later without changing HTTP.

---

## 4. Discord as the agent entry point

The bot is already official (`discord.js` + Bot token + privileged intents). Do **not** build a self-bot / user-token client.

What exists: ingest-only gateway handlers. The bot never replies, has no slash commands, does not look at mentions (except as characters stripped in the too-short filter).

What to add: Mini POSTs a **thin** job (`first_pass` snippets) to `GROK_BOT_WEBHOOK_URL`. Grok then **live-searches the index** over Tailscale if needed. That is not agent-v1's in-process Pi agent, not a fat webhook dump, and not a Mini homedir share.

```
 User @Morpheus / hello@ / allowlisted ingest
        │
        ▼
 Mac Mini  ingest + first-pass snippets
        │
        POST GROK_BOT_WEBHOOK_URL   Authorization: Bearer GROK_BOT_WEBHOOK_SECRET
                                    { job, snippets, first_pass: true }
        ▼
 Grok Bot (one-shot)
        ├─ Tailscale /v1/fs  search | read | tree   (if first-pass isn't enough)
        ├─ returns { reply } to Mini  →  Mini message.reply  (#30, official bot)
        ├─ Discord incoming webhooks  #36 ops feed only (not the @-reply)
        └─ GitHub issue  (implementation only)
```

### Inbound (mentions → jobs)

Triggers (pure functions; reuse the intent of issue #11 without Pi):

- Message contains a mention of the bot user **and** author is not a bot.
- Message is a reply to a bot message (thread of a job).
- Author has a role in `JOB_TRIGGER_ROLE_IDS` (fail closed if unset in production).
- Channel (or thread parent) is allowlisted. Leadership vs general from `namespaceForRow` (never fail-open unknown → general).
- Outstanding-job and per-hour caps (#29).
- Trigger check is **independent** of ingest too-short drops; job `content` is the raw Discord text.

`jobs` table (sketch):

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,                 -- ulid/uuid
  discord_message_id TEXT NOT NULL UNIQUE,
  discord_channel_id TEXT NOT NULL,
  discord_thread_id TEXT,
  author_id TEXT NOT NULL,
  namespace TEXT NOT NULL,             -- general | leadership
  content TEXT NOT NULL,
  status TEXT NOT NULL,                -- queued | claimed | completed | failed | cancelled
  claimed_by TEXT,
  claimed_at INTEGER,
  result_discord_message_id TEXT,
  reply_text TEXT,                     -- persist what we posted (audit / retry)
  completion_key TEXT UNIQUE,          -- idempotent complete (Discord snowflake or hash)
  github_issue_url TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Claim is compare-and-swap (`queued` → `claimed` with a lease, e.g. 10 minutes). `claimed_by` is **mandatory** on complete/fail (409 otherwise). Expired claims return to `queued` only if no Discord send was recorded. Do **not** cancel other authors’ queued jobs in the same channel (that was #13’s in-process latest-wins and drops someone else’s question with no reply).

### Outbound

Three different outputs. Do not collapse them.

1. **Official bot reply** (`message.reply` in the Morpheus process, #30): answer the person who @mentioned the bot. Needs **Send Messages** and **Send Messages in Threads**. `allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }`. Persist `reply_text` on the job as well as `result_discord_message_id`. Make complete **idempotent** (store a completion nonce / Discord message id before retrying send).
2. **Channel incoming webhooks** (`docs/discord-webhooks.md`): operational feed for `#sponsors`, `#opportunities`, `#speakers`, and proposed `#inbox`. Grok Bot POSTs here **without GitHub**. Morning digest + time-sensitive hello@ items go here instead of opening an issue for every FYI.
3. **GitHub issues**: implementation work only. Do **not** assume Grok Bot has `gh` credentials. If GitHub is unavailable, still complete the Discord feed/reply and record `github_issue_url` as null. Allowlisted repo only; approval required; leadership GitHub default off. Do not put a PAT in this repo.

Slash commands (`/event-status`, etc.) stay in the parked `agent-v1` series (#34).

### Permissions (Discord Developer Portal)

Already required: Message Content, Server Members; View Channels + Read Message History.

**Add for mention replies (required):** Send Messages **and Send Messages in Threads**, Embed Links (optional). Thread-origin jobs fail on delivery without the threads permission. Incoming webhooks do **not** use these; they are created per channel in Integrations → Webhooks.

Restrict the bot to eboard channels at the Discord permission layer **and** via `channels.yml`.

---

## 5. Local vs server vs secrets

| Item | Where it lives | Notes |
|---|---|---|
| `DISCORD_BOT_TOKEN` | **Mac Mini** Doppler. Never git. | Official gateway. Legacy alias: `DISCORD_TOKEN`. **Not** Grok Bot. **Not** Cursor VMs. |
| `GROK_BOT_WEBHOOK_URL` | **Mac Mini** | Thin job + first-pass snippets. Not the full index. |
| `GROK_BOT_WEBHOOK_SECRET` | **Mac Mini** | Bearer for that POST. Not in the JSON body. |
| `DISCORD_WEBHOOK_*` | **Grok Bot** secret store | Incoming webhooks for `#sponsors` / `#opportunities` / `#speakers` / `#inbox`. |
| `DISCORD_GUILD_ID` | Mini | Snowflake. Don't commit real `channels.yml`. |
| `MORPHEUS_API_TOKEN_GENERAL` / `_LEADERSHIP` | Mini + Grok (matching scope) | Tailscale `/v1/fs`. Namespace from which secret matched. |
| `MORPHEUS_BASE_URL` | **Grok Bot** | Tailnet URL of Mini Morpheus HTTP. Not public. |
| `HEALTH_HOST` | Mini | Production: Tailscale `100.x`. Local smoke: `127.0.0.1`. Never `0.0.0.0`. |
| `NIA_*` | **gone** | Removed in PR #24. Do not set. |
| `NVIDIA_API_KEY` | leftover | Unused. Drop. |
| SQLite | Mini disk | Club messages. **Not** a network filesystem share. |
| Gateway + Morpheus | **Mac Mini**, always-on | Outbound Discord + Tailscale index HTTP. **AWS/Fly stale.** |
| Homedir / personal projects | Mini only | **Off** the Morpheus index and off Tailscale file shares. |

Single-process SQLite is fine for one bot replica. Multiple ingest replicas would need Postgres; do not split until you have to.

---

## 6. Stale or conflicting GitHub issues

**Do not implement from these**, even if GitHub still shows OPEN (close often 403s). Full list: [`docs/issues/PARKED.md`](issues/PARKED.md). Owner paste: [`docs/issues/38-owner-close-stale.md`](issues/38-owner-close-stale.md).

| Issue | Status vs current main |
|---|---|
| **#41** | **Locked vision. Start here.** |
| #1 `ready` → `clientReady` | Still valid. Tiny fix in `src/bot/client.ts`. |
| #4 `--channel` backfill flag | Still valid, independent. |
| #2 backup after Nia sync | Moot. Nia gone. Nightly backup already in `live.ts`. |
| #3 schedule reconcile | **Done** in `src/crawler/live.ts`. |
| #5 thread attribution | **Done** in PR #6. |
| #9 Nia-index pi-mono | Closed. Do not revive Nia. |
| #10–#22 May agent-v1 | **Do not implement** (Pi / Nia / sandbox). |
| #25–#28, #31–#35, #38 | Done or superseded by #41. Frozen #26/#31/#33 bodies are not the contract. |

Live slices: #39 #29 #37 #42 #40 #36 #30.

Issue drafts live in [`docs/issues/`](issues/). Canonical: **#41**, not epic #25.

## 7. Implementation order (parent: #41)

Nia is **gone**. AWS/Fly as host is stale. Do **not** start frozen GitHub #26/#27/#31. ContextStore spec is in-repo `docs/issues/01-context-store.md`.

1. **#39** Mini host: launchd, Doppler, Tailscale `tag:morpheus`, `HEALTH_HOST` = `100.x` in production.
2. **#29** mention → jobs (role gate, caps). `/cmd` is in-product (#41); mentions may ship first.
3. **#37** Mini POST **first-pass** with `Authorization: Bearer GROK_BOT_WEBHOOK_SECRET`.
4. **#42** Grok Bot **activated** at `GROK_BOT_WEBHOOK_URL`.
5. **#40** Tailscale vfs `/v1/fs/tree|search|read` (in-repo FTS + HTTP docs; not frozen #26/#27).
6. **#30** idempotent official-bot `message.reply`.
7. **#36** Discord incoming webhooks (ops feed only, not @-replies).

**#35** `/v1/events` waits until an events table exists on main (PR #23 closed unmerged). GitHub issues are optional implementation-only, fail open — **not** how Grok receives work.

Locked vision: [#41](https://github.com/sean-lai-sh/morpheus/issues/41). Markdown export (`appendBlock`) stays as a local dump; do not build new retrieval on it.
