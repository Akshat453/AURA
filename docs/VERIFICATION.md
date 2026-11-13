# Verification record

Date: 11 October 2026. Host: Apple M2 MacBook Air, ARM64, 8 CPU cores, 16 GB RAM, Metal enabled.

Installed and directly verified:

- Go 1.27.2 and CMake 4.4.4.
- whisper.cpp v1.9.4 at commit `927cfce`, compiled with embedded Metal, Accelerate, and ARM optimizations.
- Multilingual Whisper `base` (`ggml-base.bin`, 147.37 MB loaded model).
- Piper 1.8.0 with ONNX Runtime 1.23.2.
- `en_US-lessac-medium` and `hi_IN-priyamvada-medium`, both producing mono 16-bit 22,050 Hz WAV.
- Official Gemini Go SDK `google.golang.org/genai` v1.73.0.

Real local checks:

| Check | Result |
|---|---|
| Whisper bundled 11-second English JFK sample | Correct transcript |
| Warm Whisper HTTP transcription | 232 ms |
| Warm English Piper, “Hello professor.” | 281 ms; valid WAV |
| Warm Hindi Piper, “नमस्ते प्रोफेसर।” | 79 ms; valid WAV |
| First Whisper process lifetime including initial Metal shader compilation and two requests | 42.76 s |

These are point measurements, not statistically meaningful benchmarks. The first Whisper lifetime includes about 20 seconds of one-time Metal library compilation and is not equivalent to first-audio latency. Browser playback, Gemini, Hindi/Hinglish STT, contextual turns, rate limiting, and the full microphone-to-speaker pipeline were not executed because no `GEMINI_API_KEY` was present and no user speech corpus was supplied. No values are fabricated for those paths.

Automated verification completed successfully with `go test -race ./...`, `go vet ./...`, a clean build, shell syntax checks, and `git diff --check`.

## Update — speech-to-text evaluation (11 October 2026)

Measured on public FLEURS (English, Hindi) and OpenSLR 104 (Hinglish) recordings, through both
direct Whisper and the browser application path; see [STT evaluation](STT_EVALUATION.md) for the
method, before/after numbers and model comparison. Executed and passing: `go vet ./...`,
`VOICE_NETWORK_TESTS=1 go test -race ./...`, `node --test backend/tests/frontend/capture.test.mjs`,
a 3-recording Whisper → Gemini → Piper smoke test (all speech WAVs decoded in the browser; first audio
2.1–2.6 s). Not executed by automation: the physical microphone, device selection and real
loudspeaker playback.

## Update — pre-demo audit (1 November 2026)

Executed on the project Mac with the real Whisper, Piper, embedding sidecar and Gemini (`gemini-3.5-flash-lite`):

| Check | Result |
|---|---|
| `gofmt -l internal cmd`, `go vet ./...`, `npm run --prefix backend lint`, `bash -n scripts/*.sh`, `git diff --check` | clean |
| `VOICE_NETWORK_TESTS=1 go test -race -count=1 ./...` | 152 top-level tests pass, 0 fail, 0 skipped |
| `node --test backend/tests/frontend/*.test.mjs` | 19/19 |
| `node backend/bin/e2e-check.js` typed English turn | answer + 1 valid WAV, first audio 1650 ms |
| `node backend/bin/e2e-check.js` Hindi FLEURS clip (voice path) | Hindi transcript, 2 valid WAVs, first audio 3543 ms |
| `node scripts/ui-check.mjs --no-gemini` on a copy of the demo data | 31/31 |
| Real browser flows (headless Chrome, real Gemini): reminder confirm, draft confirm with body and mail buttons, delete → Cancel, Hindi "हाँ, ठीक है", documents OFF/ON | 10/10 |
| UI sweep: 10 screens × light/dark × 1440/390 px, demo data and empty data | no overflow, no raw text, no console errors |
| `devicectl init-ca/server-cert/add/list/revoke`, `device-sim` real Hindi turn over WSS | 0 underruns, frames and sequence OK; wrong secret and revoked device refused |
| Service failures: Whisper stopped, Piper stopped and restarted | readable messages; speech recovers after Piper restarts without restarting the app (bug fixed this day) |

Not executed: a physical ESP32 (the firmware merged from `main` was not built or flashed here; ESP-IDF is not installed on this Mac), a real Google account, real Gmail/Microsoft 365 compose links, `setup-local.sh` from a clean checkout, shellcheck (not installed).
