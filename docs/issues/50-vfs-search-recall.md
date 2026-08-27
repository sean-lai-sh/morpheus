# VFS search misses F26/doc-link mentions: `toFtsQuery` ANDs all tokens, links/embeds not indexed

## Symptom
`@Elliephant` answered "Can't name a winner off the index… no F26 per-team task list in Morpheus" even though F26 prep, Fall '25 Prep, trackers and Google Doc links are all over the server. Asked to "just read the general text and search", it still couldn't.

## Root cause (verified against `data/morpheus.db`: 50,745 msgs, FTS count == messages count — the *index* is complete)

### 1. `toFtsQuery` ANDs every token as an exact phrase — `src/context/store.ts:105`
```ts
return tokens.map((t) => `"${t}"`).join(" AND ");
```
Any natural-language question Grok sends becomes `"fall" AND "2026" AND "tasks" AND "before" AND "school" AND "starts"`. Measured:

| query | FTS expr | hits |
|---|---|---|
| `fall 2026 tasks before school starts` | 6 ANDed terms | **0** |
| `F26 tracker` | `"F26" AND "tracker"` | **0** |
| `F26` | | 6 |
| `fall 2026` | | 2 |
| `tracker` | | 15 |
| `prep` | | 49 |
| `"fall" OR "f26" OR "2026"` | | 159 |

The more specific the question, the *fewer* results. Quoted phrases also bypass the porter stemmer, and `'25`/`'26` become bare `25`/`26`. Grok then concludes "nothing in the index".

### 2. Only `messages.content` is in FTS — `src/storage/db.ts:183`
- `links` table (598 docs + 93 drive links, extracted by `src/storage/links.ts`) is **not joined into search or `/v1/fs`**. "here's the F26 tracker <docs link>" is findable only via `tracker`; the URL/title is never searchable and Grok has no `/v1/links` endpoint to enumerate shared docs.
- Embeds, attachments (filenames, Google Doc previews) and forum-post titles are never ingested (`src/bot/ingest.ts` reads only `message.content`).
- `thread_name` / channel name aren't in the FTS column.

### 3. First-pass snippets are recency-only — `src/storage/jobs.ts:456`
`firstPassSnippets` = last 2,000 rows (workspace) / 80 (channel), capped to **12** snippets. Anything older than a few days only reaches Grok if its follow-up `/v1/fs/search` succeeds — which #1 makes unlikely.

### 4. Snippet size
`snippet(messages_fts, …, 12)` = 12 tokens; the doc link usually sits at the end of the message and is cut off.

## Proposed fix
- [ ] `toFtsQuery`: unquoted stemmed tokens, `OR` with bm25 ranking (require ≥1 non-stopword), drop stopwords; keep quoted-string escape hatch for exact phrase.
- [ ] Index `links` (FTS over `url` + fetched doc title) and expose `GET /v1/links?kind=docs&since=` for scope-wide doc enumeration.
- [ ] Ingest `embeds[].title/description/url`, `attachments[].name`, forum thread titles into indexed text.
- [ ] `firstPassSnippets`: FTS pass on the job text (fixed builder) merged with recency; full message text for top N instead of 12-token snippets.
- [ ] Test: `search("fall 2026 tasks before school starts")` returns the Fall '25 Prep message.

## Verify with the running Grok Bot
The webhook trace for the 21:40 `@Elliephant` job should show the `/v1/fs/search` bodies Grok sent; expect `[]` for every multi-word query. Re-run the same question after the fix; the table above is the baseline.
