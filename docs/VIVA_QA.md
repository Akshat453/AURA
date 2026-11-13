# Viva questions and answers

Short answers grounded in this repository (branch `phase5`). File names point to where each answer can be shown.

## Architecture

**1. What does the system do, in one sentence?**
A push-to-talk voice assistant for a professor, in English, Hindi and Hinglish, that answers questions (general, from uploaded documents, or from the web) and manages a timetable, reminders, notes, voice memos and email drafts, with every data change confirmed by the professor.

**2. Draw the architecture.**
Browser (or ESP32) → Node.js backend (`cmd/professor-assistant`, `internal/server`) → local whisper.cpp (two processes: `ggml-small` for English, `large-v3-turbo` for Hindi/Hinglish/Auto) → Gemini (`internal/llm`, text only, with tool calls) → local Piper (one English, one Hindi voice) → audio back to the client. Documents go through a local ONNX embedding sidecar (`scripts/rag_sidecar.py`, multilingual-e5-small) into SQLite. Professor data is one SQLite file (`internal/professor`). See `docs/ARCHITECTURE.md`.

**3. Why is speech recognition and synthesis local, but the language model in the cloud?**
Audio is the most private data and the most latency-sensitive; Whisper and Piper run fast enough on the Mac's GPU/CPU (English first audio ≈ 1.3–1.7 s end to end). A capable multilingual LLM with tool calling does not run well on a 16 GB laptop, so only text goes to Gemini. Document passages and note text go only with explicit permission.

**4. Why Go for the server?**
One static binary, goroutines for many concurrent streams (each browser tab or device is a session with its own cancellation context), a good standard HTTP/TLS stack, and the race detector for testing concurrent audio code (`go test -race`).

**5. How does audio get from the browser to Whisper?**
An AudioWorklet (`backend/public/web/worklet.js`) converts microphone samples to 16-bit PCM at the browser's real rate (44.1/48 kHz) and sends binary WebSocket frames with a 16-byte `VAP1` header (turn id, sequence). Go checks order and resamples the whole utterance once to 16 kHz (`internal/audio`) before sending a WAV to Whisper.

**6. How is latency kept low?**
Sentence-level streaming: Piper starts on the first complete sentence while Gemini is still writing; the warm Whisper and Piper processes stay loaded; professor tools are offered only when the request needs them (about 180 ms saved per Gemini request). Measured numbers are in `docs/PROFESSOR_TOOLS.md` ("Measured latency").

## IoT and the device protocol

**7. Why WebSocket over TLS and not MQTT?**
A voice turn is a bidirectional, ordered, low-latency audio stream between exactly one device and one server, with request/response semantics (question → answer). WebSocket gives that directly over one TCP connection, and the browser already uses the same framing, so device and browser share the pipeline. MQTT is publish/subscribe for many small telemetry messages through a broker: it would add a broker to run and secure, and audio over topics needs its own sequencing and per-turn correlation. If many sensors were added later, MQTT would be a good fit for that telemetry.

**8. How does a device authenticate?**
Each device has its own 256-bit secret (`devicectl add`). On connect, the server sends a fresh random nonce; the device answers with `HMAC-SHA256(secret, "VAP1-AUTH\n" + device_id + "\n" + nonce)`. The server recomputes it and compares in constant time (`internal/device`, `internal/server/device.go`). The secret never crosses the network, and a recorded handshake cannot be replayed because the nonce changes every time.

**9. Why also TLS if there is HMAC?**
HMAC proves who the device is; TLS protects the audio and transcripts on Wi-Fi from eavesdropping and tampering, and lets the device verify the server. The Mac runs its own small certificate authority (`devicectl init-ca`); the device trusts only that CA. There is no plaintext mode.

**10. What happens when a device is stolen?**
`devicectl revoke --id …`: new connections are refused, and a connected session is closed at its next heartbeat (default 15 s) with WebSocket close code 1008. Tested in `TestRevokedDeviceIsDroppedWhileConnected` and shown with the simulator. `devicectl rotate` replaces a secret with a grace period for re-flashing.

**11. How is audio played smoothly on the device?**
The server sends 16 kHz PCM in fixed 20 ms frames: first a 200 ms lead to fill the device's buffer, then one frame every 20 ms in real time, re-priming after late audio (`internal/device` pacer). The device declares its buffer size in `hello`, and reports underruns; the simulator measured 0 underruns on loopback.

**12. Is the ESP32 working end to end?**
Not yet verified, and we say so. The server side is implemented and tested with a reference device client and `backend/bin/device-sim.js` (TLS, HMAC, turns, cancellation, revocation, pacing). The AURA firmware in `firmware/aura_single_usb` implements the same protocol (WSS with the embedded CA, HMAC `hello`, VAP1 frames, paced playback, wake word "Hi ESP") and builds in CI, but no physical board has completed a turn with the server yet. Its audio comes over USB from a Windows PC running `pc_usb_audio/pc_usb_audio_bridge.py`. See `docs/DEVICE_PROTOCOL.md` and `docs/HARDWARE_SETUP.md`.

