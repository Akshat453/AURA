# Backend migration plan: Go → Node.js + Express

Status: analysis complete (Phase 1). The Go implementation is preserved on the
branch `go-backend-archive` (commit `972f026`) until the Node.js backend has been
verified. Baseline before any change: `VOICE_NETWORK_TESTS=1 go test ./...` —
all 17 test packages pass (server suite 52 s).

## 1. What exists today

* One Go module (`go.mod`, Go 1.26): ~14 000 lines of application code and
  ~6 000 lines of tests, plus 11 commands under `cmd/`.
* A browser UI (`internal/server/web`, vanilla ES modules, embedded into the Go
  binary) and a development STT dashboard (`internal/server/devweb`).
* Two SQLite databases (pure-Go `modernc.org/sqlite`, FTS5 built in):
  `data/professor/professor.db` (schema version 1 in `PRAGMA user_version`) and
  `data/rag/index.db` (created with `CREATE … IF NOT EXISTS`, WAL mode).
* External processes (unchanged by the migration): two `whisper-server`
  processes (whisper.cpp), two Piper HTTP servers, the Python RAG sidecar
  (`scripts/rag_sidecar.py`: `GET /`, `POST /embed`, `POST /extract/pdf`).
* Cloud services: Gemini (`google.golang.org/genai`), optional Tavily, optional
  Google OAuth / Calendar / Gmail drafts.
* ESP32-S3 firmware (`firmware/aura_single_usb`) speaking the VAP1 device
  protocol over WSS. **The firmware is not modified.**

## 2. Module map

| Go package / command | Responsibility | Node.js module |
|---|---|---|
| `internal/config` | env parsing, defaults, validation, `.env` reader | `src/config/env.js`, `src/config/dotenv.js` (Zod-validated, same messages) |
| `internal/protocol` | VAP1 header, browser event | `src/websocket/protocol.js` |
| `internal/device/protocol.go` | device messages, validation, codec negotiation | `src/websocket/deviceProtocol.js` |
| `internal/device/creds.go` | registry, HMAC, rotation, revocation | `src/security/hmac.js`, `src/modules/device/registry.js` |
| `internal/device/tlsgen.go`, `perm.go` | private CA, server cert, TLS config, permission checks | `src/security/certificates.js` |
| `internal/device/pacer.go` | playback pacing model | `src/websocket/playbackPacer.js` |
| `internal/device/client.go` | reference device client, playback simulation | `src/modules/device/client.js` |
| `internal/audio` | PCM validation, speech gate, resampling, WAV, alignment | `src/utils/audio.js` |
| `internal/session` | bounded history, turn cancellation | `src/websocket/session.js` |
| `internal/pipeline` | sentence splitter, speakable text | `src/services/pipeline.js` |
| `internal/metrics` | turn metrics shape | (plain objects, same JSON keys) |
| `internal/provider` | provider interfaces, `ErrEndTurn` | `src/services/provider.js` |
| `internal/stt` | whisper.cpp client, gate, router | `src/services/speech/*.js` |
| `internal/tts` | Piper client | `src/services/tts/piper.js` |
| `internal/llm` | Gemini streaming, tool loop, retries | `src/services/llm/gemini.js` (`@google/genai`) |
| `internal/websearch` | Tavily client, cache | `src/services/websearch/tavily.js` |
| `internal/rag` | extraction, chunking, store, FTS5, vectors, RRF | `src/services/rag/*.js`, `src/services/embeddings/sidecar.js` |
| `internal/assist` | routing plan, search tools, citations, intent router | `src/services/assist/*.js` |
| `internal/actions` | confirmation workflow, yes/no classifier | `src/modules/actions/*.js` |
| `internal/professor` | timetable, reminders, scheduler, notes, memos, drafts, tools, seed | `src/modules/professor/*.js`, `src/scheduler/scheduler.js` |
| `internal/eval` | STT fixtures and WER/CER scoring (dev tools) | `src/utils/eval.js` |
| `internal/server` | HTTP routes, `/ws`, device gateway, Google, dev tools | `src/app.js`, `src/routes/*`, `src/middleware/*`, `src/websocket/*` |
| `cmd/professor-assistant` | main | `src/server.js` |
| `cmd/devicectl`, `device-sim`, `config-check`, `db`, `e2e-check` | operations CLIs | `bin/*.js` |

## 3. API surface to preserve exactly

HTTP (localhost listener `VOICE_ADDR`): `/` (UI), `/web/*`, `/healthz`,
`/readyz`, `/ws`; `/api/docs` (GET, POST multipart), `/api/docs/{id}` (DELETE),
`/api/docs/{id}/reindex` (POST), `/api/docs/search`, `/api/device-docs`
(GET, POST); `/api/professor`; `/api/timetable` (GET, POST), `/api/timetable/{id}`
(PUT, DELETE), `/api/timetable/day`, `/next`, `/export`, `/import[?replace=1]`;
`/api/reminders` (GET, POST), `/api/reminders/{id}` (PATCH, DELETE);
`/api/notes` (GET, POST), `/api/notes/search`, `/api/notes/{id}` (GET, PATCH,
DELETE); `/api/memos/transcribe`, `/api/memos` (GET, POST),
`/api/memos/{id}/audio`, `/api/memos/{id}` (PATCH, DELETE); `/api/drafts`
(GET, POST), `/api/drafts/{id}` (PUT, DELETE), `/api/drafts/{id}/gmail`;
`/api/google/connect|callback|events|disconnect`; dev only: `/dev/*`.

