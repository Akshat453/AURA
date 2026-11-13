# Starting and stopping the assistant (macOS)

Everything runs on this Mac. One script starts every local service in the background and waits until each answers; you need only one Terminal window, and you can close it afterwards.

| Service | Started by | Address |
|---|---|---|
| Whisper, English (small) | `start-local.sh` | 127.0.0.1:8081 |
| Whisper, Hindi/Hinglish/Auto (large-v3-turbo) | `start-local.sh` | 127.0.0.1:8082 |
| Piper English / Hindi voices | `start-local.sh` | 127.0.0.1:5000 / 5001 |
| Document search sidecar (embeddings, PDF text) | `start-local.sh` | 127.0.0.1:8084 |
| Assistant (Go): web page, API, WebSocket | `start-local.sh` | **http://127.0.0.1:8090** |
| ESP32 device listener (WSS, optional) | the assistant, when `DEVICE_ADDR` is set | e.g. 192.168.1.43:8443 |

The web page is served by the assistant itself; there is no separate frontend server. Gemini (answers) and Tavily (web search) are the only internet services.

## 1. First-time setup (once)

```sh
cd ~/Desktop/Voice-assistance-IOT-Project
xcode-select --install                     # Apple command-line tools (skip if already installed)
brew install go cmake python@3.10          # Go 1.26 or newer is required (go.mod)
go version                                 # check: go1.26 or newer
# Builds whisper.cpp (Metal), downloads both Whisper models, installs Piper 1.8.0 and both voices,
# installs the document-search sidecar and its embedding model, then builds the assistant.
# RAG_PYTHON must be a Python 3.10+ whose pip works (Homebrew python@3.10 on macOS 26 does not):
RAG_PYTHON=/opt/anaconda3/bin/python ./scripts/setup-local.sh
cp .env.example .env                       # skip if .env already exists — never overwrite it
open -e .env                               # set GEMINI_API_KEY (and optionally TAVILY_API_KEY), save
node backend/bin/config-check.js                  # read-only audit: must end with "No problems found"
```

Check that the models and voices are present (the setup script downloads them):

```sh
ls -lh models/whisper/ggml-small.bin models/whisper/ggml-large-v3-turbo-q5_0.bin
ls models/piper/en_US-lessac-medium.onnx models/piper/hi_IN-priyamvada-medium.onnx
ls models/embeddings/multilingual-e5-small/model.onnx
```

The databases are created automatically on the first start: `data/rag/index.db` (documents) and `data/professor/professor.db` (timetable, reminders, notes, memos, drafts). Nothing needs to be initialised by hand.

## 2. Daily start

```sh
cd ~/Desktop/Voice-assistance-IOT-Project
./scripts/start-local.sh
open http://127.0.0.1:8090
```

`start-local.sh` starts the services in the background, rebuilds the assistant if the code changed, waits until every service answers and prints `All services ready`. The first start after a reboot takes 10–30 seconds (models load into memory). Running it again is safe: services that are already running and unchanged are left alone. If you press Ctrl-C while it waits, services that already started keep running — stop them with `./scripts/stop-local.sh`. Logs are in `runtime/log/` (`assistant.log`, `whisper.log`, `whisper-multi.log`, `piper-en.log`, `piper-hi.log`, `rag.log`).

## 3. Health checks

```sh
curl -s http://127.0.0.1:8090/healthz          # {"status":"ok",...}  → the assistant is running
curl -s http://127.0.0.1:8090/readyz           # every entry "ok" (web_search "configured" or "not configured")
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/   # 200 → Whisper (English) ready
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8082/   # 200 → Whisper (Hindi) ready
curl -s http://127.0.0.1:5000/info | head -c 120; echo            # JSON → Piper English (not AirPlay)
curl -s http://127.0.0.1:5001/info | head -c 120; echo            # JSON → Piper Hindi
curl -s http://127.0.0.1:8090/api/professor | head -c 160; echo   # "enabled":true → professor database open
sqlite3 -readonly data/professor/professor.db 'PRAGMA integrity_check;'   # ok
node backend/bin/config-check.js | tail -3            # Gemini key configured (value never printed)
go run ./cmd/rag-eval | tail -8                # document search works with the real embedding model (local only)
node backend/bin/e2e-check.js -text "Say hello in one short sentence." -mode general   # one real Gemini + Piper turn
```

In the web page, **Settings → Connection and health** shows the same checks. `/readyz` reports `gemini: ok` when a key is configured; only a real question (the last command, or the Assistant page) proves the key works.

## 4. ESP32 device testing (optional)

The device listener is off while `DEVICE_ADDR` is empty. Device connections always use TLS with this Mac's own certificate authority and a per-device secret; there is no insecure mode.

```sh
ipconfig getifaddr en0                     # this Mac's Wi-Fi IP, e.g. 192.168.1.43
npm ci --prefix backend   # once: backend dependencies && npm ci --prefix backend   # once: backend dependencies
node backend/bin/devicectl.js init-ca                    # once: data/device-tls/ca.crt (+ private ca.key)
node backend/bin/devicectl.js server-cert --host 192.168.1.43 --host "$(scutil --get LocalHostName).local"
mkdir -p ~/.config/voice && chmod 700 ~/.config/voice
(umask 077; node backend/bin/devicectl.js add --id lab-esp32-01 --name "Lab desk" | grep -oE '[0-9a-f]{64}' > ~/.config/voice/lab-esp32-01.secret)
```

