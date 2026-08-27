# PARKED — do not implement as written

**Product vision (locked):** [#41](https://github.com/sean-lai-sh/morpheus/issues/41).

These GitHub issues are still open and still labeled `agent-v1`. Their **bodies have no parked marker** (this Cursor identity cannot comment/close them — 403). Owner paste: [`38-owner-close-stale.md`](38-owner-close-stale.md) / [#38](https://github.com/sean-lai-sh/morpheus/issues/38).

Until Sean pastes, **this file is the in-repo marker**. Searching “Nia retrieval” / “search_discord” / “runAgentTurn” must hit this page.

| Issue | Title as filed | Why parked |
|---|---|---|
| [#10](https://github.com/sean-lai-sh/morpheus/issues/10) | in-process agent scaffold + mention reply | Fights job queue #29. Grok Bot is the model. |
| [#13](https://github.com/sean-lai-sh/morpheus/issues/13) | AbortController router | Job CAS replaces it. Do not cancel other users’ jobs. |
| [#15](https://github.com/sean-lai-sh/morpheus/issues/15) | `search_discord` via **Nia** | **Do not implement Nia retrieval.** Use #26 FTS + #40 vfs. |
| [#19](https://github.com/sean-lai-sh/morpheus/issues/19) | sandbox runtime + Discord attachments | Grok Bot is the coding agent. |
| [#20](https://github.com/sean-lai-sh/morpheus/issues/20) / [#21](https://github.com/sean-lai-sh/morpheus/issues/21) | skills + `/event-status` into Pi | Slash may later **enqueue** a Grok job (#41); not `runAgentTurn`. |

Related: [#34](https://github.com/sean-lai-sh/morpheus/issues/34), [`34-park-agent-v1.md`](34-park-agent-v1.md), [`docs/grok-bot-audit.md`](../grok-bot-audit.md).
