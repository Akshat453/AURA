# Professor tools (Phase 5)

> **Backend migration note.** The backend now runs on Node.js (`backend/`). The offline evaluation tools `cmd/stt-bench`, `cmd/rag-eval`, `cmd/tool-bench`, `cmd/confirm-bench` and `cmd/fetch-fixtures` were not ported to Node.js and are not part of this repository; the commands below that use them describe the original Go tooling. See [MIGRATION_PLAN.md](MIGRATION_PLAN.md).

The assistant can read and manage a weekly timetable, reminders, notes, voice memos and email/announcement drafts, by voice or typed text, in English, Hindi and Hinglish. Everything is stored on the Mac in `PROFESSOR_DATA_PATH` (default `./data/professor`, git-ignored): one SQLite file (`professor.db`, mode 0600) and, only when you choose to keep them, memo recordings in `memos/`. Google Calendar and Gmail are optional and off by default.

## What you can say

| Area | Examples |
|---|---|
| Timetable | "What is my next lecture?" · "Aaj meri kitni classes hain?" · "कल मेरा पहला लेक्चर कब है?" · "Which subject am I teaching on Friday?" · "Do I have any free time tomorrow?" |
| Reminders | "Remind me to submit attendance tomorrow at 10 AM." · "Kal subah 10 baje meeting yaad dilana." · "Remind me 30 minutes before my next DBMS lecture to print the quiz." · "Show today's reminders." · "Cancel my attendance reminder." |
| Notes | "Save a note: discuss the ER diagram feedback on Thursday." · "Show my notes about computer networks." · "नॉर्मलाइज़ेशन के बारे में मेरे नोट्स क्या कहते हैं?" · "Delete my note about indexing." |
| Voice memos | "Save a voice memo: ask the department to replace the projector in LH-2." (transcript only), or record on the **Voice memos** tab |
| Drafts | "Draft an email to coordinator@college.edu saying Thursday's DBMS lecture moves to LH-3." · "Create an announcement for tomorrow's DBMS lecture." |

The web page has tabs for the assistant, timetable, reminders, notes, voice memos, drafts and the optional Google account. Changes you make directly on those tabs are your own explicit actions; deleting asks first.

## Confirmation of changes

Every change the assistant proposes (create, update or delete a reminder, note, memo or draft) must be confirmed by you. The backend enforces this; the language model cannot bypass it.

1. Gemini calls a data-changing tool. Go validates the arguments (types, dates, ids, recipients) and, instead of changing anything, stages a proposal with a confirmation question **written by Go**, e.g. "Should I create this reminder: Submit attendance, tomorrow, Wednesday 21 October, at 10:00 AM?". The tool call ends Gemini's turn, so the model cannot continue and claim the change was made.
2. The proposal becomes answerable only after the question has been delivered completely (the browser turn finished; for an ESP32, after its audio was sent). If the turn fails or you interrupt it, the proposal is discarded.
3. You answer by voice or text ("yes", "haan", "हाँ, ठीक है", "no", "नहीं, रहने दो") or with the **Confirm / Cancel** buttons on the card, where drafts and notes can be edited before saving. A reply is classified locally (never by Gemini) and must consist only of yes/no phrases: "yes, but at 11" is not an approval. A one- or two-word reply that is neither is treated as misheard and the question is repeated; anything longer is a new request and cancels the question.
4. Go revalidates and executes, and the reply ("Done. Reminder created: …") is built from what the database returned. Failures say that nothing was changed.

Safeguards: random action ids bound to the browser tab or device session; `ACTION_CONFIRMATION_TIMEOUT_SECONDS` (default 60); each action runs at most once (repeated or concurrent approvals return "already decided"; database writes are also idempotent per action id); one proposal per request; only declared fields can be edited from the card; tool results, documents and web pages are data and can never approve anything. The time phrase in the question is absolute (weekday, date, AM/PM), so a wrong interpretation is visible before you approve.

**Ambiguous times.** If you give a bare hour without morning/evening ("at 5", "5 baje"), the reminder tools refuse it and the assistant asks which you mean. This check runs in Go on your words.

## Timetable

Classes have subject, course code, section, room, weekday, start/end time, time zone, optional effective dates and an active flag. Add them on the **Timetable** tab or import a CSV (columns `subject, course_code, section, room, weekday, start, end, timezone, effective_from, effective_to, active`; weekday as Monday or 1-7; one invalid row rejects the whole file); export writes the same format with spreadsheet-formula characters neutralised.

Answers come only from this table: lectures are reported as completed, in progress or upcoming, overlaps are flagged, weekends simply have no classes, and classes defined in another time zone are converted. **Holidays and cancellations are not recorded**; the assistant says so rather than assuming. Free time is computed within `PROFESSOR_WORKDAY` (default 09:00-17:00). The time zone is `PROFESSOR_TIMEZONE` (default Asia/Kolkata).

