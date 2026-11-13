# ESP32 device protocol v1

ESP32-S3 devices talk to the assistant over **WSS on the local Wi-Fi** at `/device` on a separate listener (`DEVICE_ADDR`). The browser UI, document API and `/ws` stay on the localhost-only listener; the device listener serves nothing but `/device` and `/healthz`. A device session uses the same pipeline as the browser (Whisper, Gemini with documents/web, Piper, history, cancellation); only the wire format differs.

**Hardware status.** The ESP32-S3 firmware is in `firmware/aura_single_usb/` (setup: [hardware setup](HARDWARE_SETUP.md)). It implements this protocol (WSS trusting only the embedded CA, the HMAC `hello`, VAP1 frames, `audio_start`-gated streaming, paced playback with `playback_state` reports) and gets its microphone and speaker audio over USB from a Windows PC running `pc_usb_audio/pc_usb_audio_bridge.py`. The protocol is verified with the reference device client (`backend/src/modules/device/client.js`) and the simulator (`backend/bin/device-sim.js`); the firmware compiles in CI but is **not yet verified on a physical board**, so no board has completed a turn with this server yet. The older prototype on the `IoT_hardware` branch used a different, unauthenticated message format and is superseded by this firmware.

## Security model

| Threat | Control |
|---|---|
| Eavesdropping / tampering on Wi-Fi | TLS 1.2+ (TLS 1.3 negotiated in tests); plaintext is refused |
| Impersonating the server | Devices trust only the local CA (`ca.crt` embedded in firmware) and verify the host name/IP in the certificate; verification is never disabled |
| Impersonating a device | Per-device 256-bit secret; HMAC-SHA256 challenge-response with a fresh server nonce per connection: the secret never crosses the wire, and a recorded handshake cannot be replayed |
| Unknown, revoked or wrong-secret devices | Rejected before any audio is accepted, with the same "authentication failed" message (the server log keeps the reason) and a 300 ms delay |
| A web page driving the device endpoint | Any request with an `Origin` header (every browser) gets 403; devices never send one |
| A web page driving the browser endpoint | `/ws` accepts only this server's own origin (`VOICE_ALLOWED_ORIGINS`, default `127.0.0.1:PORT`, `localhost:PORT`), not other local ports |
| Resource exhaustion | 4 KB control messages, 8 KB audio frames, `VOICE_MAX_RECORDING_SECONDS`, utterance timeout, 16 pending handshakes, `DEVICE_MAX_CONNECTIONS`, bounded playback queue, write deadlines, heartbeats |
| Stolen device | `devicectl revoke` (connected sessions close at the next heartbeat) or `devicectl rotate` |
| Cloud secrets on hardware | Devices hold only their own device secret, never the Gemini or Tavily keys |
| Sensitive data in logs | Logs contain device ids, addresses, sizes and timings, never secrets, MACs, audio or transcripts. Saving audio is opt-in (`DEVICE_DEBUG_AUDIO_DIR`): one new 0600 file per turn |

`data/devices.json` holds device secrets and `data/device-tls/*.key` the private keys. All are created owner-only (0600), the server refuses to start with readable credential files, and `data/` is git-ignored. The CA key never goes onto a device.

## Setup (on the Mac)

```sh
npm ci --prefix backend   # once: backend dependencies
node backend/bin/devicectl.js init-ca                                    # once: data/device-tls/ca.crt + ca.key
node backend/bin/devicectl.js server-cert --host 192.168.1.43 --host Akshats-MacBook-Air.local   # this Mac's LAN IP and mDNS name
node backend/bin/devicectl.js add --id lab-esp32-01 --name "Lab desk"    # prints the device secret once
```

Then in `.env`:

```dotenv
DEVICE_ADDR=192.168.1.43:8443     # this Mac's LAN IP (not 0.0.0.0 unless needed)
```

Run `./scripts/start-local.sh`. macOS may ask whether `professor-assistant` may accept incoming connections; allow it. Give the Mac a DHCP reservation on the router so its IP stays stable; otherwise reissue the certificate when it changes (`server-cert` again; devices keep the same CA). Re-run `server-cert` before the certificate's validity (default 1 year) ends.

Rotate a secret with `devicectl rotate --id lab-esp32-01 --grace 10m` (the old secret works for 10 minutes while you re-flash), and revoke with `devicectl revoke --id lab-esp32-01`. `devicectl list` shows devices without secrets. The server re-reads the file when it changes, so no restart is needed.

## Simulator

```sh
npm ci --prefix backend   # once: backend dependencies
umask 077; echo "<secret printed by devicectl add>" > ~/lab-esp32-01.secret
node backend/bin/device-sim.js -url wss://192.168.1.43:8443/device -ca data/device-tls/ca.crt -id lab-esp32-01 \
    -secret-file ~/lab-esp32-01.secret -wav question.wav -language hi -mode documents -out reply.wav
```

