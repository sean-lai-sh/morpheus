# Grok worker contract: meetings (Mini → Calendar)

Mini is the Discord face. Grok is the Calendar brain (`hello@techatnyu.org`). This is the pack + complete contract so Sean can implement the Grok side and deploy Mini. **Do not put `DISCORD_BOT_TOKEN`, Google OAuth, or attendee emails on the wrong host.**

| Secret / data | Mini | Grok |
|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | **never** |
| Google OAuth / Calendar credentials | **never** | yes (`hello@`) |
| Incoming Discord webhooks (`DISCORD_WEBHOOK_*`) | ops-feed / digest only | ops-feed |
| Attendee emails | **never in packs, logs, or complete JSON** | read from Drive roster |
| Discord identity (user id, username, global_name, guild nick) | pack these | map to Preferred Email |

Role gate is the same fail-closed `JOB_TRIGGER_ROLE_IDS` set as `/ask` / `/background` / `@mention` (Leadership / Eboard / Senior Adv). Empty set never books.

## Two doors, one tool

1. **`/meet create`** — Discord options + MentionableSelectMenu (users **or** roles, max 25). Optional: `calendar` (eboard \| leadership), `meet` (Meet on/off), `recurrence` (none \| weekly), `audience` (`picker` \| `f26`). `f26` skips the picker and means “invite the F26 roster tab.”
2. **`@official-bot` free text** — same outbox → `meeting.calendar_sync` job. Examples: “book eboard Friday 6:30 ET”, “meet with Pope and Jennifer tomorrow 3pm”. Mini parses what it can; `source_text` is always in the pack so Grok can refine.

Both write `outbox_events` (`meeting.calendar_sync_requested` / `meeting.calendar_cancel_requested`). The publisher POSTs a `jobs` row to `GROK_BOT_WEBHOOK_URL` on the **background** lane (always Grok, never the local SDK). Complete is `/v1/jobs/:id/complete` as today.

## Job pack (Mini → Grok)

`jobs.content` is JSON. `kind` is `meeting.calendar_sync` or `meeting.calendar_cancel`.

```json
{
  "kind": "meeting.calendar_sync",
  "meetingId": "uuid",
  "version": 1,
  "outboxId": "uuid",
  "title": "Tech@NYU Eboard",
  "startsAt": "2026-09-04T22:30:00.000Z",
  "endsAt": "2026-09-04T23:30:00.000Z",
  "timeZone": "America/New_York",
  "notes": null,
  "calendar": "eboard",
  "calendar_id": "c_9933b833e4985f99fdaf9ce9b7ef54b7bbc478e506c9e83e99743697b82863fb@group.calendar.google.com",
  "conference": true,
  "recurrence": "weekly",
  "audience": "f26_roster",
  "requester": {
    "user_id": "123",
    "username": "Shaszis",
    "global_name": "Sean Lai",
    "guild_nick": "Sean"
  },
  "participants": [
    {
      "user_id": "456",
      "username": "p6ca",
      "global_name": "Pope Cruz",
      "guild_nick": "Pope"
    }
  ],
  "requested_names": ["Jennifer"],
  "source": "mention",
  "source_text": "book eboard Friday 6:30 ET",
  "source_message_id": "1400000000000000000",
  "participantCount": 1,
  "calendarEventId": null,
  "mapper": {
    "sheet_id": "1NlApvtFAhFTMNafGoVksrYpJhi_oz5dlA6pml5VQ3rw",
    "tab": "F26",
    "match_order": ["disc", "username", "first_last"],
    "empty_disc_fallback": "first_last"
  },
  "instruction": "…"
}
```

**Forbidden in the pack:** attendee emails, `DISCORD_BOT_TOKEN`, Google refresh tokens. `hello@techatnyu.org` appears only as the Calendar actor in `instruction`. Calendar group ids are not secrets.

### `calendar`

| Value | Calendar id Grok should write |
|---|---|
| `eboard` | `c_9933b833e4985f99fdaf9ce9b7ef54b7bbc478e506c9e83e99743697b82863fb@group.calendar.google.com` |
| `leadership` | hello@ **primary** (`calendar_id`: `primary`) |