Then set `DEVICE_ADDR=192.168.1.43:8443` in `.env` (your IP), and for an audio echo test also `DEVICE_ECHO=true`. Restart and connect the simulator:

```sh
./scripts/start-local.sh                   # restarts the assistant because .env changed
grep '"device listener' runtime/log/assistant.log | tail -1     # the listener is on
node backend/bin/device-sim.js -url wss://192.168.1.43:8443/device -ca data/device-tls/ca.crt -id lab-esp32-01 \
    -secret-file ~/.config/voice/lab-esp32-01.secret -mode echo                    # echo test (needs DEVICE_ECHO=true)
node backend/bin/device-sim.js -url wss://192.168.1.43:8443/device -ca data/device-tls/ca.crt -id lab-esp32-01 \
    -secret-file ~/.config/voice/lab-esp32-01.secret -wav question.wav -language en   # a real turn
```

Set `DEVICE_ECHO=false` again for normal use. Re-issue the server certificate if the Mac's IP changes. For the physical board (firmware in `firmware/aura_single_usb`, not yet verified on hardware) follow [hardware setup](HARDWARE_SETUP.md); the simulator above is the verified way to demonstrate the device path.

## 4b. Demo data (optional)

Fictional demo data lives in separate SQLite databases (`DEMO_DATA_PATH`, default `./data/demo`) served on http://127.0.0.1:8091; your own data and the app on 8090 are not touched.

```sh
node backend/bin/db.js check          # read-only health check of the app and demo databases
node backend/bin/db.js seed           # idempotent demo data (only rows with "_seed" IDs)
./scripts/start-demo.sh        # starts the demo instance (and the shared services)
./scripts/start-demo.sh stop   # stops only the demo instance
node backend/bin/db.js reset          # dev only: backs up data/demo to data/demo-backups/<time>/ and re-seeds
```

## 5. Stopping

```sh
./scripts/stop-local.sh
```

It also stops the demo instance if it is running. It stops only the processes this project started (it checks each recorded process ID belongs to the expected program) and never touches other apps. Avoid `killall`/`pkill`. Closing the Terminal does not stop the services; shutting down or restarting the Mac does.

## 6. Troubleshooting

| Problem | Check | Fix |
|---|---|---|
| Port already in use | `lsof -nP -iTCP:8090 -sTCP:LISTEN` (or 8081, 8082, 5000, 5001, 8084) | If it is a leftover assistant process, run `./scripts/stop-local.sh`, then start again. If another app owns the port, change the port in that service's URL in `.env`. |
| Gemini key missing | `node backend/bin/config-check.js \| grep GEMINI` | Set `GEMINI_API_KEY` in `.env`, then `./scripts/start-local.sh`. |
| Gemini quota exceeded | The answer says "Gemini's request limit was reached" | Free tier: about 15 requests per minute; a tool question uses 2–3. Wait a minute. |
| Whisper model missing / Whisper not ready | `ls models/whisper/`; `tail -n 20 runtime/log/whisper.log` | `./scripts/setup-local.sh` downloads the models. |
| Piper not responding | `curl -s http://127.0.0.1:5000/info`; `tail -n 20 runtime/log/piper-en.log` | Use `127.0.0.1` (not `localhost`: AirPlay Receiver listens on port 5000). Restart with `./scripts/start-local.sh`. |
| Microphone permission denied | Settings → Voice shows the permission state | Click the site icon left of the address bar → Microphone → Allow, then reload. macOS: System Settings → Privacy & Security → Microphone → enable your browser. |
| "Reconnecting…" / WebSocket failed | `curl -s http://127.0.0.1:8090/healthz` | Start the assistant. Open the page at `http://127.0.0.1:8090` (another host/port needs `VOICE_ALLOWED_ORIGINS`). |
| Empty timetable or notes | Dashboard shows "Your timetable is empty" | Normal on a new install: add classes (Timetable → Add class, or Import CSV) and notes. |
| SQLite permission problem | `ls -l data/professor/`; `tail -n 20 runtime/log/assistant.log` | The files belong to you with mode 600; fix ownership with `chown -R "$USER" data/`. |
| Missing Tavily key | `curl -s http://127.0.0.1:8090/readyz` shows `web_search: not configured` | Optional: add `TAVILY_API_KEY` to `.env` and restart. Everything else works without it. |
| Google not configured | Connected Accounts shows "Not configured" | Optional: create an OAuth client (type *Desktop app*), set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_CALENDAR_ENABLED`/`GMAIL_DRAFTS_ENABLED` in `.env`, restart. |
| ESP32 simulator can't connect | `grep '"device listener' runtime/log/assistant.log`; `lsof -nP -iTCP:8443 -sTCP:LISTEN` | `DEVICE_ADDR` must be set and the URL host must match the certificate (`server-cert --host`). Allow incoming connections for `professor-assistant` if macOS asks. Check `node backend/bin/config-check.js` for the TLS files. |
| A service exited during start | `start-local.sh` prints its last log lines | Read the message; most often a missing model (run setup) or a port in use. |
