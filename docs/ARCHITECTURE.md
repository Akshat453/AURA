# Architecture

The backend is Node.js + Express (`backend/`); it replaced an equivalent Go backend without changing the wire protocols, the database files or the web UI. Package names below (`internal/…`) refer to the Go layout; the Node modules are mapped in [MIGRATION_PLAN.md](MIGRATION_PLAN.md#2-module-map).

```text
Browser microphone → AudioWorklet → native-rate mono PCM16 → WebSocket → Node.js backend
  → validation + complete-utterance band-limited resampling to 16 kHz PCM16
  → whisper.cpp /inference (local Metal: small for English, large-v3-turbo for Hindi/Hinglish/Auto)
  → retrieval routing (General / Documents / Web / Auto)
      search_local_docs → SQLite FTS5 + multilingual-e5 vectors (local)  ·  web_search → Tavily (cloud)
  → Gemini streaming text with evidence and function calling (cloud)
  → bounded sentence queue → warm Piper EN/HI (local)
  → ordered WAV frames → browser speaker
```

The Node.js backend owns session state, cancellation, bounded history, provider calls, and credentials. Each connection has one active turn. Starting another cancels the prior context. A single reader and mutex-serialized writer protect each WebSocket.

Provider interfaces (`STT`, `LLM`, `TTS`, `websearch.Provider`, `rag.Embedder`) isolate orchestration. Conversation history exists only in memory and is discarded on clear or disconnect. The databases are the local document index and the professor data (both SQLite, below).

Whisper and both Piper voices remain loaded. Gemini deltas reach the UI immediately; complete sentences enter a bounded synthesis queue while generation continues. Measurements cover STT, first text, LLM total, first synthesis, end-of-recording to first audio delivery, and total turn. Cold/warm benchmark values must come from actual runs and are never fabricated.

The browser deliberately does not resample. This keeps all conversion in one tested backend implementation and avoids per-AudioWorklet-block discontinuities. A stop/flush acknowledgement crosses the worklet message port before `listen_stop`, so every PCM message queued before release is delivered first. The worklet is connected through a zero-gain output node to keep the Web Audio graph alive without monitoring the microphone through the speakers.

## ESP32-S3 path

Devices use a separate listener (`DEVICE_ADDR`, WSS only) that serves just `/device`; see [DEVICE_PROTOCOL.md](DEVICE_PROTOCOL.md). After a per-device HMAC challenge-response, a device session is an ordinary `client` with a `deviceLink`: its control messages are validated and translated into the browser's internal events (`utterance_start` → `listen_start`, `utterance_end` → `listen_stop`), so recording, Whisper routing, retrieval, Gemini, history and cancellation are shared code. Only output differs: `client.speak` sends the browser one WAV per sentence, and sends a device Piper's audio resampled to 16 kHz PCM through a bounded queue and a pacer (lead prefill, then real time, re-priming after late audio) with write deadlines. The binary header is the same VAP1 header; kind 5 carries downlink PCM. Opus can be added later by codec negotiation in `hello`.

## Phase 4: search and local documents

```text
Upload (browser, /api/docs) → backend validation (type, signature, size, safe name) → data/rag/files/<id>.<ext> (0600)
  → background worker: extract (backend: TXT/MD/DOCX/PPTX; sidecar: PDF via PyMuPDF) → clean → chunk (~350 tokens,
    ~50 overlap, by heading/paragraph, never across pages) → embed "passage: …" (sidecar, e5-small ONNX, cached by
    text hash) → SQLite: documents, chunks, FTS5, embeddings → in-memory vector index
Question → plan = assist.Route(mode, capabilities)
  Documents: search_local_docs(question) → evidence → one Gemini call      (no consent: show passages, skip Gemini)
  Web:       web_search(question)       → evidence → one Gemini call
  Auto:      Gemini with tools [web_search?, search_local_docs?] → the backend executes calls (max TOOL_MAX_CALLS_PER_TURN) → continue
  General:   Gemini only
Answer → [D1]/[W1] citations checked against retrieved sources → UI links; Piper speaks text without markers/URLs
```

* **The backend owns everything except two model-bound tasks.** `scripts/rag_sidecar.py` (localhost:8084) only embeds text
  and extracts PDF text; the backend does document management, chunking, storage, retrieval, routing, tool execution and
  sessions. If the sidecar is down, the app still runs: search falls back to keywords and PDFs wait.
* **Storage.** `better-sqlite3` (SQLite with FTS5 built in; the same files and schema the original Go backend created). Vectors are therefore float32 blobs
  in SQLite searched by an exact in-memory cosine scan, the same brute-force KNN `vec0` performs; at ≤10k chunks it
  takes a few milliseconds. `rag.Store` hides this, so sqlite-vec can replace it.
* **Hybrid retrieval.** FTS5 BM25 over keyword-normalized text (letter/digit boundaries split, so CS301 = CS-301) and
  cosine over e5 embeddings each give 20 candidates; Reciprocal Rank Fusion (k=10, measured) merges them; vector-only
  hits below `RAG_MIN_SIMILARITY` are dropped; top `RAG_TOP_K` are returned. No reranker: Recall@5 is already 100%
  on the labelled set (docs/RAG.md).
* **Prompt injection and grounding.** Evidence is wrapped in `<evidence>` (its closing tag is stripped from content)
  or returned as tool results marked untrusted; the system prompt forbids following instructions inside it, requires
  [ID] citations for supported claims, and requires saying when the evidence lacks the answer. Citation IDs in the
  answer are checked against the turn's sources; unknown IDs are reported as `invalid_citations` and struck through.
* **Privacy.** Files, text, embeddings and the index never leave the Mac. Document passages (top-k chunks, never whole
  files) reach Gemini only when `RAG_SEND_CONTEXT_TO_GEMINI=true` **and** the tab's **Let Gemini read my documents** switch is on (devices: the Desk device switch on the Documents page).
  Logs contain IDs, sizes and timings only, never document text, questions or answers.
* **Latency.** Documents/Web modes retrieve with the user's words and call Gemini once; Auto costs a second Gemini
  round trip only when a tool is actually used. Indexing runs on one background worker; queries never wait for it.

## Phase 5: professor tools

```text
Question → plan (General/Auto also offer professor tools) → Gemini with tools + current local date/time
  read-only tool (timetable, reminders, notes, drafts) → the backend runs it at once → Gemini answers
  data-changing tool → the backend validates → actions.Session.Stage(proposal, server-written question) → ErrEndTurn ends Gemini's turn
    → question spoken → turn completes → Commit (answerable for ACTION_CONFIRMATION_TIMEOUT_SECONDS)
Next input "yes"/"no" (classified locally) or browser action_confirm {action_id} → revalidate → execute once → result from the database
Scheduler (in the backend process, timer to the next due reminder) → reminder_due to open browser tabs (+ optional macOS notification)
```

* `internal/professor` owns `professor.db` (classes, reminders, notes, memos, drafts; migrations in `PRAGMA user_version`) and the tool definitions; `internal/actions` owns proposals, confirmation state and the yes/no classifier. Tools are added to the existing `assist.Turn` registry (`Extra`), so there is one tool system.
* The model never executes anything: tools run in Go, and data-changing tools only stage proposals. Approval comes only from the user's own words or a button with the session's action id; the model's text, tool results and documents cannot approve. Proposals are bound to one connection and discarded when the asking turn does not complete.
* Notes and memo transcripts are indexed in the document index under reserved ids (`note-…`, `memo-…`) via `rag.Service.PutText`, reusing the embedding cache; `rag.ScopeNotes` / `rag.ScopeUploads` filter searches; the upload list and upload/replace paths exclude them.
* WebSocket writes use a context that turn cancellation cannot interrupt (a cancelled write would close the whole connection in coder/websocket); writes for an already-cancelled turn are skipped. This also fixed an abort racing with TTS disconnecting the browser.
