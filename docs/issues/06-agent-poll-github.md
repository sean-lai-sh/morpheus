Parent: #25. Depends on #27 and #30.

## Goal

Document and (minimally) stub how a **Cursor/Grok cloud agent** uses Morpheus: poll jobs, pull context, reply, optionally open GitHub issues with implementation suggestions.

This slice is mostly contract + a thin helper. Do **not** put Discord bot tokens, Nia keys, or GitHub PATs in the repo. Do **not** implement a self-bot.

Read `docs/context-layer.md` §4–§5.

## Deliverables

### 1. Agent contract doc

Create `docs/agent-poll-loop.md` with a copy-pasteable loop:

1. `GET /v1/jobs?status=queued` (header `Authorization: Bearer $MORPHEUS_API_TOKEN`).
2. `POST /v1/jobs/:id/claim` with `{ claimed_by: "$CURSOR_AGENT_ID" }`.
3. `POST /v1/search` with the job's `namespace` (never switch namespace to "see more").
4. Optional `GET /v1/channels/:channelId/messages` for recent window.
5. Produce a Discord `reply` (short) and optionally a GitHub issue body (longer implementation checklist).
6. Open the GitHub issue **as the Cursor agent** using its existing GitHub credentials (Cloud Agent `gh` / API) against a repo the club designates (e.g. `sean-lai-sh/morpheus` or a later club org). Put the issue URL in complete payload.
7. `POST /v1/jobs/:id/complete` with `{ reply, github_issue_url }`.

Include failure path: `POST /v1/jobs/:id/fail`.

State explicitly:

- Official Discord bot holds `DISCORD_TOKEN` only on the Morpheus host.
- Agent holds `MORPHEUS_API_TOKEN` + GitHub auth. Never both Discord + Nia.
- Leadership jobs (`namespace=leadership`) must not be processed by an agent env that is allowed to post to public repos without a review flag. Recommend: leadership replies stay in Discord; GitHub issues from leadership jobs default **off** (`OPEN_GITHUB_ISSUES_FROM_LEADERSHIP=false`).

### 2. GitHub issue posting: agent-side, not bot-side (default)

Do **not** add `GITHUB_TOKEN` to Morpheus in this slice. Reasons: Cursor agents already have GitHub; keeps Discord token and GitHub token on different principals.

If a follow-up wants the bot to open issues as a GitHub App, that is a new issue: GitHub App on the Morpheus host, Doppler secrets `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`, never committed.

### 3. Optional helper script (no secrets)

`scripts/agent-poll-example.ts` — a **dry-run** client that reads `MORPHEUS_BASE_URL` + `MORPHEUS_API_TOKEN` from env and prints jobs. Guard with `if (import.meta.main)`. Do not default-loop in `bun run live`. Do not hardcode URLs with tokens.

### 4. README pointer

Link the poll-loop doc from README. List new env names as empty placeholders only.

## Out of scope

- Wiring Cursor Automations / webhooks (can mention as future).
- Pi-agent-core.
- Changing Discord intents.

## Acceptance criteria

- [ ] `docs/agent-poll-loop.md` exists and matches the real `/v1/jobs` routes from the claim/complete issue.
- [ ] No secret values in the repo.
- [ ] Leadership GitHub posting is documented as off by default.
- [ ] Example script does not run unless invoked explicitly.

## Dependencies

- HTTP v1 search.
- Job claim/complete routes (doc can land in the same PR as that issue if needed).