## Reminders and notifications

Reminders have a title, optional details, a local date and time, optional recurrence (daily, weekdays, weekly) and status. A scheduler in the Go process sleeps until the next due time (no polling) and is woken when reminders change. Each occurrence is claimed with one conditional database update, so it is notified exactly once, also across restarts. Notifications appear on every open page of the assistant (banner, plus a desktop notification if you allow it) and, with `REMINDER_MACOS_NOTIFICATIONS=true`, as a macOS notification.

**Limitations.** Reminders fire only while the assistant is running: not while the Mac is off or asleep, or the assistant is stopped. Reminders that came due meanwhile are notified once, marked overdue, when it starts again; recurring reminders skip missed occurrences instead of replaying them. ESP32 devices are not notified (the device protocol has no server-initiated speech and was not changed); they can ask "show today's reminders".

## Notes, memos and document search

Notes (title, text, tags) and memo transcripts are stored in `professor.db` and also indexed in the Phase 4 document index under reserved ids (`note-…`, `memo-…`) with the existing multilingual embeddings: a Hindi question finds an English note. Editing re-indexes (unchanged text reuses cached embeddings); deleting removes the chunks and vectors; at startup the index is reconciled with the notes. Notes are listed in their own tab, not among uploaded documents, and appear in document answers labelled "Note: …".

### Privacy of notes and memos

Notes and memo transcripts stay on the Mac by default. Their text reaches Gemini only when **both** the server allows it (`NOTES_SEND_TO_GEMINI=true`; default `false`) **and** the browser session ticks "Allow sending my matching notes and voice-memo text to Gemini" (devices: `DEVICE_ALLOW_NOTE_CONTEXT=true`, default `false`, because a device cannot tick a box). Go decides this per turn from those two settings only; nothing a model, tool result, document or note says can change it.

| | Sharing off (default) | Sharing on (setting + consent) |
|---|---|---|
| "What do my notes say about …?" | Gemini learns only how many notes or memos match (opaque ids and dates). The matches are listed on the page under the answer and in the Notes tab. | The titles, tags and excerpts (up to 400 characters) of the 5 best matches; `get_note` can read one note's text (up to 4000 characters). |
| Document search (`search_local_docs`, Documents mode) | Notes and memos are left out of what is sent; uploaded documents work as before. Documents mode without document consent still shows note passages locally. | Notes are included, labelled "Note: …". |
| Update/delete a note by voice | Gemini can pass an id; the confirmation question naming the note is spoken by the server, and the conversation history sent to Gemini later says only "one of their private notes". | Normal wording. |
| Saving a new note or memo by voice | What you dictate is your request, so Gemini has seen it in either mode. | Same. |

Local search and indexing are the same in both modes (the Notes tab search is never sent anywhere).

### "Let Gemini read my documents"

Uploaded documents are always searched on the Mac. Whether Gemini may read the few passages that match a question is one switch, **Let Gemini read my documents**, shown in three places that always agree: the top card of the **Documents** page (with an ON/OFF sentence), the bar under the assistant's message box, and **Settings → Privacy**.

- **OFF (private, the default in every new browser tab):** documents are only searched locally. In "My documents" mode the matching passages are listed under the answer and Gemini is not called; the spoken reply says how to switch the toggle on. Auto mode does not offer document search to Gemini.
- **ON:** the top `RAG_TOP_K` matching passages (never whole files) are sent with the question, so you can ask about your documents by voice or by typing. Turning it on asks for confirmation first. The choice is kept in the tab's `sessionStorage`, so it switches off when the tab is closed and every new tab starts OFF.

The page sends the choice with each typed and spoken turn (`allow_doc_context`); Go decides per turn from **`RAG_SEND_CONTEXT_TO_GEMINI` (server master switch) AND that choice**, and nothing a model, document or tool result says can change it. `RAG_SEND_CONTEXT_TO_GEMINI` now defaults to `true`, which only makes the switch available; with `false` the switch is disabled everywhere (with an explanation) and nothing from documents is ever sent.

**Desk device (ESP32).** A device cannot tick a box, so the Documents card has a second switch, **Desk device (ESP32)**, shown only when the device listener is enabled (`DEVICE_ADDR`). It starts at `DEVICE_ALLOW_DOC_CONTEXT` (default `false`), resets to that value whenever the assistant restarts, asks for confirmation before turning on (anyone who can speak to the device can then ask about your documents), and can never exceed the master switch: with `RAG_SEND_CONTEXT_TO_GEMINI=false` it is off and cannot be turned on. The page uses `GET /api/device-docs` and `POST /api/device-docs {"allowed": true|false}` (this Mac only, same-origin, logged without secrets; `403` while the master switch is off). When it is off, the device says that document access is not enabled for it and how to enable it, without mentioning screens or buttons.

