# Professor Voice Assistant (AURA) — Phases 0, 3, 4 and 5

[![CI](https://github.com/goswamimoksh455-max/Voice-assistance-IOT-Project/actions/workflows/ci.yml/badge.svg)](https://github.com/goswamimoksh455-max/Voice-assistance-IOT-Project/actions/workflows/ci.yml) [![CD](https://github.com/goswamimoksh455-max/Voice-assistance-IOT-Project/actions/workflows/cd.yml/badge.svg)](https://github.com/goswamimoksh455-max/Voice-assistance-IOT-Project/actions/workflows/cd.yml)

A localhost-only, push-to-talk voice assistant for English, Hindi, and Hinglish. The browser captures audio, the Node.js backend coordinates persistent local whisper.cpp services, streams text from Gemini, and begins sentence-level synthesis through two warm local Piper services. Phase 4 adds answers from uploaded documents (local hybrid search with multilingual embeddings) and from the web (Tavily), with citations; see [search and documents](docs/RAG.md). Documents stay private (searched only on this Mac) until you switch on **Let Gemini read my documents**, which is off in every new browser tab; only the few matching passages, never whole files, are then sent to Gemini. `RAG_SEND_CONTEXT_TO_GEMINI=false` disables that switch everywhere, and a separate **Desk device** switch governs ESP32 questions; see [professor tools](docs/PROFESSOR_TOOLS.md#let-gemini-read-my-documents). Phase 5 adds professor tools — timetable, reminders, notes, voice memos and email/announcement drafts — where every change the assistant proposes must be confirmed by voice or with a button; see [professor tools](docs/PROFESSOR_TOOLS.md).

> Scope: the laptop prototype (Phase 0), local speech recognition and synthesis (Phase 3), document and web answers (Phase 4) and professor tools (Phase 5), the ESP32 device protocol with a simulator, and the AURA desk-device firmware (`firmware/aura_single_usb`). **The firmware compiles in CI but has not yet completed a turn on a physical board**: see the hardware status in [device protocol](docs/DEVICE_PROTOCOL.md).

## Requirements

Validated target: Apple M2 (ARM64), macOS 26.1, 16 GB RAM, Metal supported. The setup uses whisper.cpp v1.9.4, multilingual `ggml-small.bin` (English) and `ggml-large-v3-turbo-q5_0.bin` (Hindi, Hinglish, Auto), Piper 1.8.0, `en_US-lessac-medium`, and `hi_IN-priyamvada-medium`. Node.js 24 LTS or newer (the backend, `backend/`) and Python 3.10 are required. Python 3.10 is intentional: pip bundled with the detected Homebrew Python 3.12 fails to identify macOS 26.

## Setup and run

```sh
brew install node cmake python@3.10
RAG_PYTHON=/opt/anaconda3/bin/python ./scripts/setup-local.sh   # any Python 3.10+ whose pip works
cp .env.example .env
# Edit .env and set GEMINI_API_KEY. Never commit this file.
./scripts/start-local.sh
```

Step-by-step start, stop, health checks, ESP32 testing and troubleshooting: [docs/STARTUP.md](docs/STARTUP.md). Audit `.env` (read-only, never prints secrets): `node backend/bin/config-check.js`.

The script waits until every service answers (if one exits during startup it prints that service's last log lines and stops), warms up a Whisper server once after it (re)starts, and prints `All services ready`. Running it again restarts only services whose code or settings changed. Interrupting it leaves already-started services running; stop them with `./scripts/stop-local.sh`.

Piper must be reached at `127.0.0.1`, not `localhost`: on macOS, AirPlay Receiver also listens on port 5000, and `localhost:5000` can reach it instead of Piper. The readiness check reports this as "not a Piper server".

Open <http://127.0.0.1:8090>. Use the text box to validate Gemini and Piper without microphone access. Check readiness with `curl -i http://127.0.0.1:8090/readyz`. Stop only the processes started by this project with `./scripts/stop-local.sh`.

Only `GEMINI_API_KEY` is secret and required from you; `TAVILY_API_KEY` is optional and enables web search. The local Whisper and Piper settings already have defaults. `.env` is intentionally hidden in Finder and many editors because its name starts with a dot; create it with `cp .env.example .env`, then enable hidden files in Finder with `Command-Shift-.` if needed.

The setup installs the backend dependencies from `backend/package-lock.json` (`npm ci`), clones the pinned whisper.cpp release, builds with Metal, downloads the multilingual small and large-v3-turbo models, creates a Python 3.10 virtual environment, installs pinned Piper, and downloads both voices. Models, logs, PIDs, binaries, and `.env` are ignored by Git.

## Demo data (SQLite)

For demos and evaluation, realistic **fictional** data lives in separate SQLite databases in `DEMO_DATA_PATH` (default `./data/demo`), served by a second instance on http://127.0.0.1:8091. Your own data (`PROFESSOR_DATA_PATH`, `RAG_STORAGE_PATH`) and the main app on 8090 are never touched.

```sh
node backend/bin/db.js check      # read-only health check: SELECT 1, tables, integrity, foreign keys
node backend/bin/db.js seed       # idempotent: 16 classes, 26 reminders, 25 notes, 12 memos, 14 drafts, 4 documents
./scripts/start-demo.sh    # demo instance on http://127.0.0.1:8091 (stop: ./scripts/start-demo.sh stop)
node backend/bin/db.js counts     # rows per table (demo vs. your own)
node backend/bin/db.js reset      # dev only: moves the demo databases to data/demo-backups/<time>/, then re-seeds
```

Demo rows have IDs containing `_seed` (for example `rem_seed03`); the seed only upserts those IDs, so it never changes or deletes other rows. Seed and reset refuse to run when `APP_ENV=production` unless `--force` is given. **Demo logins: none** — the assistant is a single-user app on the professor's Mac with no accounts or roles, so no demo users are created.

## Configuration and tests

All settings are in `.env.example`. The backend exclusively reads `GEMINI_API_KEY`; it is never exposed or logged. `gemini-3.5-flash-lite` with `minimal` thinking is the default. `gemini-3.8-flash` is an explicit alternative and requires `low`, `medium`, or `high`; invalid `minimal` use is rejected. No paid fallback occurs.

```sh
make test                                  # ESLint + the whole Node test suite (npm test --prefix backend)
npm run --prefix backend lint              # ESLint only
npm test --prefix backend                  # unit, protocol, security, integration and browser-helper tests
npm run --prefix backend test:protocol     # only the VAP1 / device / browser WebSocket protocol tests
npm run --prefix backend test:security     # only authentication, TLS, origin, CSRF and privacy tests
node backend/bin/e2e-check.js -text "What does Unit 3 cover?" -mode documents -allow-docs   # one real turn (services running)
node scripts/ui-check.mjs --url http://127.0.0.1:8093 --allow-writes --clip <wav>          # headless-Chrome UI check of a TEST instance
```

The test suite (`backend/tests/`) starts real HTTP, WebSocket and TLS listeners on localhost with fake Whisper, Gemini, Piper, Tavily and Google services: no models, no network and no paid API calls. It covers VAP1 framing, HMAC authentication, TLS verification, revocation, heartbeats, pacing, aborts and reconnects, PCM conversion, the speech gate, resampling, WAV encoding, the confirmation workflow, privacy switches, prompt-injection resistance, the REST API rules, the RAG pipeline, the professor data and the CLIs. Real integration checks require downloaded models and a user-provided Gemini key; mock tests are never represented as real inference.

### Backend layout

```text
backend/
  src/server.js            entry point (wires providers, listeners, scheduler, shutdown)
  src/app.js               server state + Express app (REST API, static web UI, /ws upgrade)
  src/config/              env.js (Go-compatible parsing, Zod validation), logger.js (pino)
  src/routes/ middleware/  REST routes and security middleware (loopback, same-origin, limits)
  src/websocket/           VAP1 protocol, browser /ws gateway, ESP32 device gateway, pacer, client turn pipeline
  src/services/            speech (whisper.cpp), tts (Piper), llm (Gemini), rag, embeddings (sidecar), websearch, assist, google
  src/modules/             device registry/client, professor, notes, memos, email drafts, actions, confirmation, reminders
  src/security/            HMAC, private CA and certificates, permission checks
  src/scheduler/ database/ reminder scheduler, professor migrations
  bin/                     devicectl, device-sim, config-check, db, e2e-check
  public/                  the web UI (unchanged) and the /dev/ STT dashboard
  tests/                   unit, protocol, security, integration, frontend
```

The backend was migrated from Go; the migration is documented in [docs/MIGRATION_PLAN.md](docs/MIGRATION_PLAN.md). The original Go sources are not part of this repository, and the Go-only offline evaluation tools (`stt-bench`, `rag-eval`, `tool-bench`, `confirm-bench`, `fetch-fixtures`) were not ported.

## CI/CD and Scrum

Every push and pull request runs the CI pipeline (ESLint, the Node test suite on Node 24 and 26, `npm audit`, script checks, the firmware build, a clean-install smoke test of the packaged backend and a smoke test of the Docker image). Every merge to `main` publishes a Docker image to GitHub Container Registry and verifies it; every `vX.Y.Z` tag also creates a GitHub Release with the backend package. See [CI/CD](docs/CI_CD.md).

The project is planned and run with Scrum in three two-week sprints; the week-by-week plan, Definition of Done, velocity and burndown are in [Scrum plan](docs/SCRUM_PLAN.md). `scripts/scrum/setup-github.sh` puts the backlog, sprints (milestones) and labels on GitHub.

## Behavior and limitations

- The AudioWorklet emits mono PCM16 at the browser AudioContext's actual rate (commonly 44.1 or 48 kHz). The backend validates and resamples the complete utterance once to 16 kHz with a band-limited converter before transcription. Whisper HTTP is not presented as incremental streaming.
- TTS starts on the first completed sentence while Gemini continues streaming. Turn and sequence IDs reject stale or reordered audio.
- Microphone capture is disabled while speech plays. Stop cancels generation and playback. Full duplex and wake words are not implemented in the browser. The AURA firmware has the wake word ("Hi ESP"); it is not yet verified on a physical board, so `backend/bin/device-sim.js` is the verified way to demonstrate the device path.
- Reminders are delivered only while the assistant is running (not while the Mac is off or asleep); missed ones are shown as overdue at the next start. This program never sends email: drafts stay local unless you create a Gmail draft, and the “Open in Gmail / Outlook / Mail app” buttons only open a pre-filled message in your own mail client for you to review and send yourself. See [professor tools](docs/PROFESSOR_TOOLS.md).
- Hinglish uses the Hindi voice. Mixed-script pronunciation is expected to be less natural. The Hinglish setting is transcribed as Hindi (`hi`). English goes to the small model for speed; Hindi, Hinglish and Auto go to large-v3-turbo on a second whisper.cpp process (`WHISPER_MULTILINGUAL_URL`), which roughly halves Hindi errors. Both run on the Mac GPU (Metal) and use about 1.4 GB together.
- Speech-to-text accuracy is measured on public English, Hindi and Hinglish recordings with a development dashboard; see [STT evaluation](docs/STT_EVALUATION.md) for the method, results and how to rerun them.
- Set `VOICE_AUDIO_DEBUG=true`, restart the app, and explicitly enable Audio Debug in the browser to inspect the exact backend input and exact WAV submitted to Whisper. Debug audio is session-only and is not written to disk. See [audio debugging](docs/AUDIO_DEBUGGING.md).
- `/healthz` checks the backend process. `/readyz` checks local speech services. Gemini credentials are exercised only by a real request.
- Latencies shown in the page are real stage timings of that turn. Measured values are recorded in [professor tools](docs/PROFESSOR_TOOLS.md#measured-latency), [STT evaluation](docs/STT_EVALUATION.md) and [verification](docs/VERIFICATION.md).

See [architecture](docs/ARCHITECTURE.md) and [protocol](docs/PROTOCOL.md). ESP32-S3 devices connect over a separate authenticated WSS listener; see [device protocol](docs/DEVICE_PROTOCOL.md) (`backend/bin/devicectl.js` provisions devices, `backend/bin/device-sim.js` simulates one). The AURA desk-device firmware (`firmware/aura_single_usb`, wake word "Hi ESP", audio over USB through `pc_usb_audio_bridge.py`) is set up with [hardware setup](docs/HARDWARE_SETUP.md).
The exact machine-local checks and honest unverified paths are recorded in [verification](docs/VERIFICATION.md).
