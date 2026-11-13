import argparse, queue, sys, time
from contextlib import ExitStack
import sounddevice as sd

SR, BLOCK = 16000, 320          # 20 ms blocks

ap = argparse.ArgumentParser()
ap.add_argument("--list", action="store_true", help="list MME devices and exit")
ap.add_argument("--esp", default="", help="substring of the ESP32 device name")
ap.add_argument("--pc-mic", default="", help="substring of your real mic")
ap.add_argument("--pc-spk", default="", help="substring of your real speaker/headphones")
args = ap.parse_args()

api = next((i for i, h in enumerate(sd.query_hostapis()) if h["name"] == "MME"), None)
if api is None:
    sys.exit("MME host API not found")
devs = [(i, d) for i, d in enumerate(sd.query_devices()) if d["hostapi"] == api]

if args.list:
    for i, d in devs:
        print(f"[{i}] {d['name']}  in={d['max_input_channels']} out={d['max_output_channels']}")
    sys.exit()

KEYS = [args.esp.upper()] if args.esp else ["UAC", "ESP", "TINYUSB"]
is_esp = lambda d: any(k in d["name"].upper() for k in KEYS)

def pick(kind, esp, substr=""):
    ch = "max_input_channels" if kind == "in" else "max_output_channels"
    c = [(i, d) for i, d in devs if d[ch] > 0 and is_esp(d) == esp]
    if substr:
        c = [x for x in c if substr.upper() in x[1]["name"].upper()]
    return c[0] if c else None

def pc_default(kind, substr):
    if substr:
        return pick(kind, False, substr)
    key = "default_input_device" if kind == "in" else "default_output_device"
    idx = sd.query_hostapis(api)[key]
    d = sd.query_devices(idx)
    return None if is_esp(d) else (idx, d)

esp_mic = pick("in", True)    # what the PC records FROM the ESP32
esp_spk = pick("out", True)   # what the PC plays TO the ESP32
pc_mic = pc_default("in", args.pc_mic)
pc_spk = pc_default("out", args.pc_spk)

if not (esp_mic and esp_spk):
    sys.exit("ESP32 USB audio not found. Run with --list, press RST on the board, retry, or pass --esp NAME.")
if not (pc_mic and pc_spk):
    sys.exit("Your Windows default mic/speaker is the ESP32 (or missing). Set real devices as default in Sound settings, or pass --pc-mic / --pc-spk.")

print(f"PC mic   [{pc_mic[0]}] {pc_mic[1]['name']}  ->  ESP32 speaker [{esp_spk[0]}] {esp_spk[1]['name']}")
print(f"ESP32 mic [{esp_mic[0]}] {esp_mic[1]['name']}  ->  PC speaker [{pc_spk[0]}] {pc_spk[1]['name']}")

def make_pipe(src, dst, label):
    q = queue.Queue(maxsize=25)          # ~500 ms max
    primed = [False]

    def in_cb(indata, frames, t, status):
        if status: print(label, "in:", status)
        try:
            q.put_nowait(bytes(indata))
        except queue.Full:
            try: q.get_nowait()
            except queue.Empty: pass
            q.put_nowait(bytes(indata))

    def out_cb(outdata, frames, t, status):
        if status: print(label, "out:", status)
        if not primed[0]:
            if q.qsize() < 3:
                outdata[:] = bytes(len(outdata)); return
            primed[0] = True
        try:
            outdata[:] = q.get_nowait()
        except queue.Empty:
            primed[0] = False
            outdata[:] = bytes(len(outdata))

    return (
        sd.RawInputStream(device=src, samplerate=SR, blocksize=BLOCK, channels=1, dtype="int16", callback=in_cb),
        sd.RawOutputStream(device=dst, samplerate=SR, blocksize=BLOCK, channels=1, dtype="int16", callback=out_cb),
    )

with ExitStack() as stack:
    for s in (*make_pipe(pc_mic[0], esp_spk[0], "PC->ESP"), *make_pipe(esp_mic[0], pc_spk[0], "ESP->PC")):
        stack.enter_context(s)
    print("\nBridge live. Ctrl+C to stop.")
    try:
        while True: time.sleep(1)
    except KeyboardInterrupt:
        pass
