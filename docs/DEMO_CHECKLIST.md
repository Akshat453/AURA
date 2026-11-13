# Demo checklist (5–10 minutes)

Everything below was run on the project Mac on 1 November 2026. Times are what we measured then; Wi-Fi and Gemini load change them.

## The day before

- [ ] `node backend/bin/config-check.js` shows no errors (it never prints secrets).
- [ ] `make test` passes (about 2 minutes).
- [ ] Refresh the demo data so dates are relative to the demo day: `node backend/bin/db.js seed`. The seed sets reminders and classes relative to the day it runs; seeded a week earlier, almost every reminder shows as overdue.
- [ ] Settings → Appearance: pick Light or Dark for the projector and keep it.
- [ ] Charge the Mac and keep it awake (reminders only fire while the assistant runs).
- [ ] Optional for the documents demo: in `.env` set `RAG_SEND_CONTEXT_TO_GEMINI=true`, then restart.

## Start (2 minutes before)

```sh
./scripts/start-demo.sh                 # Whisper, Piper, embeddings, app on :8090 and demo data on :8091 (about 6 s when models are cached)
curl -s http://127.0.0.1:8091/readyz    # every value "ok" (web_search may say "not configured")
```

Open <http://127.0.0.1:8091> in Chrome. Allow the microphone once (Settings → "Allow and list microphones"). Settings → Connection and health shows every service as Ready.

If `/readyz` says Piper is "not a Piper server": macOS AirPlay Receiver answered on port 5000 because Piper was not running. Run `./scripts/start-local.sh` again; it restarts only what stopped.

## Script

| # | Say or do | Expected result | Point to make |
|---|---|---|---|
| 1 | Dashboard | Greeting, today's classes, next lecture, reminders, recent notes | Everything is stored in SQLite on this Mac |
| 2 | AI Assistant → type "In one sentence, what is normalization?" | Streaming answer, then speech (first audio about 1.5 s) | Typed and spoken questions use the same pipeline |
| 3 | Hold the microphone: "What is my next lecture?" | Spoken answer from the timetable | Whisper runs locally; only text goes to Gemini |
| 4 | Hold the microphone: "कल सुबह 10 बजे मार्क्स जमा करने का रिमाइंडर लगाओ" | Confirmation card in Hindi context | Hindi uses the large-v3-turbo model |
| 5 | Say or type "हाँ, ठीक है" | Card turns green, reminder listed under Reminders | Nothing changes without confirmation; yes/no is classified in Go, never by Gemini |
| 6 | "Delete my note about the networking lab equipment" → Cancel | "Okay, I kept it." Note still there | Reject path |
| 7 | "Draft an email to hod@college.edu saying Thursday's DBMS lecture moves to LH-3" → edit a word → Confirm | Draft saved; **Open in Gmail / Outlook / Mail app** buttons appear | The program never sends email; it opens your own mail client |
| 8 | Answer from: My documents → "What does unit 3 of the DBMS syllabus cover?" (switch OFF) | Passages listed locally; reply says how to switch Gemini on | Private by default |
| 9 | Switch on **Let Gemini read my documents** → confirm → ask again | Answer with [D1]-style citations | Only matching passages are sent, never whole files |
| 10 | Device path (terminal, see below) | Simulated ESP32 turn: transcript, reply audio, `underruns: 0` | TLS + per-device HMAC; same pipeline as the browser |

### Device path with the simulator

Once, beforehand (see [STARTUP.md](STARTUP.md) §4): `devicectl init-ca`, `server-cert`, `add --id lab-esp32-01`, set `DEVICE_ADDR` and restart. During the demo:

```sh
node backend/bin/device-sim.js -url wss://<mac-ip>:8443/device -ca data/device-tls/ca.crt -id lab-esp32-01 \
    -secret-file ~/.config/voice/lab-esp32-01.secret -wav question.wav -language en
node backend/bin/devicectl.js revoke --id lab-esp32-01     # then run device-sim again: "authentication failed"
```

Say clearly: **the AURA firmware (`firmware/aura_single_usb`) implements this protocol and builds in CI, but no physical board has completed a turn with this server yet**; the simulator speaks exactly the same protocol. If the board is set up ([hardware setup](HARDWARE_SETUP.md)) and works on the day, show it after the simulator, not instead of it.

## If something fails

| Failure | What the page shows | Fallback |
|---|---|---|
| Gemini quota (free tier: about 15 requests per minute) | "Gemini's request limit was reached. Please try again in about a minute." | Wait a minute; yes/no answers, the timetable, reminders and notes tabs work without Gemini |
| No internet | "Gemini could not be reached. Check the internet connection…" | Show the tabs (all local), document search (Documents → Test a search, local), and the simulator in echo mode (`DEVICE_ECHO=true`, `-mode echo`) |
| Whisper stopped | "Speech recognition is not running on this Mac…" | `./scripts/start-local.sh`, or type instead |
| Piper stopped | "The reply could not be spoken… The text is shown above." | `./scripts/start-local.sh`; speech recovers without restarting the app |
| Microphone blocked | "Microphone permission was denied…" | Chrome site settings → allow; or type |
| Projector Wi-Fi isolates devices | Simulator cannot connect over the LAN | Run the simulator on the Mac against `127.0.0.1` with a certificate for `127.0.0.1` |
| Board not available or does not connect | — | Simulator (above); explain that board verification is still open |

## After

```sh
./scripts/start-demo.sh stop && ./scripts/stop-local.sh
```