**13. How would you test it on real hardware?**
Flash `firmware/aura_single_usb` ([hardware setup](HARDWARE_SETUP.md)), then: echo mode (`DEVICE_ECHO=true`) to check audio quality without AI; one real turn; `-turns`/`-cycles`-style soak tests for reconnects; `playback_state` underrun reports on busy Wi-Fi; certificate verification against the Mac's IP and mDNS name; and revocation during a session. The checklist is "Still needs real hardware" in `docs/DEVICE_PROTOCOL.md`.

## Safety, privacy, correctness

**14. How do you stop the AI from changing data by mistake?**
Gemini can only *propose*. A data-changing tool call is validated in Go and turned into a staged action with a question written by Go, not by the model. Nothing is written until the professor confirms by button or by voice. Yes/no is classified locally (`internal/actions`), never by Gemini, and must contain only yes/no words ("yes, but at 11" is not a yes). Actions expire after 60 s, run at most once, and are bound to the tab or device that asked.

**15. What if the professor says "at 5"?**
Ambiguous bare hours are refused in Go and the assistant asks "morning or evening?" (`docs/PROFESSOR_TOOLS.md`, "Ambiguous times").

**16. Can the assistant send email?**
No. There is no sending code. Drafts are saved locally; the "Open in Gmail / Outlook / Mail app" buttons build pre-filled compose links (`composeLinks` in `backend/public/web/format.js`) and the professor presses Send in their own mail client. Addresses are validated and line breaks removed from the subject so the links cannot inject headers.

**17. What leaves the Mac?**
To Gemini: the question text and, when needed, timetable and reminder details. Document passages only while "Let Gemini read my documents" is ON in that browser tab *and* the server allows it (`RAG_SEND_CONTEXT_TO_GEMINI`); note text only with its own two permissions. Never audio, never whole files. Web search queries go to Tavily. Go decides this per turn; nothing a model or document says can change it (`server.capabilities`).

**18. Why is the documents switch off in every new tab?**
It is stored in `sessionStorage`, so the choice cannot silently persist. Turning it on asks for confirmation. A device cannot tick a box, so it has its own "Desk device" switch that resets to the `.env` value when the server restarts.

**19. Could another website on the same computer control the assistant?**
The HTTP API listens on 127.0.0.1 only, state changes need a custom header and a same-origin request, and the WebSocket accepts only the app's own origin. The device listener rejects any request with an `Origin` header (every browser sends one).

## Testing and quality

**20. How did you test it?**
Go unit and integration tests (`VOICE_NETWORK_TESTS=1 go test -race ./...`, including real TLS device sessions with fake STT/LLM/TTS), Node tests for browser helpers, a headless-Chrome UI check (`scripts/ui-check.mjs`: 31 create/edit/delete, layout and voice-memo checks), real end-to-end turns with `backend/bin/e2e-check.js` and `backend/bin/device-sim.js`, and STT accuracy measured on public FLEURS and OpenSLR recordings (`docs/STT_EVALUATION.md`). Mock tests are never reported as real inference.

**21. What was the hardest bug?**
Examples worth telling: macOS AirPlay Receiver also listens on port 5000 (Piper's port); when Piper restarted, the server kept a kept-alive connection to AirPlay and stayed silent until restarted. Fixed by dropping pooled connections and retrying once on a failed answer (`internal/tts/piper.go`, regression test included). Also: Hindi "हाँ" was often misheard, so confirmations are transcribed with the yes/no vocabulary as a Whisper prompt (33% → 71% Hindi approvals recognised, no false approvals).

**22. How accurate is Hindi speech recognition?**
Measured, not assumed: see `docs/STT_EVALUATION.md` (FLEURS Hindi and OpenSLR 104 Hinglish through the real browser path). Using large-v3-turbo for Hindi roughly halved the error rate compared with the small model.

## Agile and scope

**23. How was the work organised?**
In phases with a working increment each time: Phase 0 laptop prototype, Phase 3 local STT/TTS, Phase 4 documents and web search, Phase 5 professor tools, plus the device protocol. Each phase ended with tests and a verification record (`docs/VERIFICATION.md`).

**24. What is not done, and why?**
Verifying the AURA firmware on a physical board (it builds in CI but has not completed a turn yet); Google Calendar/Gmail drafts are implemented but not verified with a real Google account; compose links not yet opened against real Gmail/Microsoft 365 accounts; reminders do not fire while the Mac sleeps; no wake word in the browser (push-to-talk by design); a device hears nothing when a turn fails (the firmware should play a tone on the `error` message).

**25. Future work?**
Verify the firmware on a board and measure on real Wi-Fi; replace the Windows USB bridge with an I²S microphone and speaker on the board; Opus audio for lower bandwidth (negotiated in `hello`); an on-device error tone and wake word; a local LLM option for fully offline use; multi-professor accounts if deployed beyond one Mac.
