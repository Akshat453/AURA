# AURA desk device: complete hardware guide

This guide takes you from nothing to a working hands-free voice assistant: installing the tools, setting up the server, configuring and flashing the ESP32-S3 firmware (`firmware/aura_single_usb/`), and running the PC audio bridge (`pc_usb_audio_bridge.py`). Follow the parts in order.

| Part | What you do | Where |
|---|---|---|
| [1](#part-1--how-it-works) | Understand the setup | — |
| [2](#part-2--what-you-need) | Collect the hardware | — |
| [3](#part-3--install-the-tools) | Install the tools | Windows PC |
| [4](#part-4--prepare-the-server) | Enable the device listener on the assistant | Server computer (Mac) |
| [5](#part-5--check-the-server-with-the-simulator) | Check the server with the simulator (optional) | Windows PC |
| [6](#part-6--configure-the-firmware) | Configure the firmware | Windows PC |
| [7](#part-7--build-and-flash-the-esp32-s3) | Build and flash the ESP32-S3 | Windows PC + board |
| [8](#part-8--test-usb-audio-alone-optional) | Test USB audio alone (optional) | Windows PC + board |
| [9](#part-9--run-the-pc-audio-bridge) | Run the PC audio bridge | Windows PC |
| [10](#part-10--use-it) | Use it and check each stage | — |
| [11](#part-11--troubleshooting) | Troubleshooting | — |
| [12](#part-12--maintenance) | Re-flash, change Wi-Fi, rotate or revoke the device | — |

---

## Part 1 — How it works

```text
 you ──speak──► PC microphone ──bridge──► ESP32-S3  (USB audio "speaker")
                                             │  noise suppression + VAD + wake word "Hi ESP"
                                             │  Wi-Fi · WSS (TLS) · device protocol v1
                                             ▼
                              professor-assistant on the server computer
                              (DEVICE_ADDR listener, /device)  Whisper → Gemini → Piper
                                             │
 you ◄──hear── PC speaker ◄──bridge── ESP32-S3  (USB audio "microphone")
```

* The **USB cable** carries audio between the Windows PC and the board. To Windows the board is a sound card called **ESP UAC Device**.
* The **bridge** (`pc_usb_audio_bridge.py`) copies your real microphone into the board and the board's output to your real speaker or headphones.
* The **board** listens for "Hi ESP", then streams your question over **Wi-Fi** to the assistant and receives the spoken answer.
* The connection is encrypted (TLS) and the board proves its identity with its own secret. The board never holds the Gemini or Tavily API keys.

The assistant (Whisper, Piper, Gemini) runs on the **server computer**. The project's setup scripts are for macOS, so this guide assumes the server is the Mac described in [startup](STARTUP.md). The ESP32-S3 and the bridge are on a **Windows PC**. Both must be on the same Wi-Fi network.

---

## Part 2 — What you need

| Item | Notes |
|---|---|
| ESP32-S3 board, **N16R8** (16 MB flash, 8 MB octal PSRAM) | e.g. ESP32-S3-DevKitC-1-N16R8. It must have **two USB ports**: **UART** (flashing and logs) and **USB** (native USB, used for audio). The labels are printed next to the ports. Boards with less PSRAM or flash will not run this firmware. |
| 2 × USB data cables | Charge-only cables do not work. Use one for each port. |
| Windows 10/11 PC | Runs the bridge; also used to build and flash the firmware. |
| Microphone and headphones on the PC | Headphones avoid the reply echoing back into the microphone. |
| 2.4 GHz Wi-Fi network | The ESP32-S3 does not support 5 GHz. The server computer must be on the same network. |
| Server computer with the assistant installed | The Mac set up with [startup](STARTUP.md) (Whisper, Piper, Gemini key). |

---

## Part 3 — Install the tools

All on the **Windows PC**.

### 3.1 Git and the project

1. Install Git for Windows from <https://git-scm.com/download/win> (default options).
2. Get the project (skip if you already have it):
   ```powershell
   cd D:\Projects
   git clone https://github.com/goswamimoksh455-max/Voice-assistance.git
   cd Voice-assistance
   ```

### 3.2 Python (for the bridge)

1. Install Python 3.10 or newer from <https://www.python.org/downloads/windows/>. On the first installer screen tick **Add python.exe to PATH**.
2. Install the audio library:
   ```powershell
   python --version
   pip install sounddevice
   ```

### 3.3 ESP-IDF 5.3 (to build and flash the firmware)

The firmware is built with **ESP-IDF v5.3** (tested with 5.3.6).

1. Download the **ESP-IDF Windows installer** from Espressif: <https://dl.espressif.com/dl/esp-idf/>. Choose the **v5.3.x offline installer**: it includes everything and needs no further downloads during setup.
2. Run it with the default options. It installs ESP-IDF, the compiler, its own Python environment and the USB drivers.
3. It adds **ESP-IDF 5.3 PowerShell** (and **ESP-IDF 5.3 CMD**) to the Start menu. **Always build and flash from that window**, not from a normal PowerShell window, because it sets up `idf.py`.
4. Check:
   ```powershell
   idf.py --version          # ESP-IDF v5.3.x
   ```

The VS Code **ESP-IDF** extension, or Espressif's newer installation manager, also work if you select ESP-IDF **v5.3**.

### 3.4 USB-to-serial driver (for the UART port)

Plug the board's **UART** port into the PC and open **Device Manager → Ports (COM & LPT)**. You should see an entry such as *Silicon Labs CP210x USB to UART Bridge (COM5)* or *USB-Enhanced-SERIAL CH343 (COM5)*. **Note the COM number.**

If no COM port appears, install the driver for the chip printed on your board:
* CP210x: <https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers>
* CH343: <https://www.wch-ic.com/downloads/CH343SER_EXE.html>

Then unplug and replug the cable.

### 3.5 Go (optional, for the simulator check in Part 5)

Install Go 1.26 or newer from <https://go.dev/dl/>, then check with `go version`.

---

## Part 4 — Prepare the server

On the **server computer (Mac)**, in the project folder. The assistant must already work in the browser ([startup](STARTUP.md)).

### 4.1 Find the server's IP address and keep it fixed

```sh
ipconfig getifaddr en0          # Wi-Fi IP, e.g. 192.168.1.43
```

In your router, give this computer a **DHCP reservation** so the IP never changes. If it does change later, repeat 4.3.

### 4.2 Build the device tools

```sh
npm ci --prefix backend   # once: backend dependencies
npm ci --prefix backend   # once: backend dependencies
```

### 4.3 Create the certificates

```sh
node backend/bin/devicectl.js init-ca                                                      # once: data/device-tls/ca.crt + ca.key
node backend/bin/devicectl.js server-cert --host 192.168.1.43 --host voice-assistant.local # your IP from 4.1, plus a name
```

* `ca.crt` is the certificate the board trusts. You copy it to the firmware in Part 6.
* **`ca.key` never leaves the server.** Do not copy it anywhere or put it in Git.
* `voice-assistant.local` is the name the board checks the certificate against. It does not have to resolve on your network; it just has to match `SERVER_CERT_NAME` in the firmware.

### 4.4 Register the device

```sh
node backend/bin/devicectl.js add --id aura-esp32-01 --name "AURA desk"
```

It prints the **device secret (64 hexadecimal characters) once**. Copy it somewhere safe; you need it in Part 6. Lost it? Run `node backend/bin/devicectl.js rotate --id aura-esp32-01` to get a new one. List devices with `node backend/bin/devicectl.js list`.

### 4.5 Turn on the device listener

Add this line to `.env` (use your IP from 4.1):

```dotenv
DEVICE_ADDR=192.168.1.43:8443
```

Restart the assistant:

```sh
./scripts/start-local.sh
grep "device listener" runtime/log/assistant.log   # a line with "device listener (WSS)" and your address
```

When macOS asks whether `professor-assistant` may accept incoming network connections, click **Allow**. If you use another firewall, allow TCP port **8443**.

### 4.6 Copy `ca.crt` to the Windows PC

Copy `data/device-tls/ca.crt` from the server to the Windows PC (USB stick, shared folder or e-mail; it is a public certificate). Put it at:

```text
Voice-assistance\firmware\aura_single_usb\main\certs\ca.crt
```

---

## Part 5 — Check the server with the simulator

Optional, but it separates server problems from board problems. On the **Windows PC**, in a normal PowerShell window, in the project folder.

1. Copy `ca.crt` to `data\device-tls\ca.crt` as well (the simulator reads it from there in this example).
2. Save the secret from 4.4 in a file:
   ```powershell
   Set-Content -NoNewline -Path $HOME\aura.secret -Value "<the 64-hex secret>"
   ```
3. Record a short question (5 seconds) as a 16 kHz WAV file:
   ```powershell
   python -c "import sounddevice as sd, wave; a=sd.rec(5*16000,16000,1,'int16'); print('Speak now...'); sd.wait(); w=wave.open('question.wav','wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(a.tobytes()); w.close()"
   ```
4. Run the simulator against the server:
   ```powershell
   node backend/bin/device-sim.js -url wss://192.168.1.43:8443/device -server-name voice-assistant.local `
       -ca data\device-tls\ca.crt -id aura-esp32-01 -secret-file $HOME\aura.secret -wav question.wav -out reply.wav
   ```

A transcript and a `reply.wav` you can play mean that the network, firewall, certificate name and secret are all correct. Whatever goes wrong after this point is on the board or bridge side.

---

## Part 6 — Configure the firmware

On the **Windows PC**, in `firmware\aura_single_usb\main\`:

1. Copy the example settings:
   ```powershell
   cd firmware\aura_single_usb\main
   copy secrets.example.h secrets.h
   ```
2. Open `secrets.h` in a text editor and fill it in:

   | Setting | Example | Where the value comes from |
   |---|---|---|
   | `WIFI_SSID` | `"LabWiFi"` | your 2.4 GHz network name (case-sensitive) |
   | `WIFI_PASS` | `"…"` | its password |
   | `SERVER_URI` | `"wss://192.168.1.43:8443/device"` | `DEVICE_ADDR` from 4.5, as `wss://IP:PORT/device` |
   | `SERVER_CERT_NAME` | `"voice-assistant.local"` | a `--host` name from 4.3 (not the IP) |
   | `DEVICE_ID` | `"aura-esp32-01"` | the `--id` from 4.4 |
   | `DEVICE_SECRET_HEX` | `"8f2a…"` (64 characters) | the secret printed in 4.4 |
   | `DEVICE_LANGUAGE` | `"auto"` | `en`, `hi`, `hinglish` or `auto` |
   | `DEVICE_MODE` | `"auto"` | `general`, `documents`, `web` or `auto` |

3. Check that `main\certs\ca.crt` exists (Part 4.6) and starts with `-----BEGIN CERTIFICATE-----`.

`secrets.h` and `certs\ca.crt` are listed in `firmware/aura_single_usb/.gitignore`, so Git ignores them. Never share them: anyone with the secret can pose as your device.

---

## Part 7 — Build and flash the ESP32-S3

1. Connect the board's **UART** port to the PC (the COM port from 3.4).
2. Open **ESP-IDF 5.3 PowerShell** from the Start menu and go to the project:
   ```powershell
   cd D:\Projects\Voice-assistance\firmware\aura_single_usb
   ```
3. Build:
   ```powershell
   idf.py build
   ```
   * The first build downloads the components listed in `main/idf_component.yml` (USB audio, speech recognition, WebSocket client), so it needs internet and takes a few minutes. Later builds are fast.
   * It ends with `Project build complete`.
   * **Do not run `idf.py set-target`.** The project is already set to `esp32s3`, and `set-target` would replace `sdkconfig` (PSRAM, partitions, USB audio and wake-word settings) with defaults.
4. Flash and open the log (use your COM number):
   ```powershell
   idf.py -p COM5 flash monitor
   ```
   This writes the bootloader, partition table, application and the **wake-word model** (`srmodels.bin`, into the `model` partition).
   * If it says *Failed to connect*: hold **BOOT**, press and release **RST**, release **BOOT**, then run the command again.
   * To leave the monitor press **Ctrl + ]**.
5. Watch the log. A working board prints, in order:
   ```text
   I AURA: Wi-Fi up, IP 192.168.1.57; connecting to wss://192.168.1.43:8443/device
   I AURA: TLS connected; waiting for the challenge
   I AURA: Authenticated as aura-esp32-01 (lead 200 ms). Say "Hi ESP".
   ```
   On the server, `runtime/log/assistant.log` gets a `"device connected"` line with `"device_id":"aura-esp32-01"`.

---

## Part 8 — Test USB audio alone

Optional. This proves the USB audio and the bridge work before the network is involved.

1. In `firmware\aura_single_usb\main\aura_single_usb.c` set `#define BRINGUP_USB_LOOPBACK 1`.
2. Run `idf.py -p COM5 flash monitor` again. The log shows `USB loopback mode`.
3. Plug in the **USB** port and run the bridge (Part 9). Speak: you should hear yourself in the headphones about a quarter of a second later.
4. Set `BRINGUP_USB_LOOPBACK` back to **0** and flash again.

---

## Part 9 — Run the PC audio bridge

1. Connect the board's **USB** (native) port to the Windows PC. The UART cable can stay connected for logs. Windows installs **ESP UAC Device** automatically; it appears under **Settings → System → Sound** both as a microphone and as a speaker.
2. In **Sound settings**, set your **real** microphone and headphones as the defaults, not the ESP device.
3. In a normal PowerShell window, in the project folder, list the devices:
   ```powershell
   python pc_usb_audio_bridge.py --list
   ```
   Several entries contain *ESP UAC Device*; your own devices are listed too.
4. Start the bridge:
   ```powershell
   python pc_usb_audio_bridge.py
   # or choose devices by part of their name:
   python pc_usb_audio_bridge.py --pc-mic "Headset" --pc-spk "Headphones"
   ```
   It prints:
   ```text
   PC mic   [1] Microphone (Headset)  ->  ESP32 speaker [7] Speakers (ESP UAC Device)
   ESP32 mic [6] Microphone (ESP UAC Device)  ->  PC speaker [4] Headphones (Headset)

   Bridge live. Ctrl+C to stop.
   ```
   Keep this window open while you use the device.

---

## Part 10 — Use it

1. Say **"Hi ESP"**, pause briefly, then ask your question, e.g. "What is my next class?"
2. Stop talking: about **1.4 seconds of silence** ends the question (the maximum is 15 seconds).
3. The answer plays in your headphones. While it plays, and for 0.6 s after, the microphone is ignored. Then say "Hi ESP" again for the next question.

### What each stage prints (UART monitor)

| Stage | Log line |
|---|---|
| Wake word heard | `Wake word: turn 1 started` |
| Server accepted the question | `turn 1: recording` |
| End of speech | `turn 1: 52 frames sent (end of speech)` |
| Transcript | `heard: What is my next class?` |
| Answer finished | `turn 1 complete` |

### Final checklist

- [ ] The monitor shows `Authenticated as aura-esp32-01`
- [ ] The server log shows `device connected`
- [ ] The bridge shows `Bridge live`
- [ ] "Hi ESP" produces `Wake word: turn N started`
- [ ] `heard:` shows your words correctly
- [ ] The answer is heard in the headphones without stutter

---

## Part 11 — Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `idf.py` is not recognised | You are in a normal PowerShell window. Open **ESP-IDF 5.3 PowerShell**. |
| Build error mentioning `esp32` instead of `esp32s3`, or PSRAM missing | `set-target` was run. Restore `firmware/aura_single_usb/sdkconfig` from the repository and rebuild. |
| `main/certs/ca.crt is missing` in the log | Copy `ca.crt` (Part 4.6) and build again. |
| Flashing: *Failed to connect* / no COM port | Use the **UART** port and a data cable, install the driver (3.4), and use the BOOT + RST sequence (Part 7). |
| `Wi-Fi up` never appears | Wrong SSID/password, or a 5 GHz-only network. The SSID is case-sensitive. |
| `Wi-Fi up` but never `TLS connected` | Wrong IP or port in `SERVER_URI`, `DEVICE_ADDR` not set, assistant not running, firewall blocking 8443, or the server is on another network. Run Part 5 from the same Wi-Fi. |
| `websocket error … cert flags 0x…` | Certificate check failed: `SERVER_CERT_NAME` is not one of the `--host` names, or `ca.crt` comes from a different `init-ca`. Copy the current `ca.crt` again. If the server IP changed, re-run `server-cert` (Part 4.3). |
| `server error … unauthorized` | Wrong `DEVICE_ID` or `DEVICE_SECRET_HEX`, or the device was revoked. The server log says why (`device authentication failed … reason=`). |
| `cannot answer the challenge` | `DEVICE_SECRET_HEX` is not 64 hexadecimal characters. |
| Bridge: `ESP32 USB audio not found` | The **USB** (native) port is not connected, or the board was not reset after flashing. Press RST, run `--list`, or pass `--esp "ESP UAC"`. |
| Bridge: `Your Windows default mic/speaker is the ESP32` | Set your real devices as the Windows defaults, or use `--pc-mic` / `--pc-spk`. |
| "Hi ESP" is never detected | Check that the bridge says `PC mic -> ESP32 speaker`, raise the microphone level in Windows, speak clearly about 30–50 cm from the mic. Test with Part 8. |
| `server error … bad_request` (no speech) | The question was too quiet or too short. Raise the microphone level. |
| `server error … stt_failed` / `llm_failed` | Server side: check that Whisper is running and `GEMINI_API_KEY` is set ([startup](STARTUP.md), `curl …/readyz`). |
| Answer stutters | Wi-Fi jitter (the server log shows `device playback underrun`). Move closer to the router, or set `DEVICE_PLAYBACK_LEAD_MS=400` in `.env` and restart the assistant. |
| The assistant answers itself in a loop | Loudspeaker echo: use headphones. |

To see exactly what the server received, set `DEVICE_DEBUG_AUDIO_DIR=runtime/device-audio` in `.env` and restart: each question is saved as a WAV file you can listen to.

---

## Part 12 — Maintenance

| Task | How |
|---|---|
| Change Wi-Fi or server address | Edit `main/secrets.h`, then `idf.py -p COM5 flash`. |
| Server IP changed | On the server: `devicectl server-cert --host <new IP> --host voice-assistant.local` and update `DEVICE_ADDR`. On the board: update `SERVER_URI` and flash. The board keeps the same `ca.crt`. |
| New secret (lost or leaked) | `devicectl rotate --id aura-esp32-01 --grace 10m`, put the new secret in `secrets.h`, flash within 10 minutes. |
| Disable a device | `devicectl revoke --id aura-esp32-01`. It is disconnected at the next heartbeat (≈15 s). |
| Erase the board completely | `idf.py -p COM5 erase-flash`, then flash again. |
| Change the language or answer source | Edit `DEVICE_LANGUAGE` / `DEVICE_MODE` in `secrets.h` and flash. |

---

## Reference: what was verified

* The authentication message (HMAC) and the audio frame header produced by the firmware are byte-for-byte identical to the server's Go implementation (`internal/device`).
* The message sequence follows the reference client used by the simulator (`backend/src/modules/device/client.js`) and [device protocol](DEVICE_PROTOCOL.md).
* The firmware compiles with ESP-IDF 5.3.6 for `esp32s3` (application 1.1 MB in a 3 MB partition; wake-word model included). The CI pipeline builds it on every change (job *Firmware build*).
* **Not yet verified on a physical board:** Wi-Fi jitter, USB clock drift, and wake-word accuracy through a PC microphone. Record your results in [verification](VERIFICATION.md).
