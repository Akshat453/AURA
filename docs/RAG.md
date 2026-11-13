# Search and local documents (Phase 4)

> **Backend migration note.** The backend now runs on Node.js (`backend/`). The offline evaluation tools `cmd/stt-bench`, `cmd/rag-eval`, `cmd/tool-bench`, `cmd/confirm-bench` and `cmd/fetch-fixtures` were not ported to Node.js and are not part of this repository; the commands below that use them describe the original Go tooling. See [MIGRATION_PLAN.md](MIGRATION_PLAN.md).

The assistant can answer from the professor's uploaded documents (`search_local_docs`) and from current web results (`web_search`), with citations. Architecture: [ARCHITECTURE.md](ARCHITECTURE.md#phase-4-search-and-local-documents).

## Setup

```sh
./scripts/setup-local.sh          # also creates runtime/rag-venv and downloads multilingual-e5-small
./scripts/start-local.sh          # starts the RAG sidecar on 127.0.0.1:8084 with the other services
```

| Download | Size | Licence | Purpose |
|---|---|---|---|
| `intfloat/multilingual-e5-small` ONNX (revision `614241f`, SHA-256 checked) | 470 MB + 17 MB tokenizer | MIT | Multilingual passage/query embeddings |
| PyMuPDF 1.28.2 | ~20 MB | **AGPL-3.0** (fine for local private use; review before redistributing) | PDF text extraction |
| onnxruntime 1.31.0, tokenizers 0.23.3, numpy 2.4.6 | ~30 MB | MIT / Apache-2.0 / BSD | Running the model on the CPU |
| Go: `modernc.org/sqlite` v1.60.1 | — | BSD-3 | SQLite with FTS5, pure Go |

`setup-local.sh` needs a Python 3.10+ whose `pip` works. On this Mac Homebrew `python@3.10` is broken (`pyexpat` cannot load), so run `RAG_PYTHON=/opt/anaconda3/bin/python ./scripts/setup-local.sh`.

## Using documents

1. Open http://127.0.0.1:8090 and use **Documents → Upload** (PDF, TXT, Markdown, DOCX, PPTX; up to `RAG_MAX_UPLOAD_MB`, default 25 MB).
2. Status goes `queued → extracting → embedding → ready`, or `error` with the reason (for example a scanned PDF: *OCR is required*). Uploading identical content again is detected as a duplicate. Uploading a changed file with the same name re-indexes it under the same ID and reuses embeddings for unchanged text. **Reindex** and **Delete** are per document; delete removes the file, chunks, keyword index and vectors.
3. **Test retrieval** in the Documents card: type a question in English or Hindi to see the passages, scores and timings. Nothing is sent to Gemini.
4. Choose **Answer using: My documents** (or Auto) and ask by voice or text.

### Sending passages to Gemini (privacy)

Gemini runs in Google's cloud. By default **no document text leaves the Mac**: in Documents mode the assistant finds the matching passages, says how many, and shows them on screen. To let Gemini write answers from them:

