GitHub issue **#38**. Product vision: **[#41](https://github.com/sean-lai-sh/morpheus/issues/41)**.

This Cursor identity **cannot** close, comment, retitle, or relabel issues (`403 Resource not accessible by integration`). `gh issue list` / `gh pr view` work; mutate does not.

Sean: paste the blocks below. Close **#38 last**, after the numbers it names are actually closed. Do **not** close #41 #42 #40 #39 #37 #36 #30 #29. Do **not** close or merge PRs #43 / #44.

## Close stale / done / parked (one-line, points at #41)

```bash
# Nia-exit / poll-loop — superseded or done
gh issue close 28 --comment "DONE in PR #24. src/nia/ gone. Mini boots with zero NIA_*. Locked vision: #41. Do not restore Nia."
gh issue close 26 --comment "SUPERSEDED by #40 + in-repo docs/issues/01-context-store.md / PR 44. Do not implement this frozen GitHub body (poll-by-created_at, client namespace). Locked vision: #41."
gh issue close 27 --comment "SUPERSEDED by #40 (scoped tokens, /v1/fs tree|search|read, no client namespace). Do not implement this frozen GitHub body. Locked vision: #41."
gh issue close 31 --comment "STALE as the way Grok receives work. Replaced by Mini POST #37 + Grok worker #42. Optional GitHub-issue-from-leadership stays off. Locked vision: #41."
gh issue close 32 --comment "SUPERSEDED by #41. Nia-exit index linking #25–#31 is historical."
gh issue close 33 --comment "Consumer name lives on in #41. Poll-loop / Grok polls /v1/jobs is stale; Mini pushes (#37/#42). Locked vision: #41."
gh issue close 25 --comment "COMPLETED/SUPERSEDED. Nia is gone (PR #24). Remaining work is #41 slices. Locked vision: #41."
gh issue close 35 --comment "PARK. Depends on PR #23 events table; #23 closed without merge. Do not implement until events exist on main. Locked vision: #41."

# May agent-v1 (park or done) — #38 comment text
gh issue close 2  --comment "SUPERSEDED. Backup-on-Nia-sync is moot; Nia is gone (PR #24). Nightly backup already exists in live.ts. Product vision: #41."
gh issue close 3  --comment "Done: reconcile cron is in src/crawler/live.ts. Closing per PR #24 audit."
gh issue close 5  --comment "Done in PR #6 (thread_id / thread_name, per-thread files). Closing per PR #24 audit."
gh issue close 7  --comment "PARKED. Events table; PR #23 closed without merge. Do not implement Pi tools #17/#18. Product vision: #41."
gh issue close 8  --comment "PARKED. Sandbox image is optional files; not a Grok Bot deploy requirement. Product vision: #41."
gh issue close 10 --comment "PARKED by #34. Do not implement as written. Fights job queue #29. Consumer is Grok Bot (#33). Product vision: #41. See PR #24."
gh issue close 11 --comment "PARKED. Steal trigger predicates into #29; do not implement Pi tool-policy types. Product vision: #41."
gh issue close 12 --comment "PARKED. Grok uses first-pass snippets + Tailscale /v1/fs, not in-process context.ts. Product vision: #41."
gh issue close 13 --comment "PARKED by #34. Job CAS replaces in-process AbortController. Product vision: #41. See PR #24."
gh issue close 14 --comment "PARKED as written. Nia flushNamespace is gone (PR #24). Pagination may return later. Product vision: #41."
gh issue close 15 --comment "PARKED by #34. SUPERSEDED by #26 FTS + #40 live index vfs. Do not implement Nia retrieval. Product vision: #41. See PR #24."
gh issue close 16 --comment "PARKED. Drive later as HTTP for Grok, not a Pi tool. Product vision: #41."
gh issue close 17 --comment "PARKED. Do not implement as a Pi tool. Events HTTP is #35 after events exist on main. Product vision: #41."
gh issue close 18 --comment "PARKED. Do not implement as a Pi tool. Product vision: #41."
gh issue close 19 --comment "PARKED by #34. Grok Bot is the coding agent; do not add Morpheus-side sandbox runtime. Product vision: #41. See PR #24."
gh issue close 20 --comment "PARKED by #34. Slash may later enqueue a Grok job (#41); not Pi runAgentTurn. Product vision: #41."
gh issue close 21 --comment "PARKED by #34. Slash may later enqueue a Grok job (#41); not #21 as written. Product vision: #41."
gh issue close 22 --comment "PARKED as written. Setup CLI may return later without register-nia. Nia is gone. Product vision: #41."

# Meta (after the numbers above are closed)
gh issue close 34 --comment "Park list landed. #10 #13 #15 #19 #3 #5 (and the rest of May agent-v1) closed or pasted. Remaining work is #41. Locked vision: #41."
gh issue close 38 --comment "Owner close list executed. Remaining work is #41 slices. Locked vision: #41."
```

Leave **open**: #1 (clientReady), #4 (`--channel` backfill).

## Keep open — comment (body may still mention poll-loop / Nia / incoming-webhook replies)

```bash
KEEP='Still in play. Parent: #41. Ignore older poll-loop/Nia/Pi text elsewhere.'
for n in 41 42 40 39 36 30 29; do
  gh issue comment $n --body "$KEEP"
done

gh issue comment 37 --body "$(cat <<'EOF'
Still in play. Parent: #41. Ignore older poll-loop/Nia/Pi text elsewhere.

The GitHub body line that Grok posts @-replies via incoming webhooks is **stale**: after `{ reply }`, Mini `message.reply`s as the official bot. Incoming webhooks are #36 ops feed only. Auth is `Authorization: Bearer GROK_BOT_WEBHOOK_SECRET`.
EOF
)"
```

If you can `gh issue edit 37 --body-file …`, replace the “After Grok receives it” section with the in-repo `37-mini-dispatch-grok.md` text (comment is enough).

## Until GitHub closes, treat as do not implement

See [`PARKED.md`](PARKED.md). Do **not** implement #10 / #13 / #15 / #19 / #26 / #31 from the open-issue list.