Flags: `-mode echo` (with `DEVICE_ECHO=true`: returns your audio, no AI), `-turns N`, `-cycles N` (alternates clean closes and abrupt drops), `-abort-after-first-audio`, `-buffer-ms` (declared playback buffer), `-frame-ms`, `-realtime=false`. It prints transcript, frame/sequence checks, end-of-speech → first-audio latency and the jitter-buffer model results. The secret is read from a file, never from a command-line argument.

## Wire format

Text frames are JSON control messages (≤ 4 KB). Binary frames use the browser protocol's 16-byte VAP1 header (big-endian integers) followed by audio:

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | ASCII `VAP1` |
| 4 | 1 | version `1` |
| 5 | 1 | kind: `1` device → server microphone PCM, `5` server → device speaker PCM |
| 6 | 2 | flags, 0 |
| 8 | 4 | turn id |
| 12 | 4 | sequence number, from 0, contiguous per turn and direction |

Audio is **16 kHz, signed 16-bit little-endian, mono** (`pcm_s16le`, 32 bytes per millisecond: 320 bytes = 10 ms, 640 bytes = 20 ms). Payloads are a whole number of samples; uplink frames carry at most 8192 bytes (any size up to that, 20 ms recommended). Downlink frames are `frame_ms` long (default 20 ms = 640 bytes), except possibly the last frame of a turn.

## Handshake

```text
device → TLS connect, WebSocket upgrade to wss://HOST:8443/device (no Origin header)
server → {"type":"challenge","v":1,"nonce":"<64 hex>"}
device → {"type":"hello","v":1,"device_id":"lab-esp32-01","firmware":"1.0.0",
          "mac":"<64 hex HMAC-SHA256(secret, "VAP1-AUTH\n" + device_id + "\n" + nonce)>",
          "codecs":[{"format":"pcm_s16le","sample_rate":16000,"channels":1}],"playback_buffer_ms":500}
server → {"type":"ready","v":1,"session_id":"…","codec":{…},"frame_ms":20,"lead_ms":200,
          "max_utterance_ms":30000,"max_frame_bytes":8192,"heartbeat_ms":15000}
```

The HMAC key is the secret decoded from hex (32 bytes), and the message is the exact bytes `VAP1-AUTH`, newline, device id, newline, nonce (hex text). `hello` must arrive within `DEVICE_HELLO_TIMEOUT` (5 s). `playback_buffer_ms` (100–10000) is the device's speaker buffer; the server caps `lead_ms` at that minus two frames. On failure the server sends `{"type":"error","code":"unauthorized" | "bad_hello" | "unsupported_codec" | "busy",…}` and closes with WebSocket status 1008 (policy), 1003 (codec) or 1013 (busy). A new connection with the same device id replaces the old session (close 1001).

## A turn

```text
device → {"type":"utterance_start","turn_id":1,"codec":{"format":"pcm_s16le","sample_rate":16000,"channels":1},
          "language":"hi","mode":"documents"}          # language: en|hi|hinglish|auto; mode: general|documents|web|auto
server → {"type":"audio_start","turn_id":1,…}            # now stream the microphone
device → binary kind 1, turn 1, seq 0, 1, 2 …
device → {"type":"utterance_end","turn_id":1,"frames":N}   # N = frames sent; a mismatch discards the turn ("frames lost")
server → {"type":"stt_result","turn_id":1,"text":"…","language":"hi"}
server → {"type":"tts_start","turn_id":1,"codec":{…},"frame_ms":20,"lead_ms":200}
server → binary kind 5, turn 1, seq 0 … (first lead_ms at once, then one frame per frame_ms)
server → {"type":"tts_end","turn_id":1,"frames":957,"duration_ms":19133,"aborted":false,"underruns":0}
server → {"type":"metrics","turn_id":1,"metrics":{…}}
server → {"type":"turn_complete","turn_id":1}
```

* Turn ids must increase on a connection. One turn is active at a time: `utterance_start` during a reply cancels it (its stream stops and ends with `tts_end` `"aborted":true`).
* `{"type":"abort","turn_id":1}` cancels recording or reply; the server answers `tts_end` (aborted, if audio had started) and `turn_complete` `"aborted":true`, in either order.
* Errors: `{"type":"error","turn_id":1,"code":"bad_audio" | "bad_request" | "bad_message" | "utterance_timeout" | "stt_failed" | "stt_busy" | "llm_failed" | "tts_failed" | "playback_failed","message":"…"}`. After an error the device is ready for a new `utterance_start`. "No speech detected" and "no speech recognized" are errors with code `bad_request` / `stt_failed`. `stt_busy` means too many turns were already waiting for speech recognition (`WHISPER_MAX_QUEUE`); nothing was transcribed and the device may retry.
* `utterance_end` must arrive within `DEVICE_UTTERANCE_TIMEOUT` (default: maximum recording + 5 s), or the recording is discarded with `utterance_timeout`.
* Optional: `{"type":"playback_state","turn_id":1,"state":"underrun","buffered_ms":0,"underruns":1}` reports underruns (logged). `{"type":"ping"}` → `{"type":"pong"}` for firmware without WebSocket ping support.
* Heartbeat: the server sends WebSocket pings every `DEVICE_HEARTBEAT` (15 s) and closes sessions that do not answer, or whose credential was revoked. Devices should reconnect with backoff (1, 2, 4 … 30 s) after any close.
* Development: `"mode":"echo"` (only with `DEVICE_ECHO=true`) streams the received utterance straight back through the same paced downlink.

