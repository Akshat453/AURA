# WebSocket protocol v1

Connect at `/ws` from this server's own origin (`VOICE_ALLOWED_ORIGINS`; other origins get 403). JSON text frames are control; binary frames are audio. A normal turn orders `listen_start`, microphone frames, `listen_stop`, `stt_result`, streamed `llm_delta`, ordered `tts_start` / WAV / `tts_end`, `metrics`, then `turn_complete`. `error` may end a stage. `abort` cancels work and queued playback.

## Binary frame

All header integers are big-endian; PCM samples are little-endian.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | ASCII `VAP1` |
| 4 | 1 | version `1` |
| 5 | 1 | kind: `1` input PCM16LE, `2` output WAV, `3` debug capture WAV, `4` debug Whisper WAV, `5` device output PCM ([device protocol](DEVICE_PROTOCOL.md)) |
| 6 | 2 | reserved flags |
| 8 | 4 | turn ID |
| 12 | 4 | sequence number |

Input is mono signed PCM16LE at the AudioContext's actual sample rate, declared in `listen_start.sample_rate` (8–192 kHz). The server validates the complete recording and resamples it once to 16 kHz for Whisper; changing metadata without converting samples is never allowed. Sequences start at zero and are contiguous. `listen_stop` is sent only after the AudioWorklet confirms that previously queued audio has flushed. Default maximum duration is 30 seconds; recordings below 200 ms, malformed, oversized, or effectively silent are rejected.

Output is one complete RIFF/WAV sentence. The sample rate is in its header and `tts_start`. The client accepts only the current turn and plays sequence order.

Client events are `listen_start`, `listen_stop`, `abort`, `clear`, `text_input`, `playback_started`, and development-only `debug_enable`. `listen_start` and `text_input` may carry Phase 4 retrieval options: `mode` (`general`, `documents`, `web`, `auto`; omitted means the server's `VOICE_DEFAULT_MODE`), `allow_doc_context` (the user consented to sending matching document passages to Gemini this session) and `document_id` (restrict document search to one document). Clients that send none of these, such as a future ESP32 device, get Auto mode without document passages. The playback event reports browser-observed first-audible latency for structured logging. Server events are `hello` (includes `capabilities`: rag_enabled, web_search, send_context_allowed, default_mode, device_docs, devices_enabled), `ready`, `stt_result`, `route` (the retrieval plan for the turn), `sources` (all sources so far: `id` D1…/W1…, `kind`, title, document/page/heading/chunk_id/similarity or url/published/retrieved_at, snippet), `tool_error` (`code` = tool name), `llm_delta`, `tts_start`, `tts_end`, `metrics`, `turn_complete`, `error`, Phase 5 `action_pending`, `action_result` and `reminder_due`, and development-only `debug_state`, `audio_debug`, and `audio_debug_transcript`. Turn-scoped events carry `turn_id`.

Audio kinds 3 and 4 exist only on the originating WebSocket after both server-side `VOICE_AUDIO_DEBUG=true` and session opt-in. There is no debug HTTP endpoint or persistent recording. Future codecs can use negotiated extensions while retaining turn and sequence semantics.

## Document HTTP API (localhost only)

`GET /api/docs` lists documents and capabilities. `POST /api/docs` (multipart field `file`) uploads; `DELETE /api/docs/{id}` deletes a document with its chunks, FTS rows and vectors; `POST /api/docs/{id}/reindex` re-indexes; `GET /api/docs/search?q=…&doc=…&k=…` returns retrieval hits without calling Gemini. State-changing calls require the header `X-Voice-Assistant: 1` and, when present, a same-host `Origin` and `Sec-Fetch-Site: same-origin`, so other web pages cannot upload or delete documents. Uploaded files are never served back.

## Phase 5: confirmations and professor API

When the assistant proposes a change, the server sends `action_pending` with `action_id` and `action` (`id`, `kind`, `summary`, `details`, `editable`, `expires_at`) after the turn that asked the question has completed. The client answers with `{"type":"action_confirm","action_id":"…","decision":"approve"|"reject","edits":{"body":"…"}}` (only fields listed in `editable`), or the user answers by voice/text. The server replies `action_result` with the action's final `status` (`done`, `rejected`, `failed`, `expired`, `superseded`) and `message`; errors carry `code` `unknown_action` (not this session's pending question), `expired`, `already_decided` or `failed`. `reminder_due` carries `reminder` (`reminder`, `due`, `overdue`) to every open tab. `listen_start` and `text_input` may carry `allow_note_context` (the user ticked the note-sharing box; effective only with `NOTES_SEND_TO_GEMINI=true`). While note text is private, `notes_found` (turn-scoped, `notes`: id, kind, title, snippet, updated_at) lists the matching notes for display only; it is never sent to Gemini. ESP32 devices never receive these events; they confirm by voice through the unchanged device protocol.

Localhost HTTP API (same rules as the document API: loopback only; state changes need `X-Voice-Assistant: 1` and a same-origin request; unknown JSON fields are rejected): `GET /api/professor`; `GET|POST /api/timetable`, `PUT|DELETE /api/timetable/{id}`, `GET /api/timetable/day?date=`, `GET /api/timetable/next`, `POST /api/timetable/import[?replace=1]`, `GET /api/timetable/export`; `GET|POST /api/reminders`, `PATCH|DELETE /api/reminders/{id}`; `GET|POST /api/notes`, `GET /api/notes/search?q=`, `GET|PATCH|DELETE /api/notes/{id}`; `POST /api/memos/transcribe?rate=&language=[&keep=1]` (raw PCM16 body), `GET|POST /api/memos`, `GET /api/memos/{id}/audio`, `PATCH|DELETE /api/memos/{id}`; `GET|POST /api/drafts`, `PUT|DELETE /api/drafts/{id}`, `POST /api/drafts/{id}/gmail`; `GET /api/google/connect|callback|events`, `POST /api/google/disconnect`.