Rules: every `/api` route is loopback-only (403 otherwise); state changes need
`X-Voice-Assistant: 1`, a same-host `Origin` when present and
`Sec-Fetch-Site` same-origin/none; JSON bodies ≤ 256 KB with unknown fields
rejected (400); errors are `text/plain` + newline (the UI shows the text);
`X-Content-Type-Options: nosniff` and `Cache-Control: no-store` everywhere.

Browser WebSocket `/ws` (origin allow-list, coder/websocket semantics): client
events `listen_start`, `listen_stop`, `abort`, `clear`, `text_input`,
`playback_started`, `action_confirm`, `debug_enable`; server events `hello`,
`ready`, `stt_result`, `route`, `sources`, `tool_error`, `llm_delta`,
`tts_start`, `tts_end`, `metrics`, `turn_complete`, `error`, `action_pending`,
`action_result`, `reminder_due`, `notes_found`, `debug_state`, `audio_debug`,
`audio_debug_transcript`. Binary VAP1 kinds 1 (in), 2 (WAV out), 3/4 (debug).

Device WSS (`DEVICE_ADDR`, separate TLS listener, only `/device` and
`/healthz`): `challenge` → `hello` (HMAC-SHA256 over
`"VAP1-AUTH\n" + device_id + "\n" + nonce_hex`, key = hex-decoded secret) →
`ready`; `utterance_start` → `audio_start` → kind-1 frames → `utterance_end`
→ `stt_result`, `tts_start`, kind-5 frames (paced: `lead_ms` prefill, then real
time), `tts_end`, `metrics`, `turn_complete`; `abort`, `playback_state`,
`ping`/`pong`, errors (`bad_hello`, `unauthorized`, `unsupported_codec`, `busy`,
`bad_request`, `bad_message`, `bad_audio`, `utterance_timeout`, `stt_failed`,
`stt_busy`, `llm_failed`, `tts_failed`, `playback_failed`), close codes 1008 /
1003 / 1013 / 1001. Header: `VAP1`, version 1, kind, flags (BE u16), turn
(BE u32), sequence (BE u32); 16 kHz mono s16le; ≤ 4 KB control, ≤ 8 KB audio.
JSON field names and omission of zero values (Go `omitempty`) are preserved,
because the firmware parses `type`, `turn_id`, `nonce`, `lead_ms` with a 1 KB
receive buffer.

## 4. Database

The Node backend opens the **same files** with `better-sqlite3` (FTS5 built
in). Schemas are byte-for-byte the Go DDL; the professor migrations keep using
`PRAGMA user_version`, so an existing database (version 1) is opened without
any migration and no row is rewritten. Timestamps stay Unix seconds; vectors
stay little-endian float32 BLOBs; reserved index ids (`note-…`, `memo-…`) and
demo ids (`*_seed*`) are unchanged. Compatibility is tested by copying the
real databases to a temporary directory and reading/writing them with Node.

## 5. External integrations

whisper.cpp (`POST /inference`, multipart, same fields and per-server FIFO
gate), Piper (`/info`, `/synthesize`, retry on a fresh connection), RAG
sidecar (unchanged Python process), Gemini (`@google/genai`: streaming,
function calling with thought signatures, AUTO→NONE after the call limit,
retries before first text), Tavily (`/search`, cache, one transient retry),
Google OAuth PKCE + Calendar read-only + `gmail.compose` drafts (never send).

## 6. Security requirements (all carried over)

Private CA + TLS ≥ 1.2 on the device listener; credential files must be 0600
(server refuses otherwise); HMAC challenge-response with constant-time compare,
fresh 256-bit nonce per connection, same error and 300 ms delay for unknown /
revoked / wrong-secret devices; Origin header ⇒ 403 on `/device`; 16 pending
handshakes, `DEVICE_MAX_CONNECTIONS`, hello timeout, utterance timeout,
heartbeats closing revoked or silent devices; loopback-only and same-origin
APIs; request size limits; no secrets, audio or transcripts in logs;
confirmation workflow (stage → commit after the question is fully delivered →
approve once, per session, with expiry); locally classified yes/no; evidence
delimiting and untrusted tool results; documents and notes private by default
(`RAG_SEND_CONTEXT_TO_GEMINI` + per-session consent, `NOTES_SEND_TO_GEMINI` +
consent, desk-device switch); email is never sent.

## 7. Testing plan

Port every Go test to `node:test` (unit, protocol, security, integration with a
real TLS listener and fake STT/LLM/TTS), add tests for API validation, real
database compatibility and the CLIs, keep the existing browser-helper tests,
run `scripts/ui-check.mjs` (headless Chrome) against the Node server, run the
simulator against the Node server with the real whisper.cpp / Piper / sidecar
processes, and compare latency with the Go binary. Hardware results are
reported only if a physical ESP32 is used.