1. Read what is sent: only the top `RAG_TOP_K` (default 5) matching passages of about 350 tokens each, with file name and page, for that question. Whole files, other documents and the index are never sent. Google's API terms apply to that text.
2. Keep `RAG_SEND_CONTEXT_TO_GEMINI=true` (the default; `false` disables the switch everywhere) and run `./scripts/start-local.sh`.
3. Switch on **Let Gemini read my documents** (Documents page, the assistant's message bar, or Settings → Privacy) and confirm. It applies to that browser tab only and is OFF in every new tab. Auto mode only offers `search_local_docs` to Gemini when both are set. See [professor tools](PROFESSOR_TOOLS.md#let-gemini-read-my-documents), which also covers the desk-device switch.

Do not upload files you are not allowed to process this way, for example student records, unless sending is turned off.

## Web search (Tavily)

1. Create a free account at https://app.tavily.com and copy the API key (`tvly-…`). The free plan gives monthly credits; each basic search costs 1 credit. The app never uses paid "advanced" searches.
2. Add `TAVILY_API_KEY=tvly-…` to `.env` (never commit it) and run `./scripts/start-local.sh`. The page shows **Web search: tavily**.
3. Use **Answer using: Web search** or Auto. Results are cached for `WEB_SEARCH_CACHE_TTL` (15 min) so repeated questions do not spend credits. Without a key the app starts normally and web search shows as not configured.

Errors are reported to the user and to Gemini instead of being hidden: an invalid key (401), rate limiting (429, with Retry-After), and exhausted quota (432/433). Timeouts and 5xx errors are retried once.

## Modes

| Mode | What happens | Gemini calls |
|---|---|---|
| General | Gemini only | 1 |
| My documents | `search_local_docs` with your words, then Gemini answers from the passages (or passages are shown locally without consent) | 1 (0 without consent) |
| Web search | `web_search` with your words, then Gemini answers from the results | 1 |
| Auto (default) | Gemini may call `web_search` and/or `search_local_docs`; ordinary chat calls nothing | 1, or 2 when a tool is used |

At most `TOOL_MAX_CALLS_PER_TURN` (2) tool calls per turn; after that Gemini must answer. Each search is limited to 10 s.

## Measured results (16 October 2026, Apple M2, 16 GB)

### Retrieval (`go run ./cmd/rag-eval`, real e5 model, 6 documents, 22 labelled questions)

| Method | Recall@1 | Recall@5 | MRR | Hindi R@1 | Median latency |
|---|---|---|---|---|---|
| Keyword (FTS5) | 58% | 79% | 0.68 | 0% | 0.2 ms |
| Vector (e5) | 63% | 84% | 0.74 | 80% | 5.5 ms |
| Hybrid, RRF k=60 | 68% | 100% | 0.82 | 100% | 5.6 ms |
| **Hybrid, RRF k=10 (default)** | **74%** | **100%** | **0.84** | **100%** | **5.2 ms** |

19 answerable questions (12 English, 5 Hindi, 2 romanized Hinglish) over English documents. Absent topics: 2 of 3 returned no passages; "machine learning syllabus" matched the DBMS syllabus by keyword, and Gemini then correctly said the documents do not cover it. The set is small; one question is 5 percentage points of Recall@1.

Behaviour checks (all passed): duplicate upload detected; edited file re-indexed under the same ID; old text gone and new text found; scanned PDF reported as needing OCR; every PDF citation's page contains the cited text; deleting a document leaves no chunks, FTS rows, vectors or hits.

Indexing the 6 documents took 0.4 s. A query embedding takes about 4–6 ms; fused retrieval 5–15 ms per question.

### End-to-end (real Whisper, Gemini, Piper; web search via a local mock of Tavily's documented API)

| Test | Result |
|---|---|
| General question, voice | Answer spoken; STT 497 ms, first audio 5.7 s |
| Document question, voice ("unit three of the database syllabus") | Cited the Unit 3 chunk, valid citation; first audio 5.3 s |
| Hindi voice question over English PDF | Whisper turbo misspelled words, retrieval still put page 3 first; Devanagari answer "…तेईस प्रतिशत…" [D1], Hindi voice |
| Typed Hindi question over English PDF | Correct, page 3 cited |
| Missing information | "The uploaded documents do not cover a machine learning course" |
| Prompt injection in a document | Instructions ignored; only the lab timings answered |
| Documents mode without consent | Local reply, passages shown, Gemini not called, 250 ms total |
| Auto mode, document question | Gemini called `search_local_docs`, cited notes and syllabus |
| Auto mode, ordinary chat | No search |
| Web mode / Auto mode (mock search) | W1/W2 cited with URLs and dates; the repeated question was served from cache |
| Invalid Tavily key (real API) | "web search API key was rejected"; no invented sources |
| Quota exhausted (mock 432) | Reported honestly |
| Cancellation during generation | No audio after abort; connection cleaned up |
| Follow-up turn | "its end-semester examination" resolved to CS-301 (40 marks) |
| Browser UI (headless Chrome) | Upload list, OCR error, retrieval tester, sources and citation links render; no script errors or injected HTML |
| Every answer | 0 invalid (fabricated) citation IDs |

**Gemini latency was degraded during these tests.** Direct REST calls to `gemini-3.5-flash-lite`, bypassing the app, took 2.9–9.8 s and one returned HTTP 503 "high demand". The app now retries 503/429 twice with backoff before any text is spoken. Local stages measured: Whisper 0.3–0.5 s (English), 1.7 s (Hindi); retrieval 6–15 ms; first Piper sentence 0.2–0.5 s. End-to-end first audio was 5–16 s, almost all of it Gemini time-to-first-token.

## Limitations

- **No live Tavily test yet**: add `TAVILY_API_KEY` and ask a Web-mode question to verify the account. Request format, parsing, errors and caching are covered by unit tests and the mock.
- OCR for scanned PDFs is not implemented; such files are rejected with a clear error.
- Chunk token counts are estimated (no tokenizer in Go); e5 truncates inputs above 512 tokens.
- Romanized Hinglish questions rely on the multilingual embeddings; keyword search cannot match them to Devanagari text.
- Auto mode adds a second Gemini round trip when a tool is used.
- The labelled retrieval set is small; evaluate on real course material before trusting the numbers.
