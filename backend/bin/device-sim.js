#!/usr/bin/env node
// device-sim behaves like an ESP32 on the local network: it verifies the
// server certificate with the local CA, authenticates with its device secret,
// streams a WAV recording as 16 kHz PCM frames in real time, and models the
// device playback buffer for the paced reply.
//
//   node bin/device-sim.js -url wss://192.168.1.20:8443/device -ca data/device-tls/ca.crt \
//       -id lab-esp32-01 -secret-file ~/.config/voice/lab-esp32-01.secret -wav question.wav -language en
import fs from 'node:fs'
import {parseFlags} from '../src/utils/flags.js'
import {Context} from '../src/utils/context.js'
import {decodeToPCM16, resamplePCM16, speechLikePCM, wav} from '../src/utils/audio.js'
import {caPEM} from '../src/security/certificates.js'
import {BytesPerMS, encodeMessage, SampleRate} from '../src/websocket/deviceProtocol.js'
import {DeviceClient} from '../src/modules/device/client.js'

function check(fn, what) {
  try {
    return fn()
  } catch (e) {
    process.stderr.write(`${what}: ${e.message}\n`)
    process.exit(1)
  }
}

const r3 = v => Math.round(v * 1000) / 1000

function summarize(turn, res, sentBytes, frameMS) {
  const pb = res.playback ?? {startDelay: 0, underruns: 0, maxBuffered: 0, gaps: 0}
  const r = {turn, utterance_ms: Math.trunc(sentBytes / BytesPerMS), end_of_speech_to_first_audio_ms: 0, end_of_speech_to_playback_start_ms: 0,
    downlink_frames: res.frames.length, downlink_audio_ms: 0, playback: {prefill_ms: r3(pb.startDelay), underruns: pb.underruns, max_buffered_ms: r3(pb.maxBuffered), underrun_gaps_ms: r3(pb.gaps)},
    stale_frames_discarded: res.stale.length, frame_sizes_ok: true, sequence_ok: true}
  if (res.transcript) r.transcript = res.transcript
  if (res.language) r.language = res.language
  if (res.error) r.error = `${res.error.code}: ${res.error.message}`
  if (res.ttsEnd) r.tts_end = JSON.parse(encodeMessage(res.ttsEnd))
  if (res.metrics) r.server_metrics = res.metrics
  res.frames.forEach((f, i) => {
    r.downlink_audio_ms += Math.trunc(f.pcm.length / BytesPerMS)
    if (f.pcm.length % 2 !== 0 || f.pcm.length > frameMS * BytesPerMS || (i < res.frames.length - 1 && f.pcm.length !== frameMS * BytesPerMS)) r.frame_sizes_ok = false
    if (f.seq !== i) r.sequence_ok = false
  })
  if (res.frames.length > 0) {
    r.end_of_speech_to_first_audio_ms = Math.trunc(res.firstAudioAt - res.sentEndAt)
    r.end_of_speech_to_playback_start_ms = r.end_of_speech_to_first_audio_ms + Math.trunc(pb.startDelay)
  }
  return r
}

async function main() {
  const {values: f} = parseFlags(process.argv.slice(2), {
    url: {type: 'string', default: 'wss://127.0.0.1:8443/device', usage: 'device endpoint'},
    ca: {type: 'string', default: 'data/device-tls/ca.crt', usage: 'CA certificate the device trusts'},
    'server-name': {type: 'string', default: '', usage: 'certificate host to verify (default: host in -url)'},
    id: {type: 'string', default: '', usage: 'device id'},
    'secret-file': {type: 'string', default: '', usage: 'file containing the device secret (hex)'},
    wav: {type: 'string', default: '', usage: 'question recording(s), comma-separated: one per turn'},
    language: {type: 'string', default: 'auto', usage: 'en, hi, hinglish or auto'},
    mode: {type: 'string', default: '', usage: 'general, documents, web, auto, or echo (needs DEVICE_ECHO=true)'},
    turns: {type: 'int', default: 1, usage: 'consecutive turns on one connection'},
    cycles: {type: 'int', default: 1, usage: 'connect/disconnect cycles'},
    'frame-ms': {type: 'int', default: 20, usage: 'uplink frame duration'},
    'buffer-ms': {type: 'int', default: 500, usage: 'playback buffer the simulated device declares'},
    realtime: {type: 'bool', default: true, usage: 'send microphone frames at real-time pace'},
    'abort-after-first-audio': {type: 'bool', default: false, usage: 'send abort as soon as reply audio starts'},
    out: {type: 'string', default: '', usage: 'write the received reply audio to this WAV file'},
    timeout: {type: 'duration', default: 120000, usage: 'per-turn timeout'},
  }, 'device-sim')
  // The secret is read from a file, never from a command-line argument.
  const secret = check(() => fs.readFileSync(f['secret-file'], 'utf8'), 'read -secret-file').trim()
  const ca = check(() => caPEM(f.ca), 'load -ca')
  const recordings = []
  for (const name of f.wav.split(',').map(s => s.trim()).filter(Boolean)) {
    const raw = check(() => fs.readFileSync(name), 'read -wav')
    const src = check(() => decodeToPCM16(raw), 'decode -wav')
    recordings.push(check(() => resamplePCM16(src.pcm, src.sampleRate, SampleRate), 'resample'))
  }
  if (recordings.length === 0) recordings.push(speechLikePCM(SampleRate, 1.5, 0.3))
  const cfg = {url: f.url, deviceId: f.id, secret, ca, serverName: f['server-name'], playbackBufferMS: f['buffer-ms'], firmware: 'device-sim/1'}
  for (let cycle = 1; cycle <= f.cycles; cycle++) {
    const start = performance.now()
    let c
    try {
      c = await DeviceClient.dial(cfg)
    } catch (e) {
      process.stderr.write(`connect: ${e.message}\n`)
      process.exit(1)
    }
    process.stderr.write(`cycle ${cycle}: connected and authenticated in ${Math.trunc(performance.now() - start)} ms (session ${c.ready.session_id}, frame ${c.ready.frame_ms} ms, lead ${c.ready.lead_ms} ms)\n`)
    for (let t = 1; t <= f.turns; t++) {
      const pcm = recordings[(t - 1) % recordings.length]
      const [ctx, cancel] = Context.background().withTimeout(f.timeout)
      let res
      try {
        res = await c.runTurn(ctx, {turn: t, pcm, language: f.language, mode: f.mode, frameBytes: f['frame-ms'] * BytesPerMS, realTime: f.realtime,
          abortAfterFirstAudio: f['abort-after-first-audio']})
      } catch (e) {
        process.stderr.write(`turn: ${e.message}\n`)
        process.exit(1)
      } finally {
        cancel()
      }
      const r = summarize(t, res, pcm.length, c.ready.frame_ms)
      if (f.out && res.frames.length > 0) {
        const all = Buffer.concat(res.frames.map(fr => fr.pcm))
        const name = f.turns > 1 || f.cycles > 1 ? f.out.replace(/\.wav$/, '') + `-c${cycle}-t${t}.wav` : f.out
        check(() => fs.writeFileSync(name, wav(all, SampleRate), {mode: 0o600}), 'write -out')
        r.received_audio_file = name
      }
      process.stdout.write(JSON.stringify(r, null, 2) + '\n')
    }
    if (cycle % 2 === 0) c.closeNow() // alternate abrupt disconnects (Wi-Fi loss) with clean closes
    else c.close()
  }
  setTimeout(() => process.exit(0), 200)
}

main()