**Voice memos.** Recording starts only when you press **Record** on the Voice memos tab and stops at `VOICE_MEMO_MAX_SECONDS` (default 120). The audio is transcribed by the local Whisper servers and discarded, unless you ticked **Keep the original audio**; kept recordings (16 kHz WAV, mode 0600) count against `VOICE_MEMO_MAX_STORAGE_MB` and are deleted with the memo. You review and edit the transcript before saving. Conversations with the assistant are never saved as memos unless you ask for a memo and confirm it.

## Email and announcement drafts

Gemini writes the draft; Go checks it and shows it on the confirmation card for review and editing (a device session hears it read aloud; verified with the device simulator). Recipients must be addresses you actually typed or said in the conversation, so none are invented; announcements have an audience instead. Saved drafts can be edited, copied and deleted on the Drafts tab. **Nothing is ever sent**: there is no sending code, and the optional Gmail integration only creates Gmail drafts.

**Sending is always done by you, in your own mail client.** Under each draft on the Drafts tab, and on the assistant's confirmation card once you approve a draft, three buttons open the draft pre-filled:

| Button | Opens |
|---|---|
| Open in Gmail | `https://mail.google.com/mail/?view=cm&fs=1&to=…&su=…&body=…` in a new tab |
| Open in Outlook | `https://outlook.office.com/mail/deeplink/compose?to=…&subject=…&body=…` (Microsoft 365) in a new tab |
| Mail app | a `mailto:` link for the computer's default mail app |

These are plain compose links: no OAuth, no API access, no `Mail.Send` permission and no `.env` setting. The program sends nothing; you review the message in your mail client and press Send there (or close it). The links use the values currently in the form, including unsaved edits. Only well-formed addresses are included (anything with spaces, commas, quotes or angle brackets is dropped), and line breaks are removed from the subject so it cannot add headers. If a link would exceed about 1900 characters (a long body), it is opened without the body and the text is copied to the clipboard for you to paste. Gmail and Outlook on the web need you to be signed in to that account in the browser; "Mail app" needs a default mail app configured in the operating system.

Status: the link formats are unit-tested and the buttons were checked in headless Chrome against the running app; they have **not** yet been opened against a real Gmail or Microsoft 365 account.

## ESP32 devices

Devices use the same tools and confirmation flow through the unchanged device protocol (document access: see the **Desk device** switch above): they hear the question (with "Please say yes or no", never wording about buttons or screens) and answer by voice after it has played. `DEVICE_PROFESSOR_TOOLS` controls what devices may do: `all` (default, with voice confirmation), `read` (questions only) or `none`. A device in a shared room can be heard by others; use `read` there.

**Hindi answers to a confirmation question.** While a question is pending, the reply is transcribed in the question's language (also when the language selector is on Auto, where automatic detection lost a third of the "no" answers), and Hindi replies are padded with silence and transcribed with the yes/no vocabulary as Whisper prompt. The classifier also accepts one measured Whisper artifact ("हाँद/हाँथ कर दो", a stray consonant after a leading हाँ) only when the rest is already a clear approval. Measured with `go run ./cmd/confirm-bench` on 95 fixture clips (Piper voices at three speeds; real FLEURS speech, 1-second fragments and noise as non-answers):

| | Hindi approvals | English approvals | Rejections (hi+en) | Non-answers that approved |
|---|---|---|---|---|
| Before | 7/21 (33%) | 12/12 | 21/21 | 0/41 |
| After | 15/21 (71%) | 12/12 | 21/21 | 0/41 |

Hindi transcription of these short answers: median 2.03 s → 2.17 s, p90 4.0 s → 2.2 s. A lone "हाँ" from the synthetic voice is still not recognised (Whisper hears "ठब"/"ठर"); anything unclear is asked again, never approved. Prefer "हाँ, ठीक है", "जी हाँ" or "नहीं, रहने दो". Real voices were not part of the fixtures.

## Optional Google integrations

Off unless `GOOGLE_CALENDAR_ENABLED` and/or `GMAIL_DRAFTS_ENABLED` are true and `GOOGLE_OAUTH_CLIENT_ID` (an OAuth client of type *Desktop app*) is set. Connect on the **Accounts** tab: the OAuth authorization-code flow with PKCE and a loopback redirect, requesting only `calendar.events.readonly` and/or `gmail.compose` (the narrowest scope that can create drafts; the send endpoint is never called). Tokens are stored in `GOOGLE_TOKEN_PATH` (0600), refreshed automatically, and removed on disconnect or when Google reports the grant revoked. Calendar events are cached for five minutes and offered to Gemini as the read-only `get_calendar_events` tool; the local timetable does not depend on them. "Create Gmail draft" on a saved email draft creates one Gmail draft (never twice) and records its id.

