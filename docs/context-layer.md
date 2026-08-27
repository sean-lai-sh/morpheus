# Morpheus as a queryable context layer

Investigation of https://github.com/sean-lai-sh/morpheus (main @ `291a3ef`, after PR #6 `nia-index-overhaul`). This document is the source of truth for the Nia-exit and Discord-entry work. It is based on the current tree, not on earlier guesses.

**Filed issues:** tracking [#25](https://github.com/sean-lai-sh/morpheus/issues/25) · Grok Bot [#33](https://github.com/sean-lai-sh/morpheus/issues/33) · webhooks [#36](https://github.com/sean-lai-sh/morpheus/issues/36) · park agent-v1 [#34](https://github.com/sean-lai-sh/morpheus/issues/34). Analysis PR: [#24](https://github.com/sean-lai-sh/morpheus/pull/24).

**Corrections vs. the investigation brief**

| Guess | What the code actually does |
|---|---|
| Morpheus is a generic partial-indexing tool | It is a **Tech@NYU eboard Discord ingest bot**. It crawls allowlisted channels into SQLite, renders markdown, and (optionally) pushes that markdown to Nia. |
| Nia dumps artifacts onto a local filesystem that Morpheus then reads | **Inverted.** Morpheus writes `data/discord/**/*.md` itself, then **pushes** those files to Nia's remote filesystem API. Nothing in this repo searches or reads Nia. |
| Runtime depends on `nia-cli` | **No.** There is no `nia-cli` dependency. Indexing uses `fetch` against `https://apigcp.trynia.ai/v2` in `src/nia/client.ts`. `nia` CLI appears only as a *human* research step in closed issue #9. |
| Discord is a future entry point | Discord is **already** the ingest entry point (official `discord.js` bot, not a self-bot). What is missing is mention→job, replies, and GitHub issue posting. |
| Search/read of indexed artifacts lives here | **Not implemented.** Planned in open issue #15 as "SQLite FTS + Nia search", which this plan supersedes. |

Existing `agent-v1` issues (#7–#22) assume an **in-process Pi/Claude agent** (`@mariozechner/pi-agent-core`) that still queries Nia. The consumer is now **Cursor Grok Bot** (Tech@NYU), via Discord → Morpheus HTTP → Grok Bot. Audit of every open PR/issue: [`docs/grok-bot-audit.md`](grok-bot-audit.md). Do not implement #15's Nia retrieval path or #10's in-process mention reply.

---

## 1. Architecture map

```
 Discord Gateway (official bot token)
        │
        ▼
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
                └─ append markdown block + mark dirty
                        │
                        ▼
              data/discord/{general|leadership}/.../*.md
                        │
                        ▼  60s dirty-flag poll (live) or flushNow (backfill/reconcile/shutdown)
              src/nia/syncer.ts → PUT /fs/{id}/files
                        │
                        ▼
              Nia remote namespaces (semantic search happens *outside this repo*)
```

### Entry points (`src/index.ts`)

| Command | Script | What it does |
|---|---|---|
| `live` | `bun run live` / `dev` | Gateway subscriber + Nia syncer + `/health` + scheduled reconcile/backfill/backup. Long-running. |
| `backfill` | `bun run backfill` | One-shot history crawl, then `flushNow()` to Nia. |
| `reconcile` | `bun run reconcile` | One-shot lookback, then Nia flush. |
| `reindex` | `bun run reindex` | Rebuild markdown from SQLite. Does **not** push to Nia by itself (dirty flag is set; live syncer or a later flush would). |
| `rotate` | `bun run rotate` | Archive old markdown. Currently only scans **flat** files under `data/discord/*.md` (legacy). Hierarchical layout from PR #6 is not rotated. |

One-shot scripts: `scripts/register-nia-source.ts`, `scripts/list-channels.ts`, `scripts/refresh-members.ts`.

### How indexing is triggered

1. **Live:** `Events.MessageCreate` / `MessageUpdate` / `MessageDelete` / reaction add/remove → `ingestMessage` / `ingestDelete` / `handleReactionChange`.
2. **Backfill:** paginate `channel.messages.fetch({ before })` from `oldest_seen_id` back to channel creation; optional active + archived threads.
3. **Reconcile:** refetch last `defaults.reconcile_lookback` (default 200) messages; tombstone SQLite rows in that window that Discord no longer returns.
4. **Markdown:** every insert/edit/delete/reaction that changes stored content calls `appendBlock` → append-only `.md` + `markDirty(GENERAL_DIR|LEADERSHIP_DIR)`.
5. **Nia:** `startSyncer()` in live mode polls every 60s; if dirty, **pushes every `.md` file in the tree** (not a delta). `flushNow()` after backfill/reconcile and on shutdown.

There is no inbound "index this URL" API. The only sources are Discord channels listed in `config/channels.yml`.

### Where artifacts land

Local (gitignored `data/`):

```
data/
  morpheus.db              SQLite source of truth (override: MORPHEUS_DB_PATH)
  backups/morpheus-*.db    nightly copy (03:17); also intended after Nia sync (#2, not wired)
  discord/
    general/{category?}/{channel-slug-last4}/
      main.md
      threads/{thread-slug-last4}.md
    leadership/...         channels with isolated: true
  discord-archive/         rotate() target — not registered with Nia
```

Nia (remote):

- Namespace `morpheus-discord-general` ← `NIA_DISCORD_SOURCE_ID`
- Namespace `morpheus-discord-leadership` ← `NIA_DISCORD_LEADERSHIP_SOURCE_ID`
- Paths inside a namespace are relative to `GENERAL_DIR` / `LEADERSHIP_DIR` (e.g. `eboard-teams/leadership-team-1234/main.md`).

### How search / read works today

**It doesn't, in this repo.**

- SQLite has `messages`, `links`, `users`, `crawl_state`, `nia_sync_state`. Queries are by id / channel / parent, not FTS.
- Markdown is append-only logs for Nia to embed. Edits append a new `EDIT` block; deletes append a tombstone. `reindex` cannot replay original-then-EDIT history because SQLite keeps only latest content.
- `src/nia/client.ts` implements `POST /fs`, `PUT /fs/{id}/files`, `DELETE /fs/{id}/files`. `GET /fs` is mentioned in a comment and **not implemented**. There is no search, query, or read-file client.
- `/health` reports `nia_dirty` / `nia_last_sync_at` / `nia_consecutive_failures` by reading `nia_sync_state` for `DISCORD_DIR` (`data/discord`). The syncer dirty flags are on `GENERAL_DIR` and `LEADERSHIP_DIR`. Health is looking at the **wrong row** and will not reflect real sync state.

---

## 2. Nia-specific coupling (complete)

### Code

| Location | Coupling |
|---|---|
| `src/nia/client.ts` | REST client. Hardcoded fallback base `https://apigcp.trynia.ai/v2`. Requires `NIA_API_KEY`. |
| `src/nia/syncer.ts` | 60s poll, full-tree `pushFile`, maps dirs → `NIA_DISCORD_SOURCE_ID` / `NIA_DISCORD_LEADERSHIP_SOURCE_ID`. |
| `scripts/register-nia-source.ts` | `POST /fs`, then `doppler secrets set` for the two source IDs. `--force` abandons old namespaces. |
| `src/index.ts` | `startSyncer` / `stopSyncer` / `flushNow` on live, backfill, reconcile, shutdown. |
| `src/storage/db.ts` | Table `nia_sync_state(folder_path, last_sync_at, dirty, consecutive_failures)`. |
| `src/storage/sync-state.ts` | Dirty-flag helpers keyed by **local folder path**. |
| `src/storage/markdown.ts` | `GENERAL_DIR` / `LEADERSHIP_DIR`; `appendBlock` / `rerenderChannel` call `markDirty`. Written for Nia, but the files are local. |
| `src/http/health.ts` | Exposes Nia sync fields (wrong folder key; see above). |
| `src/tasks/rotate.ts` | Comment: archive is "NOT registered with Nia". Implementation is stale vs hierarchical layout. |
| `src/config.ts` | `NIA_API_KEY`, `NIA_BASE_URL` (zod default `https://api.trynia.ai` — **different host and no `/v2` vs client.ts**), `NIA_DISCORD_SOURCE_ID`, `NIA_DISCORD_LEADERSHIP_SOURCE_ID`. |
| `src/bot/ingest.ts` | Comments: "NIA indexes all content at query time"; always `setClassification(..., "operational")`. |
| `package.json` | Script `register-nia`. |

### Env / Doppler (from `.env.example` + code; do not invent values)

Required for any Discord command: `DISCORD_TOKEN`, `DISCORD_GUILD_ID`.

Nia (all optional at process boot; sync no-ops with a warning if source IDs missing):

- `NIA_API_KEY`
- `NIA_BASE_URL` (README: `https://apigcp.trynia.ai/v2`)
- `NIA_DISCORD_SOURCE_ID` (written by `register-nia`; listed in `.env.example`)
- `NIA_DISCORD_LEADERSHIP_SOURCE_ID` (written by `register-nia`; **missing from `.env.example`**)

Leftover, unused in source: `NVIDIA_API_KEY` (classifier removed; `db.ts` drops `classification_queue`). `openai` is in `package.json` with no imports.

Runtime: `LOG_LEVEL`, `HEALTH_PORT`, `RETENTION_MONTHS`, `NODE_ENV`, `MORPHEUS_DB_PATH`.

### Assumed local folders

- `config/channels.yml` (gitignored; copy from `config/channels.example.yml`)
- `data/discord/general`, `data/discord/leadership`
- `data/morpheus.db` (+ WAL)
- `data/backups/`, `data/discord-archive/`
- Doppler CLI on the machine that runs `register-nia` / `bun run *` scripts (`doppler run --` wrappers)

### What is *not* coupled to Nia (keep)

Discord gateway, ingest filters, SQLite schema for messages/links/users/crawl_state, markdown *rendering* (useful as a human export), channel allowlist + `isolated` namespace split, health server process, tests.

---

## 3. Migration off Nia

Goal: a remote Discord bot / Cursor agent can **index, search, read, and poll** without a local `data/discord` dump or a Nia account.

SQLite is already the source of truth. Nia is a derived, lossy, full-tree replica. The markdown tree can remain as an optional export; it must not be the retrieval API.

### Recommended shape

Keep ingest as-is. Add a `ContextStore` in-process, served over HTTP from the same `Bun.serve` that already hosts `/health`. v1 retrieval is **SQLite FTS5 + structured filters**. Optional embeddings later (sqlite-vec or a hosted embed API) behind the same interface — do not block Discord entry on a vector vendor.

```
 Discord ingest  →  SQLite (messages + fts)  →  HTTP /v1/*  →  Cursor/Grok agent
                         │
                         └── optional markdown export (no Nia push)
```

Feature-flag the Nia syncer (`NIA_SYNC_ENABLED=false` default once the API exists), then delete `src/nia/` and `register-nia`.

### Interfaces (implement these; do not call Nia)

```ts
type Namespace = "general" | "leadership";

export interface IndexDocument {
  id: string;                 // Discord message snowflake
  namespace: Namespace;
  channelId: string;          // parent text channel for threads
  threadId: string | null;
  threadName: string | null;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;          // epoch ms
  editedAt: number | null;
  deletedAt: number | null;
}

export interface SearchQuery {
  query: string;
  namespace: Namespace;       // REQUIRED. Never search across namespaces.
  channelHint?: string;       // channel id or name
  threadId?: string;
  sinceMs?: number;
  untilMs?: number;
  includeDeleted?: boolean;   // default false
  limit?: number;             // 1..50, default 10
}

export interface SearchHit {
  id: string;
  score: number;
  snippet: string;
  channelId: string;
  threadId: string | null;
  authorName: string;
  createdAt: number;
}

export interface PollPage {
  cursor: string;             // opaque; v1 = last seen indexed_at/change_seq + id
                              // NOT created_at — edits/deletes must still poll out
  documents: IndexDocument[];
}

export interface ContextStore {
  index(doc: IndexDocument): void;
  search(q: SearchQuery): SearchHit[];
  readMessage(id: string, namespace: Namespace): IndexDocument | null;
  readChannelWindow(opts: {
    namespace: Namespace;
    channelId: string;
    afterId?: string;
    beforeId?: string;
    limit?: number;
  }): IndexDocument[];
  poll(namespace: Namespace, cursor: string | null, limit?: number): PollPage;
}
```

`index()` is called from `ingest.ts` after upsert (same place that currently `appendBlock`s). Backfill/reindex rebuilds FTS from `messages`.

**Namespace isolation:** `isolated: true` in `channels.yml` → `leadership`. A `general` search must not return leadership rows even on exact match. This is the same split Nia namespaces enforced by directory, now enforced by a column / join on channel config.

### HTTP (same process as the bot)

Auth: `Authorization: Bearer ${MORPHEUS_API_TOKEN}`. Unauthenticated `/health` may stay public but must **not** include message bodies or tokens.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + ingest freshness (`last_message_at`, crawl gaps). Drop Nia fields once unused. |
| POST | `/v1/search` | body = `SearchQuery` |
| GET | `/v1/messages/:id?namespace=` | read one message; 404 if wrong namespace |
| GET | `/v1/channels/:channelId/messages` | windowed read (`after`, `before`, `limit`, `namespace`) |
| GET | `/v1/poll?namespace=&cursor=&limit=` | incremental catch-up for agents |

Do not expose raw SQL, `data/` paths, or Discord tokens over this API.

### Why not keep Nia as the query engine

- Requires `NIA_API_KEY` on every consumer (Discord bot, Cursor agent, laptop).
- Index is a markdown dump: no structured filters (channel, thread, time) without parsing files.
- Full-tree PUT every 60s does not scale and races the agent ("flush Nia before every turn" in #14).
- Default URL mismatch (`api.trynia.ai` vs `apigcp.trynia.ai/v2`) is already a footgun.
- This repo never implemented Nia search; wiring it now is new work on a vendor we are leaving.

v1 FTS will miss some semantic paraphrases. That is acceptable; add embeddings behind `ContextStore.search` later without changing HTTP.

---

## 4. Discord as the agent entry point

The bot is already official (`discord.js` + Bot token + privileged intents). Do **not** build a self-bot / user-token client.

What exists: ingest-only gateway handlers. The bot never replies, has no slash commands, does not look at mentions (except as characters stripped in the too-short filter).

What to add: Discord I/O + a **job queue the Cursor/Grok agent polls**. That is different from agent-v1's in-process Pi agent (#10–#13). You can still add an in-process LLM later; the queue is the contract.

```
 User @Morpheus in Tech@NYU
        │
        ▼
 events.ts  (mention / reply-to-bot, allowlisted channel, not a bot author)
        │
        ▼
 jobs table  status=queued
        │
        ├─ Cursor/Grok polls GET /v1/jobs
        ├─ POST /v1/jobs/:id/claim
        ├─ uses /v1/search and /v1/messages for context
        └─ POST /v1/jobs/:id/complete { reply, githubIssue? }
                │
                ├─ bot posts a Discord reply (outbound)
                └─ optional: bot or agent opens a GitHub issue
```

### Inbound (mentions → jobs)

Triggers (pure functions; reuse the intent of issue #11 without Pi):

- Message contains a mention of the bot user **and** author is not a bot.
- Message is a reply to a bot message (thread of a job).
- Ignore if channel is not allowlisted (`isChannelAllowed`). Leadership vs general is recorded on the job, not mixed.

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

Claim is compare-and-swap (`queued` → `claimed` with a lease, e.g. 10 minutes). Expired claims return to `queued`. Newest mention in the same channel can mark an older `queued` job `cancelled` (same "latest wins" idea as #13, without in-process AbortController).

### Outbound

Three different outputs. Do not collapse them.

1. **Official bot reply** (`message.reply` in the Morpheus process, #30): answer the person who @mentioned the bot. Needs **Send Messages** and **Send Messages in Threads**. `allowedMentions: { parse: [] }`. Persist `reply_text` on the job as well as `result_discord_message_id`. Make complete **idempotent** (store a completion nonce / Discord message id before retrying send).
2. **Channel incoming webhooks** (`docs/discord-webhooks.md`): operational feed for `#sponsors`, `#opportunities`, `#speakers`, and proposed `#inbox`. Grok Bot POSTs here **without GitHub**. Morning digest + time-sensitive hello@ items go here instead of opening an issue for every FYI.
3. **GitHub issues**: implementation work only. Do **not** assume Grok Bot has `gh` credentials in every environment; if GitHub is unavailable, still complete the Discord feed/reply and record `github_issue_url` as null. Do not put a PAT in this repo.

Slash commands (`/event-status`, etc.) stay in the parked `agent-v1` series (#34).

### Permissions (Discord Developer Portal)

Already required: Message Content, Server Members; View Channels + Read Message History.

**Add for mention replies:** Send Messages, **Send Messages in Threads**, Embed Links (optional). Incoming webhooks do **not** use these; they are created per channel in Integrations → Webhooks.

Restrict the bot to eboard channels at the Discord permission layer **and** via `channels.yml`.

---

## 5. Local vs server vs secrets

| Item | Where it lives | Notes |
|---|---|---|
| `DISCORD_TOKEN` | Persistent Morpheus host env (Doppler). Never git. | Gateway only. **Not** Grok Bot, **not** a Cursor cloud-agent VM (those exit). |
| `DISCORD_WEBHOOK_*` | Grok Bot secret store and/or Morpheus Doppler | Incoming webhook URLs for `#sponsors` / `#opportunities` / `#speakers` / `#inbox`. Token is in the URL path. |
| `DISCORD_GUILD_ID` | Morpheus host env | Snowflake, not a secret, but don't commit the real `channels.yml`. |
| `NIA_*` | Doppler today | Remove after cutover. Do not add to Grok Bot env. |
| `NVIDIA_API_KEY` | Doppler leftover | Unused. Drop; do not document as required. |
| `MORPHEUS_API_TOKEN` | Morpheus host. Prefer **scoped** tokens (`general` vs `leadership`) rather than one token plus a client-supplied namespace. | Namespace is **not** auth. Derive from the credential; negative tests for cross-scope reads. |
| SQLite + WAL | Persistent volume on the Morpheus host | Club message text. Not public. Not in git. |
| Gateway process | **Persistent host** (always-on). Not a Cursor cloud-agent VM. | Discord gateway outbound WebSocket. |
| Grok Bot | Ephemeral consumer | Posts to **incoming webhooks** for FYIs; GitHub only for implementation. Does not host Morpheus. |

Single-process SQLite is fine for one bot replica. Multiple ingest replicas would need Postgres; do not split until you have to.

---

## 6. Stale or conflicting open issues

Implementers should not blindly follow these:

| Issue | Status vs current main |
|---|---|
| #1 `ready` → `clientReady` | Still valid. Tiny fix in `src/bot/client.ts`. |
| #2 backup after Nia sync | Backup already runs nightly in `live.ts`. Wiring to Nia sync is moot if Nia is removed; backup after successful FTS index flush is the replacement. |
| #3 schedule reconcile | **Done** in `src/crawler/live.ts` (`0 */N * * *`). Close it. |
| #4 `--channel` backfill flag | Still valid, independent. |
| #5 thread attribution in markdown | **Mostly done** in PR #6 (`thread_id` / `thread_name`, separate thread files). Close or shrink. |
| #9 Nia-index pi-mono | Closed research; used `nia` CLI. Do not revive Nia indexing. |
| #14 resumeBackfill + Nia flush | Catch-up pagination is still useful; **drop** `flushNamespace` / Nia dirty. |
| #15 `search_discord` via Nia | **Superseded** by ContextStore FTS. Keep namespace isolation + freshness. |
| #10–#13, #16–#22 | In-process Pi agent / Drive / events / sandbox. Orthogonal. Do not block Nia-exit on them. If Cursor/Grok-via-queue ships, #10's mention handler must not fight the job queue. |

---

Issue drafts (same text filed on GitHub) live in [`docs/issues/`](issues/). Tracking epic: **#25**. PR: **#24**.

## 7. Implementation order (one cutover sequence)

Do **not** delete Nia (#28) until search HTTP is serving Grok Bot. Order:

1. **#26** ContextStore + FTS5 (poll cursor = monotonic `indexed_at` / change seq, not `created_at` — edits/deletes must appear).
2. **#27** HTTP `/v1` with **scoped** credentials (namespace derived server-side).
3. **#29** mention → jobs.
4. **#30** claim/complete + idempotent bot replies.
5. **Webhooks** (`docs/discord-webhooks.md`) — operational feed; can land in parallel with 3–4.
6. **#31** GitHub issues **only** for implementation; optional; fail open if `gh` is missing.
7. **#28 last** — flag off Nia, soak, then delete `src/nia/`.

Markdown export (`appendBlock`) can stay until #28 so a rollback to Nia is possible; do not build new retrieval on it.
