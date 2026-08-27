# Morpheus as a queryable context layer

Investigation of https://github.com/sean-lai-sh/morpheus (main @ `291a3ef`, after PR #6 `nia-index-overhaul`). This document is the source of truth for the Nia-exit and Discord-entry work. It is based on the current tree, not on earlier guesses.

**Host (decided):** persistent **Mac Mini** on Sean's network — official Discord gateway + Morpheus **index**. **Not AWS**. **Not** a Cursor cloud-agent VM. **Not** Grok Bot's shared computer. Live Grok tools reach the index over **Tailscale only** (`tag:morpheus`, HTTP port, scoped token). Not a homedir mount. See [`docs/hosting.md`](hosting.md).

**This PR (#24) removes the Nia runtime (`src/nia/` gone; Mini needs zero `NIA_*`) plus investigation + hosting/webhook docs + `src/notify` ops-feed helpers.** Do not implement jobs enqueue, FTS ContextStore, `/v1/fs`, or mention replies here — sibling PRs take those slices. Locked vision: [#41](https://github.com/sean-lai-sh/morpheus/issues/41).

**Corrections vs. the investigation brief**

| Guess | What the code actually does |
|---|---|
| Morpheus is a generic partial-indexing tool | It is a **Tech@NYU eboard Discord ingest bot**. It crawls allowlisted channels into SQLite, renders markdown, and (optionally) pushes that markdown to Nia. |
| Nia dumps artifacts onto a local filesystem that Morpheus then reads | **Inverted.** Morpheus writes `data/discord/**/*.md` itself, then **pushes** those files to Nia's remote filesystem API. Nothing in this repo searches or reads Nia. |
| Runtime depends on `nia-cli` | **No.** There is no `nia-cli` dependency. Indexing uses `fetch` against `https://apigcp.trynia.ai/v2` in `src/nia/client.ts`. `nia` CLI appears only as a *human* research step in closed issue #9. |
| Discord is a future entry point | Discord is **already** the ingest entry point (official `discord.js` bot, not a self-bot). What is missing is mention→job, replies, and GitHub issue posting. |
| Search/read of indexed artifacts lives here | **Not implemented.** Planned in open issue #15 as "SQLite FTS + Nia search", which this plan supersedes. |

Existing `agent-v1` issues (#7–#22) assume an **in-process Pi/Claude agent** (`@mariozechner/pi-agent-core`) that still queries Nia. The consumer is now **Cursor Grok Bot** (Tech@NYU): Discord → **Mac Mini** (thin job POST) → Grok **live-searches the Morpheus index over Tailscale**. Audit: [`docs/grok-bot-audit.md`](grok-bot-audit.md). Hosting: [`docs/hosting.md`](hosting.md). Do not implement #15's Nia retrieval path or #10's in-process mention reply. Do not mount the Mini homedir.

---

## 1. Architecture map

**Today (code on Mini once deployed):** Discord gateway → ingest → SQLite → optional Nia push.

**Target loop (thin Discord job + live index tools):**

```
 Discord  --gateway WS (out from Mini)-->  Mac Mini  tag:morpheus
                                             • official bot (DISCORD_BOT_TOKEN)
                                             • Morpheus SQLite index (club only)
                                             • no public inbound IP
                      POST GROK_BOT_WEBHOOK_URL
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
                └─ append markdown block + mark dirty
                        │
                        ▼
              data/discord/{workspace}/.../*.md
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
  backups/morpheus-*.db    nightly copy next to the live DB (honors MORPHEUS_DB_PATH; not hardcoded data/)
  discord/
    {workspace}/{category?}/{channel-slug-last4}/
      main.md
      threads/{thread-slug-last4}.md
  discord-archive/         rotate() target
```

Nia (remote): **Nia is gone.**

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

Required for any Discord command (Mini only): `DISCORD_BOT_TOKEN` (legacy alias `DISCORD_TOKEN`), `DISCORD_GUILD_ID`. Mini outbound to Grok: `GROK_BOT_WEBHOOK_URL`. Never on Grok Bot; never in git.

Nia (all optional at process boot; sync no-ops with a warning if source IDs missing):

- `NIA_API_KEY`
- `NIA_BASE_URL` (README: `https://apigcp.trynia.ai/v2`)
- `NIA_DISCORD_SOURCE_ID` (written by `register-nia`; listed in `.env.example`)
- `NIA_DISCORD_LEADERSHIP_SOURCE_ID` (written by `register-nia`; **missing from `.env.example`**)

Leftover, unused in source: `NVIDIA_API_KEY` (classifier removed; `db.ts` drops `classification_queue`). `openai` is in `package.json` with no imports.

Runtime: `LOG_LEVEL`, `HEALTH_PORT`, `RETENTION_MONTHS`, `NODE_ENV`, `MORPHEUS_DB_PATH`.

### Assumed local folders

- `config/channels.yml` (gitignored; copy from `config/channels.example.yml`)
- `data/discord/{workspace}` (one directory per configured workspace id)
- `data/morpheus.db` (+ WAL)
- `data/backups/`, `data/discord-archive/`
- Doppler CLI on the machine that runs `register-nia` / `bun run *` scripts (`doppler run --` wrappers)

### What is *not* coupled to Nia (keep)

Discord gateway, ingest filters, SQLite schema for messages/links/users/crawl_state, markdown *rendering* (useful as a human export), channel allowlist + hierarchical workspace scoping, health server process, tests.

---

## 3. Migration off Nia

Goal: Grok Bot can **live-search the Morpheus index** (tree / grep / cat) over Tailscale, after a thin Discord job POST. No Nia account. No public inbound IP. No Mini homedir share. AWS is **stale**.

SQLite is already the source of truth. Nia is a derived, lossy, full-tree replica. The markdown tree can remain as an optional export; it must not be the retrieval API.

### Recommended shape

Keep ingest as-is. Add a `ContextStore` in-process (FTS5). Mini POSTs a **first-pass** snippet pack to `GROK_BOT_WEBHOOK_URL`. Grok pulls more via **vfs HTTP** (`/v1/fs/*`) on Tailscale.

```
 Discord ingest  →  SQLite (messages + fts)
                         │
                         ├── Mini POST GROK_BOT_WEBHOOK_URL  { job, first_pass }
                         ├── Tailscale /v1/fs/tree|search|read  (Grok live tools)
                         └── optional markdown export (no Nia push)
```

Nia runtime was **removed in PR #24**. Mini needs zero `NIA_*` secrets. Markdown export stays local, one directory per workspace (see § Workspaces below).

### Interfaces (implement these; do not call Nia)

```ts
/** Workspace id from `channels.yml` (`workspaces:`). Plain string: the access boundary is `Scope.visible`. */
type Namespace = string;

/**
 * Access scope derived from a token or a job's originating channel.
 * `visible` = root workspace plus every transitive descendant. Produce only via `scopeFor()`.
 */
export interface Scope {
  root: Namespace;
  visible: ReadonlySet<Namespace>;
}

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
  scope: Scope;                // REQUIRED in-process. HTTP derives this from the token.
  pathPrefix?: string;        // index path, e.g. /eboard/eboard-teams/sponsors-xxxx
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
  readMessage(id: string, scope: Scope): IndexDocument | null;
  readPath(path: string, scope: Scope): IndexDocument | IndexDocument[] | IndexNode[] | null;
  tree(path: string, scope: Scope): IndexNode[];
  readChannelWindow(opts: {
    scope: Scope;
    /** Parent/allowlisted text channel id (effectiveChannelId). Includes threads. */
    channelId: string;
    afterId?: string;
    beforeId?: string;
    limit?: number;
  }): IndexDocument[];
  poll(scope: Scope, cursor: string | null, limit?: number): PollPage;
}
```

`index()` is called from `ingest.ts` after upsert (same place that currently `appendBlock`s). Backfill/reindex rebuilds FTS from `messages`.

**Namespace isolation:** each channel declares `workspace: <id>` in `channels.yml` (required — `isolated:` is gone; its presence is now a hard config error). Resolve via `namespaceForRow` / `effectiveChannelId` (thread ids are not in `channels.yml`, so `namespaceForRow` returns `null` for a thread whose parent is unknown — callers hard-fail, never default to a workspace). `scopeFor(root)` is the only producer of a `Scope`; a narrow scope must not return rows from a workspace outside `scope.visible`, even on exact FTS match. **HTTP does not take a client-chosen namespace** — see below.

### Workspaces

`config/channels.yml` declares a top-level `workspaces:` map: `{ <id>: { parent?: <id>, token_env?: ENV_NAME } }`. Ids are single lowercase slugs (`^[a-z0-9][a-z0-9-]*$`). Every channel's `workspace:` must name one of them.

Example tree:

```
leadership                     (root)
  eboard                       (parent: leadership)
    programs-mentorship        (parent: eboard)
    programs-dev                (parent: eboard)
```

**Scope** = a root workspace plus every transitive descendant, computed by `scopeFor(root)` / `visibleWorkspaces(root)` (`src/config.ts`). Never upward, never sideways: a token for `eboard` sees `eboard` plus every `programs-*`; a token for `programs-dev` sees only `programs-dev`; `leadership` sees everything.

Index paths: `/{workspace}/{category}/{channel-slug}[/threads/{thread-slug}][/{messageId}]`, e.g. `/programs-dev/eboard-teams/dev-team-a1b2/threads/bug-triage-c3d4`. `GET /v1/fs/tree?path=/` lists the visible workspaces flat, sorted. Path resolution is decode → POSIX normalize → OS denylist → the first segment must be a visible workspace, else 404 (`/programs-dev/../eboard` from a `programs-dev` token → 404; `/eboard/../programs-dev/...` from an `eboard` token → 200, since it normalizes into a still-visible path).

### HTTP (Tailscale vfs over the index)

Bind to the **Tailscale** address (`tag:morpheus`, Morpheus port only). Grok holds `MORPHEUS_BASE_URL` (tailnet) + a **scoped** token. Public internet still has no inbound port. **Not** a homedir mount.

**Namespace is not auth.** One scoped bearer per workspace, from `workspaces.<id>.token_env` in `channels.yml` (e.g. `MORPHEUS_API_TOKEN_LEADERSHIP`, `MORPHEUS_API_TOKEN_EBOARD`, `MORPHEUS_API_TOKEN_PROGRAMS_DEV`; `loadWorkspaceTokens()` — tokens ≥16 chars, pairwise distinct, never the Discord bot token). Scope is derived **server-side** from which token matched (`scopeFor`), never from a client field. Job routes take scope from the **job row**'s workspace. Negative tests: a `programs-dev` token cannot read `/eboard/...` or `/programs-mentorship/...` even if it sends `namespace=eboard`; a client-supplied `namespace` that isn't the token's root → **403**.

| Method | Path | Tool |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/v1/fs/tree?path=` | ls / tree |
| POST | `/v1/fs/search` | grep (no `includeDeleted` on HTTP) |
| GET | `/v1/fs/read?path=` | cat |
| GET | `/v1/links?kind=&since=&until=&limit=&channel=` | list shared Google Docs/Drive links in scope |
| GET | `/v1/messages/:id` | cat by id |
| GET | `/v1/poll?cursor=` | optional seq catch-up |

### Search semantics (Grok tool wrapper contract) — issue #50

`POST /v1/fs/search` body: `{ query, pathPrefix?, channelHint?, threadId?, sinceMs?, untilMs?, limit? (1..50, default 10) }`.

- **Two passes.** `strict` = every non-stopword term must match (porter-stemmed). If that yields fewer than `limit` hits and the query has ≥3 terms, a `loose` pass adds hits matching **any two** terms, bm25-ranked. Each hit carries `match: "strict" | "loose"` — treat loose hits as leads, not facts.
- `"quoted phrases"` are matched as phrases. Stopwords (`the, before, is, lol, pls, …`) are dropped unless the query is nothing but stopwords.
- Hits: `{ id, score, snippet (≈32 tokens), path, channelId, parentChannelId, threadId, authorName, createdAt, permalink, links[], match }`. `links` = Google Docs/Drive URLs extracted from that message.
- `pathPrefix` is applied in SQL (as a channel filter) before ranking, so a busy sibling channel cannot starve a quiet one.
- Wrapper guidance for Grok: (1) send the user's question verbatim first; (2) if `strict` hits are empty, retry with the 2–3 rarest words (`f26`, `tracker`, a person's name); (3) call `GET /v1/links?kind=docs` to enumerate shared docs when the question is about "the sheet / the tracker / the doc"; (4) `GET /v1/fs/read?path=<channel path>` for the surrounding conversation before answering "not in the index".

`GET /v1/links` is scoped by the token via the **message's** effective channel (`COALESCE(parent_channel_id, channel_id)`) — never `links.channel_id`, which holds the thread id for thread posts. Deleted messages are excluded; results are newest-first and deduped by Drive `file_id`. `since`/`until` bound the **posted time** (`messages.created_at`, ms epoch) — never `first_seen_at` ingest time, which diverges on backfill — and ordering/dedupe use posted time too. `firstSeenAt` is still returned per link. `channel=` takes a snowflake id or a channel name; a name shared by two visible channels is rejected with 400 (pass the id) rather than silently picking one.

The first-pass snippet pack the Mini POSTs to Grok is now FTS-first (strict → loose on the job text, same channel/workspace filter) and then back-filled by recency, capped at 12.

Poll cursor is monotonic **`seq`**, bumped on every write (`upsertMessage` / `markDeleted` / `setReactions`). Never `created_at` (backfill, edits, and deletes would be silent). Order snowflake ids with `CAST(id AS INTEGER)`.

Do not expose raw SQL, Mini `data/` paths, `~`, or Discord tokens. Third-party egress: club Discord text leaves the Mini toward Cursor/xAI when Grok runs — snippets in the first-pass POST plus whatever Grok reads over Tailscale. Workspace isolation is necessary but not the whole privacy story; cap payloads; do not ship deleted messages.

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

What to add: Mini POSTs a **thin** job (`first_pass` snippets) to `GROK_BOT_WEBHOOK_URL`. Grok then **live-searches the index** over Tailscale if needed. That is not agent-v1's in-process Pi agent, not a fat webhook dump, and not a Mini homedir share.

```
 User @Morpheus / hello@ / allowlisted ingest
        │
        ▼
 Mac Mini  ingest + first-pass snippets
        │
        POST GROK_BOT_WEBHOOK_URL   { job, snippets, first_pass: true }
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
- Channel (or thread parent) is allowlisted. Workspace from `namespaceForRow` (never fail-open on an unknown channel to any workspace).
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
  namespace TEXT NOT NULL,             -- workspace id (see § Workspaces); answering scope = scopeFor(namespace)
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
3. **GitHub issues**: implementation work only. Do **not** assume Grok Bot has `gh` credentials. If GitHub is unavailable, still complete the Discord feed/reply and record `github_issue_url` as null. Allowlisted repo only; approval required; only workspaces listed in `GITHUB_ISSUES_WORKSPACES` may carry a GitHub issue URL (empty = none, default deny). Do not put a PAT in this repo.

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
| `DISCORD_WEBHOOK_*` | **Grok Bot** secret store | Incoming webhooks for `#sponsors` / `#opportunities` / `#speakers` / `#inbox`. |
| `DISCORD_GUILD_ID` | Mini | Snowflake. Don't commit real `channels.yml`. |
| Per-workspace `MORPHEUS_API_TOKEN_*` (`workspaces.<id>.token_env`, e.g. `_LEADERSHIP`, `_EBOARD`, `_PROGRAMS_DEV`) | Mini + Grok (matching scope) | Tailscale `/v1/fs`. Scope from whichever token matched (`scopeFor`), never a client field. |
| `MORPHEUS_BASE_URL` | **Grok Bot** | Tailnet URL of Mini Morpheus HTTP. Not public. |
| `NIA_*` | Mini Doppler until deleted | Not Grok Bot. |
| `NVIDIA_API_KEY` | leftover | Unused. Drop. |
| SQLite | Mini disk | Club messages. **Not** a network filesystem share. |
| Gateway + Morpheus | **Mac Mini**, always-on | Outbound Discord + Tailscale index HTTP. **AWS/Fly stale.** |
| Homedir / personal projects | Mini only | **Off** the Morpheus index and off Tailscale file shares. |

Single-process SQLite is fine for one bot replica. Multiple ingest replicas would need Postgres; do not split until you have to.

---

## 6. Stale or conflicting open issues

Implementers should not blindly follow these:

| Issue | Status vs current main |
|---|---|
| #1 `ready` → `clientReady` | Still valid. Tiny fix in `src/bot/client.ts`. |
| #2 backup after Nia sync | Backup already runs nightly in `live.ts`. Wiring to Nia sync is moot if Nia is removed; backup after successful FTS index flush is the replacement. |
| #3 schedule reconcile | **Done** in `src/crawler/live.ts`. Owner close: #38. |
| #4 `--channel` backfill flag | Still valid, independent. |
| #5 thread attribution in markdown | **Done** in PR #6. Owner close: #38. |
| #9 Nia-index pi-mono | Closed research; used `nia` CLI. Do not revive Nia indexing. |
| #14 resumeBackfill + Nia flush | Catch-up pagination is still useful; **drop** `flushNamespace` / Nia dirty. |
| #10–#13, #15, #19 | **Do not implement.** Owner close/retitle: [#38](https://github.com/sean-lai-sh/morpheus/issues/38). |

---

Issue drafts (same text filed on GitHub) live in [`docs/issues/`](issues/). Tracking epic: **#25**. PR: **#24**.

## 7. Implementation order (Nia already removed in #24)

Nia runtime is **gone** (PR #24). AWS/Fly as host is stale. Do **not** start GitHub #26 from its frozen body — implement in-repo `docs/issues/01-context-store.md` after #39.

1. **#39** Mini host: launchd, Doppler, Tailscale `tag:morpheus`, no public inbound, no `~` share.
2. **#26** ContextStore + FTS5 (`namespaceForRow`, `channelId`+`parentChannelId`, poll **seq** not `created_at`).
3. **#29** mention → jobs (role gate, caps, trigger independent of ingest). `/cmd` is in-product (#41); mentions may ship first.
4. **#37** Mini POST **first-pass** `{ job, snippets, first_pass: true }` (not a full-index dump).
5. **#42** Grok Bot **activated** at `GROK_BOT_WEBHOOK_URL` (without this the queue has no worker).
6. **#40 / #27** Tailscale vfs: `/v1/fs/tree|search|read`, scoped tokens. Grok live tools.
7. **#30** idempotent official-bot replies (`claimed_by` mandatory; **Send Messages in Threads**).
8. **#36** Discord incoming webhooks `#sponsors` `#opportunities` `#speakers` `#inbox` (parallel).
9. **#31** GitHub **only** for implementation; **fail open** if `gh` is missing. Not how Grok receives work.
10. **#35** `/v1/events` after PR #23 + `grok_bot` enum.

Nia was **removed in #24**. Leftover #28 prose is now unused `openai` / `NVIDIA_API_KEY` (see `docs/issues/03-remove-nia.md`).

Locked vision: [#41](https://github.com/sean-lai-sh/morpheus/issues/41). Use relative in-repo links (`docs/context-layer.md`), not `blob/cursor/nia-migration-plan-9afa/...`. Filed GitHub #25/#26 still pin the branch; owner paste in #38.

Markdown export (`appendBlock`) stays as a local dump; do not build new retrieval on it.
