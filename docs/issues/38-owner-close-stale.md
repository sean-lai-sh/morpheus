GitHub issue **#38**. Parent: #34 / PR #24. Product vision: **[#41](https://github.com/sean-lai-sh/morpheus/issues/41)**.

## Why this exists

Sol + Kimi reviews of PR #24: meta-issue **#34 is not enough**. #10 / #13 / #15 / #19 stay open and labeled `agent-v1` with **no parked marker on the issues themselves**. #15 still reads as “implement Nia retrieval”. #3 / #5 stay open though the audit says close. Frozen GitHub bodies for #25 / #26 still pin `blob/cursor/nia-migration-plan-9afa` (404 after merge).

A future cloud agent assigned those numbers will implement the stale Pi/Nia plan.

This Cursor identity **cannot** close, comment on, retitle, or relabel those issues (`403 Resource not accessible by integration`). `gh issue create` works; mutate does not.

## Owner paste (Sean)

Close done/parked issues:

```bash
gh issue close 3  --comment "Done: reconcile cron is in src/crawler/live.ts. Closing per PR #24 audit."
gh issue close 5  --comment "Done in PR #6 (thread_id / thread_name, per-thread files). Closing per PR #24 audit."
gh issue close 10 --comment "PARKED by #34. Do not implement as written. Fights job queue #29. Consumer is Grok Bot (#33). Product vision: #41. See PR #24."
gh issue close 13 --comment "PARKED by #34. Job CAS replaces in-process AbortController. Product vision: #41. See PR #24."
gh issue close 15 --comment "PARKED by #34. SUPERSEDED by #26 FTS + #40 live index vfs. Do not implement Nia retrieval. Product vision: #41. See PR #24."
gh issue close 19 --comment "PARKED by #34. Grok Bot is the coding agent; do not add Morpheus-side sandbox runtime. Product vision: #41. See PR #24."
```

If you prefer to keep them open, at least comment + retitle (the comment is the marker Kimi asked for):

```bash
for n in 10 13 15 19; do
  gh issue comment $n --body "PARKED by #34 / product vision #41. Do not implement as written. Grok Bot is the consumer (#33). Live index is #40. See PR #24."
  gh issue edit $n --title "[PARKED] $(gh issue view $n --json title -q .title)"
done
```

Fix frozen GitHub bodies that pin the PR branch (relative in-repo links only; these 404 after merge):

```bash
gh issue comment 25 --body "Source of truth is in-repo \`docs/issues/00-epic.md\` (relative links). Ignore blob/cursor/nia-migration-plan-9afa URLs — they 404 after merge. Product vision: #41. #28 is last."
gh issue comment 26 --body "Do not implement from this GitHub body. Use in-repo \`docs/issues/01-context-store.md\` on main after PR #24. Product vision: #41."
gh issue comment 27 --body "Do not implement from this GitHub body. Use in-repo \`docs/issues/02-http-api.md\` (Tailscale vfs \`/v1/fs\`, scoped tokens). Product vision: #41. Live tools: #40."
gh issue comment 32 --body "In-repo \`docs/issues/32-index.md\` is source of truth. #28 is last. Product vision: #41."
gh issue comment 33 --body "Keep the consumer name. Poll-loop is stale — Mini POSTs to GROK_BOT_WEBHOOK_URL (#37) and Grok is activated by that webhook (#42). Product vision: #41."
gh issue comment 39 --body "In-repo \`docs/issues/39-mini-host.md\` is source of truth (Tailscale live index HTTP, not public inbound). Product vision: #41."
```

## Until those close, treat as do not implement

| Issue | Why |
|---|---|
| #10 | In-process Pi mention reply fights #29 |
| #13 | In-process AbortController; job CAS replaces it |
| #15 | Nia retrieval; superseded by #26 + #40 |
| #19 | Morpheus-side sandbox; Grok Bot is the coding agent |
| #3 | Already in `src/crawler/live.ts` |
| #5 | Already in PR #6 |

Do **not** implement #10 / #13 / #15 / #19 from this repo’s open-issue list.
