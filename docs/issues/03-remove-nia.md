**DONE.** Parent was #25. **Nia runtime was removed in PR #24** (`074022f` on `main`). This file is not “flag off, soak, then delete `src/nia/`.” Do not reopen Nia. Product vision: [#41](https://github.com/sean-lai-sh/morpheus/issues/41).

## Done in #24

- `src/nia/`, `register-nia`, and `NIA_*` env keys are gone.
- `/health` reports ingest `last_message_at` only (no Nia).
- `isolated: true` is the leadership markdown namespace.
- Local markdown export kept.

## Leftover (optional follow-up; not Nia)

- Unused `openai` package and `NVIDIA_API_KEY` in `src/config.ts` (never a required Doppler secret).
- Any remaining README / `channels.example.yml` historical mentions of Nia as a past index (operator path must not say `bun run register-nia`).

Do **not** restore `src/nia/` or `NIA_*`. Mini runs with zero Nia secrets.
