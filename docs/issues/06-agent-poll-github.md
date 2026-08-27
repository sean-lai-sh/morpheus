Parent: #25. GitHub issue **#31**. **Hosting update:** the “Grok polls Mini `/v1` over the internet” loop is **stale**. See [`docs/hosting.md`](../hosting.md) and [#37](https://github.com/sean-lai-sh/morpheus/issues/37).

## Goal

Keep **GitHub issues for implementation work only**. Grok Bot does **not** poll Morpheus over the internet (Mini has no public inbound IP). Mini **POSTs** `{ job, snippets }` to `GROK_BOT_WEBHOOK_URL`. Grok Bot then posts FYIs to Discord incoming webhooks and, only for implementation work, may open a GitHub issue if `gh` exists (fail open if it does not).

Do **not** put Discord bot tokens, Nia keys, webhook URLs, or GitHub PATs in the repo. Do **not** implement a self-bot. Do **not** design Morpheus to run on AWS, Cursor cloud-agent VMs, or Grok Bot’s shared computer.

Read `docs/hosting.md`, `docs/context-layer.md` §4–§5.

## Deliverables

### 1. Agent contract doc

Create `docs/agent-poll-loop.md` **only as a localhost-on-Mini note** (optional `/v1` on 127.0.0.1). Do **not** document a public `MORPHEUS_BASE_URL` that Grok hits from the internet.

The live Grok path is:

1. Mini (official bot + SQLite) POSTs `{ job, snippets }` to `GROK_BOT_WEBHOOK_URL`.
2. Grok Bot (one-shot) posts operational FYIs to `DISCORD_WEBHOOK_SPONSORS` / `_OPPORTUNITIES` / `_SPEAKERS` / `_INBOX`.
3. If the work is **implementation**, Grok may open a GitHub issue using **its** credentials. If `gh` is missing, skip GitHub and still complete the Discord feed.
4. Official bot `message.reply` for @mentions stays on the Mini (#30).

State explicitly:

- Official Discord bot holds `DISCORD_BOT_TOKEN` only on the **Mac Mini**.
- Grok Bot holds `DISCORD_WEBHOOK_*`. Never `DISCORD_BOT_TOKEN` or `NIA_*`.
- Leadership jobs (`namespace=leadership`) must not open public GitHub issues by default (`OPEN_GITHUB_ISSUES_FROM_LEADERSHIP=false`).

### 2. GitHub issue posting: agent-side, not bot-side (default)

Do **not** add `GITHUB_TOKEN` to Morpheus in this slice. Reasons: Cursor agents already have GitHub; keeps Discord token and GitHub token on different principals.

If a follow-up wants the bot to open issues as a GitHub App, that is a new issue: GitHub App on the Morpheus host, Doppler secrets `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`, never committed.

### 3. Optional helper script (no secrets)

Optional: a dry-run that prints a sample Mini→Grok payload. Guard with `if (import.meta.main)`. Do not default-loop in `bun run live`. Do not hardcode URLs with tokens. Do not assume Grok can reach Mini HTTP.

### 4. README pointer

Link [`docs/hosting.md`](../hosting.md) from README (already). List env names as empty placeholders only.

## Out of scope

- Designing Morpheus as an internet-facing job API (stale vs #37).
- Wiring Cursor Automations (Mini outbound webhook is the v1 trigger).
- Pi-agent-core.
- Changing Discord intents.

## Acceptance criteria

- [ ] Docs say Grok does not poll Mini over the internet; Mini POSTs out.
- [ ] GitHub is implementation-only; fail open if `gh` is missing.
- [ ] AWS / cloud-agent / Grok-shared-box hosting is marked stale.
- [ ] No secret values in the repo.
- [ ] Leadership GitHub posting is documented as off by default.
- [ ] Example script does not run unless invoked explicitly.

## Dependencies

- Mini dispatch (#37) for the live Grok path.
- Optional localhost `/v1` (#27) is not required for Grok to receive jobs.
