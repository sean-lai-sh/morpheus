GitHub issue **#38**. Parent: #34 / PR #24.

## Why this exists

Sol’s review of PR #24: meta-issue **#34 is not enough**. #10 / #15 / #19 stay open and labeled `agent-v1`. #3 / #5 stay open though the audit says close. A future cloud agent assigned those numbers will implement the stale Pi/Nia plan.

This Cursor identity **cannot** close, comment on, retitle, or relabel those issues (`403 Resource not accessible by integration`). `gh issue create` works; mutate does not.

## Owner paste (Sean)

```bash
gh issue close 3  --comment "Done: reconcile cron is in src/crawler/live.ts. Closing per PR #24 audit."
gh issue close 5  --comment "Done in PR #6 (thread_id / thread_name, per-thread files). Closing per PR #24 audit."
gh issue close 10 --comment "PARKED. Do not implement. Fights job queue #29. Consumer is Grok Bot (#33). See #34 and PR #24."
gh issue close 13 --comment "PARKED. Job CAS replaces in-process AbortController. See #34 / PR #24."
gh issue close 15 --comment "SUPERSEDED by #26 FTS. Do not implement Nia retrieval. See #34 / PR #24."
gh issue close 19 --comment "PARKED. Grok Bot is the coding agent; do not add Morpheus-side sandbox runtime. See #34 / PR #24."
```

Until those close, treat the titles below as **do not implement**:

| Issue | Why |
|---|---|
| #10 | In-process Pi mention reply fights #29 |
| #13 | In-process AbortController; job CAS replaces it |
| #15 | Nia retrieval; superseded by #26 |
| #19 | Morpheus-side sandbox; Grok Bot is the coding agent |
| #3 | Already in `src/crawler/live.ts` |
| #5 | Already in PR #6 |

Do **not** implement #10 / #13 / #15 / #19 from this repo’s open-issue list.