Historical job `1a493bac` used the Eboard Calendar, Fridays 6:30–7:30pm `America/New_York` through Dec 14, Meet `https://meet.google.com/vef-zicw-ozo`, event `883hrtefrla9anp17crkpcof1o`.

### `audience`

- `picked` — invite only people Grok can map from `participants` + `requested_names` (plus requester if you want the booker on the event).
- `f26_roster` — **do not** wait for a Discord picker. Invite every F26 **Preferred Email** from the roster tab. Optional senior advs (Cyan Yan, Kaylee Chen, Grace Gao) if that is still eboard policy — resolve them on Grok from the sheet, not from Mini.

## Roster mapper (Grok + Drive)

Sheet: https://docs.google.com/spreadsheets/d/1NlApvtFAhFTMNafGoVksrYpJhi_oz5dlA6pml5VQ3rw

F26 columns: `First Name | Last Name | Preferred Email | Phone Number | Position | Fall '26 Year | Major | Previous Role | S27 Abroad? | Disc | Birthday`

`Disc` is a Discord **username/handle**, not a snowflake.

| Person | Disc | Preferred Email |
|---|---|---|
| Jennifer Huang | HFYJ | fh2419@nyu.edu |
| Sean Lai | Shaszis | seanlai@nyu.edu |
| Pope Cruz | p6ca | pgc9002@nyu.edu |
| Sean Hu | Sean Hu | sh7285@nyu.edu |

Empty `Disc` (Marc Lam, Fahim Hussain, Khidir Ahmed, Zachary Kublaisingh): fall back to `First Name + Last Name` vs `guild_nick` / `global_name`.

**Match order (locked):**

1. Sheet `Disc` vs pack `username` (case-insensitive, ignore leading `@`)
2. Sheet `Disc` vs pack `username` again after stripping spaces (handles “Sean Hu”)
3. `First Name + Last Name` vs `guild_nick`, then `global_name`
4. If `Disc` is empty, skip 1–2 and use 3

`requested_names` (“Pope”, “Jennifer”) are leftover free-text names Mini could not bind to a cached Discord user. Map those with the same First+Last / Disc rules. **Never write emails back to Mini.**

## Complete JSON (Grok → Mini)

POST the existing complete endpoint. `reply` must parse as JSON (raw or ` ```json ` fence):

```json
{"calendar_event_id":"883hrtefrla9anp17crkpcof1o","meet_link":"https://meet.google.com/vef-zicw-ozo"}
```

Cancel:

```json
{"cancelled":true}
```

Mini stores `calendar_event_id` / `meet_link` on the `meetings` row (version-guarded). If the job’s `discord_message_id` is a real mention/ack snowflake, Mini `message.reply`s the announcement **with the Meet link**. Synthetic `coordinator-outbox:*` ids do not fetch Discord.

Do not put emails in `reply`.

## Mini Doppler / server (Sean)

- Redeploy Mini from this branch (`bun run live`). Slash commands re-register `/ask`, `/background`, `/task`, `/meet`.
- Confirm `JOB_TRIGGER_ROLE_IDS` includes Leadership / Eboard / Senior Adv. Empty = nothing books (fail closed).
- Mini Doppler: `DISCORD_BOT_TOKEN`, `GROK_BOT_WEBHOOK_URL`, `GROK_BOT_WEBHOOK_SECRET`. **No Google secrets.**
- Grok Doppler / secret store: Calendar OAuth for `hello@techatnyu.org`, Drive read on the roster sheet. **No `DISCORD_BOT_TOKEN`.**
- Incoming Discord webhooks stay ops-feed only (`MINI_DIGEST_ENABLED` / `#sponsors` etc.). They are not the meeting path.

## What Mini does not do

- No Google Calendar API
- No Inngest
- No attendee1…attendeeN USER slash pile (the MentionableSelectMenu is the GUI)
- No second meeting system — mention and `/meet` share `createScheduledMeeting` + the same pack `kind`