Status: implemented and tested against a mock of the documented Google endpoints; **not verified against a real Google account** (no OAuth client is configured on this Mac).

## Tools offered to Gemini

Read-only (run immediately): `get_today_timetable` (any date), `get_next_class`, `get_upcoming_events`, `get_free_time`, `list_reminders`, `search_notes`, `get_note`, `list_drafts`, and `get_calendar_events` when Google Calendar is connected.
Data-changing (confirmation required): `create_reminder`, `update_reminder`, `delete_reminder`, `save_note`, `update_note`, `delete_note`, `save_voice_memo`, `save_email_draft`, `save_announcement_draft`.

They are offered in Auto and General modes, through the same registry as `web_search` and `search_local_docs`. Gemini also receives the current local date and time and the tool rules.

**Tool selection** (`PROFESSOR_TOOL_ROUTING=true`): instead of all 17 declarations, each request is offered only the tool groups it needs (timetable, reminders, notes, drafts, calendar). Multilingual keywords pick the groups; the local e5 embedding (about 5 ms) only decides "professor request or general chat" and adds near-tie groups; a request that looks like a task without a keyword, any close call, and an unavailable embedder all get every tool; short follow-ups ("in the evening") keep the previous turn's tools. Routing can only remove permitted tools, so permissions and confirmations are unchanged. No extra Gemini request is made. Measured with `go run ./cmd/tool-bench`: needed tools offered for 43/43 tuning prompts and 34/34 held-out prompts (one held-out miss led to the near-tie rule, so that figure is optimistic); against real Gemini on 8 prompts × 3 runs, median time to first text 1775 ms (all tools) → 1394 ms (selected), Gemini requests per turn 1.71 → 1.62, correct tool calls 21/24 in both (the 3 misses were the same multi-tool prompt in both). Through the full pipeline (Gemini + Piper, typed input, routing on and off alternated 5 times): plain question first audio 1308 → 1077 ms median (on was faster in all 5 pairs); "What is my next lecture?" 2178 → 1973 ms (3 runs each). Routing itself took about 5 ms (up to 20 ms) per request. Set `PROFESSOR_TOOL_ROUTING=false` to always offer every tool. Professor turns may use up to `PROFESSOR_TOOL_MAX_CALLS` tool calls (default 4: find a record, then change it); search-only turns keep `TOOL_MAX_CALLS_PER_TURN`.

## Measured latency

Apple M2, real Gemini (`gemini-3.5-flash-lite`, minimal thinking), Whisper and Piper, typed input, 5 runs each, 20 October 2026:

| Turn | Gemini first text | First audio delivered |
|---|---|---|
| Plain question, professor tools offered | 853 ms (757-1426) | 1301 ms |
| Same question, Phase 5 disabled | 675 ms (624-689) | 1078 ms |
| "What is my next lecture?" (one tool) | 1797 ms (tool chosen after 900 ms; Go tool 1.9 ms) | 2171 ms |
| Reminder proposal (one round; the tool ends the turn) | 1015 ms | 1245 ms |
| "yes"/"no" to a pending question (no Gemini) | — | 89-109 ms; database write 1.9-2.6 ms |

Offering the 17 tool declarations costs about 180 ms per Gemini request. Note search through the index took 15-130 ms (embedding included); timetable and reminder queries 0.1-2.4 ms. A read-only tool question needs two Gemini requests: on the free tier (15 requests per minute for this model) a burst of tool questions can hit the quota, which is reported as "Gemini's request limit was reached; please try again in about a minute".

## Tests

```sh
go test ./internal/actions ./internal/professor          # confirmation workflow, classifier, timetable, reminders, scheduler, notes+index, memos, drafts
VOICE_NETWORK_TESTS=1 go test -race ./internal/server    # end-to-end over WebSocket and the ESP32 gateway with a tool-calling fake model
```

The server tests drive typed turns through the real pipeline with a scripted model that calls the tools, so every Go rule is exercised: confirmation by voice, text and buttons; rejection; superseded and re-asked questions; expiry; wrong, replayed, cross-session and concurrent action ids; interrupted questions; prompt injection; malformed arguments; invented recipients; ambiguous times; Hindi wording; device wording and the read-only device policy; REST origin checks; memo transcription with and without kept audio; reminder notifications; and the Google adapter against mocked endpoints.