## Playback buffering (device contract)

The server paces downlink audio so the device buffer holds about `lead_ms` and never more (`backend/src/websocket/playbackPacer.js`):

1. On `tts_start`, clear the buffer and expect frames for that `turn_id`; **drop frames whose turn id is not the current turn** (a few frames of a superseded turn can still be in flight).
2. Start playing once `lead_ms` is buffered, or immediately when `tts_end` arrives.
3. Consume one frame per `frame_ms` from the I²S DMA callback.
4. If the buffer empties before `tts_end`: play silence, count an underrun, optionally send `playback_state`, and wait until `lead_ms` is buffered again. The server models the same thing: when frames arrive late it re-sends a fresh `lead_ms` prefill instead of bursting to catch up, so the buffer never exceeds `lead_ms`.
5. On `tts_end` play out the remaining audio. On `abort`, or a new `utterance_start`, flush immediately.

Size the buffer at least `lead_ms + 2 × frame_ms` (the 500 ms declared by the simulator is comfortable: 16 KB of PSRAM/SRAM). A 200 ms lead absorbs Wi-Fi jitter up to about 200 ms; it is not guaranteed smooth on every network. Measure with `playback_state` reports on real hardware.

## ESP-IDF notes (implemented in `firmware/aura_single_usb`)

* Use the official `esp_websocket_client` component: `uri = "wss://Akshats-MacBook-Air.local:8443/device"`, `cert_pem = <ca.crt>`, `skip_cert_common_name_check = false` (the default), `ping_interval_sec`, `pingpong_timeout_sec`, `network_timeout_ms`. Increase `buffer_size` above the default 1024 bytes (at least 2048) or reassemble `WEBSOCKET_EVENT_DATA` fragments using `payload_offset`/`payload_len`. Do not set `Origin`.
* Prefer connecting by the mDNS name in the certificate. IP-address SAN checking depends on the mbedTLS version in your ESP-IDF release. The certificate contains both, but verify on hardware.
* HMAC: `mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, 32, msg, len, out)`, hex-encode.
* Store the device secret in encrypted NVS (enable flash encryption and NVS encryption for production).
* Send microphone audio from the I²S task in 20 ms frames (640 bytes) with `esp_websocket_client_send_bin`; build the 16-byte header in a static buffer.

## Measured (simulator → real stack, 19 October 2026, Apple M2, loopback)

| Measurement | Result |
|---|---|
| Handshake (TLS 1.3 + HMAC auth) | 1–5 ms |
| Echo round trip of a 10.56 s FLEURS recording | Byte-identical; 528 frames in order; 0 underruns; device buffer peak 200 ms (= lead) |
| English FLEURS through Whisper → Gemini → Piper, warm | STT 452–482 ms; end of speech → first reply audio 1.8–2.0 s; 0 underruns, peak 200 ms |
| Hindi FLEURS / your Hindi clip | Correct Devanagari transcripts; reply audio 19.1 s / 8.5 s; 0 underruns |
| First turn after the Whisper servers were idle | STT 3.9 s (English) and 6.3 s (Hindi) instead of ~0.5 s and ~1.7 s. A warm-up request at startup and after long idle periods would hide this |
| Abort at first audio | Stream stopped after the 200 ms prefill (10 frames); `tts_end` aborted; no stale frames |
| 10 connect/disconnect cycles (half abrupt) | 10/10 turns correct; no sessions left |
| Revocation of a connected device | Session closed at the next heartbeat (about 12 s); reconnect refused; rotated secret accepted |

Loopback has no Wi-Fi jitter, so these numbers are best case for the network part.

## Still needs real hardware

* Running `firmware/aura_single_usb` on a physical board: the TLS + HMAC handshake, a full turn, reconnect with back-off, and the USB-audio path through the Windows bridge. The firmware is written against this protocol and builds in CI, but no board has completed a turn yet.
* Certificate verification by mbedTLS against the Mac's IP and mDNS name.
* Wi-Fi jitter, packet loss and roaming: underruns with a 200 ms lead, best `frame_ms`.
* PSRAM use and timing of the playback buffer; I²S clock drift against the 16 kHz stream.
* Battery/power behaviour with 15 s heartbeats.
