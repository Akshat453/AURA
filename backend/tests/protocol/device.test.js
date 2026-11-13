// Device gateway protocol tests: a real TLS listener with a freshly generated
// local CA, real WebSocket framing and the reference device client, with fake
// STT/LLM/TTS providers (port of the Go device_test.go).
import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import {decodeWAV, speechLikePCM} from '../../src/utils/audio.js'
import {Context} from '../../src/utils/context.js'
import {mac} from '../../src/security/hmac.js'
import * as dp from '../../src/websocket/deviceProtocol.js'
import * as protocol from '../../src/websocket/protocol.js'
import {eventually, newDeviceEnv, turn, wait} from '../helpers/env.js'

// rawSession completes the handshake by hand so tests can send arbitrary frames.
export async function rawSession(env, editHello = null, wsOpts = {}) {
  const ws = new WebSocket(env.url, {ca: env.ca, maxPayload: 1 << 20, ...wsOpts})
  const queue = []
  let waiter = null
  ws.on('message', (data, isBinary) => {
    queue.push({data, isBinary})
    waiter?.()
  })
  let closed = false
  ws.on('close', () => {
    closed = true
    waiter?.()
  })
  ws.on('error', () => {})
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const next = async (timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    while (!queue.length) {
      if (closed) throw new Error('closed')
      if (Date.now() > deadline) throw new Error('timeout')
      await new Promise(r => {
        const t = setTimeout(r, 50)
        waiter = () => {
          clearTimeout(t)
          waiter = null
          r()
        }
      })
    }
    return queue.shift()
  }
  const ch = dp.decodeMessage((await next()).data)
  const h = {type: dp.Type.Hello, v: 1, device_id: 'desk-esp32', mac: mac(env.secrets['desk-esp32'], 'desk-esp32', ch.nonce), codecs: [dp.Supported], playback_buffer_ms: 500}
  if (editHello) editHello(h)
  ws.send(dp.encodeMessage(h))
  let reply = {}
  try {
    reply = dp.decodeMessage((await next()).data)
  } catch {}
  const raw = {
    ws, reply, next,
    send: m => ws.send(typeof m === 'string' ? m : dp.encodeMessage(m)),
    frame: (turnId, seq, pcm) => ws.send(protocol.encodeAudio({kind: protocol.AudioInputPCM, turnId, sequence: seq}, pcm)),
    readUntil: async (...types) => {
      for (;;) {
        const m = await next()
        if (m.isBinary) continue
        const msg = dp.decodeMessage(m.data)
        if (types.includes(msg.type)) return msg
      }
    },
  }
  env.clients.push({closeNow: () => ws.terminate()})
  return raw
}

test('full device turn over TLS: transcript, paced audio, history', async t => {
  const env = await newDeviceEnv(t)
  const c = await env.mustDial('desk-esp32')
  assert.equal(c.ready.frame_ms, 20)
  assert.equal(c.ready.lead_ms, 200)
  assert.deepEqual(c.ready.codec, dp.Supported)
  const res = await turn(c, {turn: 1, pcm: speechLikePCM(16000, 1.2, 0.3), language: 'en'})
  assert.equal(res.error, null)
  assert.equal(res.transcript, 'utterance of 1.2s')
  assert.ok(res.complete && res.ttsEnd && !res.ttsEnd.aborted)
  // 3 sentences × 0.6 s at 22.05 kHz, resampled to 16 kHz: 28.8 kB, 45 frames of 640 bytes.
  let total = 0
  res.frames.forEach((f, i) => {
    assert.equal(f.seq, i)
    assert.equal(f.turn, 1)
    assert.ok(f.pcm.length % 2 === 0 && f.pcm.length <= 640)
    total += f.pcm.length
  })
  assert.equal(total, 3 * 9600 * 2)
  assert.equal(res.ttsEnd.frames, res.frames.length)
  assert.equal(res.ttsEnd.duration_ms, 1800)
  // Real-time pacing: 1.8 s of audio takes at least 1.8 s − lead to arrive.
  const span = res.frames[res.frames.length - 1].at - res.frames[0].at
  assert.ok(span >= 1500, `frames were not paced: ${span} ms for 1.8 s of audio`)
  assert.equal(res.playback.underruns, 0)
  assert.ok(res.playback.maxBuffered <= 240, `max buffered ${res.playback.maxBuffered}`)
  // A second turn uses the session history.
  const res2 = await turn(c, {turn: 2, pcm: speechLikePCM(16000, 0.8, 0.3), language: 'en'})
  assert.ok(res2.complete && !res2.error)
  assert.equal(env.llm.prompts.get('utterance of 800ms'), 2, 'second turn should see one previous exchange (2 messages)')
})

test('device protocol validation: every malformed input is a typed error and never reaches STT', async t => {
  const env = await newDeviceEnv(t, c => (c.maxRecordingSeconds = 1))
  assert.equal((await rawSession(env, h => (h.codecs = [{format: 'opus', sample_rate: 48000, channels: 1}]))).reply.code, 'unsupported_codec')
  assert.equal((await rawSession(env, h => (h.v = 9))).reply.code, 'bad_hello')
  const s = await rawSession(env)
  assert.equal(s.reply.type, dp.Type.Ready)
  const codec = dp.Supported
  const wrong = {format: dp.FormatPCM16LE, sample_rate: 44100, channels: 1}
  const pcm = speechLikePCM(16000, 0.5, 0.3)
  const checks = [
    ['malformed JSON', () => s.send('{not json'), 'bad_message', ''],
    ['unknown type', () => s.send({type: 'format_disk'}), 'bad_request', ''],
    ['wrong sample rate', () => s.send({type: dp.Type.UtteranceStart, turn_id: 1, codec: wrong}), 'bad_request', ''],
    ['end without start', () => s.send({type: dp.Type.UtteranceEnd, turn_id: 7}), 'bad_request', ''],
    ['odd-length frame', async () => {
      s.send({type: dp.Type.UtteranceStart, turn_id: 2, codec})
      await s.readUntil(dp.Type.AudioStart)
      s.frame(2, 0, pcm.subarray(0, 641))
    }, 'bad_audio', ''],
    ['oversized frame', async () => {
      s.send({type: dp.Type.UtteranceStart, turn_id: 3, codec})
      await s.readUntil(dp.Type.AudioStart)
      s.frame(3, 0, Buffer.alloc(dp.MaxFrameBytes + 2))
    }, 'bad_audio', ''],
    ['sequence gap', async () => {
      s.send({type: dp.Type.UtteranceStart, turn_id: 4, codec})
      await s.readUntil(dp.Type.AudioStart)
      s.frame(4, 0, pcm.subarray(0, 640))
      s.frame(4, 2, pcm.subarray(640, 1280))
    }, 'bad_audio', ''],
    ['lost frames at end', async () => {
      s.send({type: dp.Type.UtteranceStart, turn_id: 5, codec})
      await s.readUntil(dp.Type.AudioStart)
      for (let i = 0; i < 20; i++) s.frame(5, i, pcm.subarray(i * 640, (i + 1) * 640)) // 0.4 s, but the device says 25 frames
      s.send({type: dp.Type.UtteranceEnd, turn_id: 5, frames: 25})
    }, 'bad_request', 'frames lost: received 20 of 25'],
    ['repeated turn id', () => s.send({type: dp.Type.UtteranceStart, turn_id: 5, codec}), 'bad_request', ''],
    ['utterance too long', async () => {
      s.send({type: dp.Type.UtteranceStart, turn_id: 6, codec})
      await s.readUntil(dp.Type.AudioStart)
      const long = speechLikePCM(16000, 1.5, 0.3) // limit is 1 s
      for (let i = 0; i * 3200 < long.length; i++) s.frame(6, i, long.subarray(i * 3200, Math.min((i + 1) * 3200, long.length)))
    }, 'bad_audio', ''],
  ]
  for (const [name, run, code, text] of checks) {
    await run()
    const m = await s.readUntil(dp.Type.Error)
    assert.equal(m.code, code, `${name}: got ${JSON.stringify(m)}`)
    assert.ok(m.message.includes(text), `${name}: ${m.message}`)
  }
  assert.equal(env.stt.calls, 0, 'invalid utterances must never reach STT')
  assert.ok(await env.mustDial('lab-esp32'))
})

test('utterance timeout discards the recording; debug audio is saved once, owner-only, exact', async t => {
  const env = await newDeviceEnv(t, c => (c.deviceUtteranceTimeout = 300))
  const debugDir = path.join(env.dir, 'debug-audio')
  env.srv.cfg.deviceDebugAudioDir = debugDir
  const s = await rawSession(env)
  s.send({type: dp.Type.UtteranceStart, turn_id: 1, codec: dp.Supported})
  await s.readUntil(dp.Type.AudioStart)
  s.frame(1, 0, speechLikePCM(16000, 0.04, 0.3))
  const m = await s.readUntil(dp.Type.Error)
  assert.equal(m.code, 'utterance_timeout')
  assert.equal(m.turn_id, 1)
  const c = await env.mustDial('lab-esp32')
  const pcm = speechLikePCM(16000, 0.7, 0.3)
  const res = await turn(c, {turn: 1, pcm})
  assert.equal(res.error, null)
  const files = fs.readdirSync(debugDir).filter(f => /^lab-esp32-.*-turn1-.*\.wav$/.test(f))
  assert.equal(files.length, 1)
  const st = fs.statSync(path.join(debugDir, files[0]))
  assert.equal(st.mode & 0o777, 0o600)
  const saved = decodeWAV(fs.readFileSync(path.join(debugDir, files[0])))
  assert.equal(saved.sampleRate, 16000)
  assert.ok(saved.pcm.equals(pcm))
})

test('echo mode returns the exact audio and needs DEVICE_ECHO', async t => {
  const env = await newDeviceEnv(t, c => (c.deviceEcho = true))
  const c = await env.mustDial('desk-esp32')
  const pcm = speechLikePCM(16000, 1.0, 0.3)
  const res = await turn(c, {turn: 1, pcm, mode: 'echo', frameBytes: 320})
  assert.equal(res.error, null)
  assert.ok(Buffer.concat(res.frames.map(f => f.pcm)).equals(pcm))
  assert.equal(res.ttsEnd.duration_ms, 1000)
  assert.equal(env.stt.calls, 0, 'echo mode must not call STT')
  const off = await newDeviceEnv(t)
  const d = await off.mustDial('desk-esp32')
  const r2 = await turn(d, {turn: 1, pcm, mode: 'echo'})
  assert.ok(r2.error?.message.includes('echo mode is disabled'))
})

test('abort and a new utterance stop the audio at once; nothing stale is played', async t => {
  const env = await newDeviceEnv(t)
  env.llm.delay = 150
  const c = await env.mustDial('desk-esp32')
  let res = await turn(c, {turn: 1, pcm: speechLikePCM(16000, 0.6, 0.3), abortAfterFirstAudio: true})
  assert.ok(res.ttsEnd?.aborted, `tts_end ${JSON.stringify(res.ttsEnd)}`)
  assert.ok(res.complete?.aborted)
  for (const f of res.frames) assert.ok(f.at <= res.abortedAt + 150, `frame ${f.seq} arrived ${f.at - res.abortedAt} ms after abort`)
  await eventually('LLM cancellation', () => env.llm.cancelled === 1)
  env.llm.delay = 5
  res = await turn(c, {turn: 2, pcm: speechLikePCM(16000, 0.6, 0.3)})
  assert.ok(res.complete && !res.complete.aborted, 'the device is not left busy')
  // A new utterance while turn 3 is speaking supersedes it.
  env.llm.delay = 200
  res = await turn(c, {turn: 3, pcm: speechLikePCM(16000, 0.6, 0.3), returnAfterFirstAudio: true})
  assert.ok(res.frames.length > 0, 'turn 3 never started speaking')
  res = await turn(c, {turn: 4, pcm: speechLikePCM(16000, 0.6, 0.3)})
  for (const f of res.frames) assert.equal(f.turn, 4)
  const late = res.stale.filter(f => f.turn === 3 && f.at > res.startedAt + 200).length
  assert.equal(late, 0, `${late} turn-3 frames arrived >200 ms after turn 4 started`)
  assert.ok(res.complete)
})

test('disconnects while recording or speaking clean up sessions and cancel work', async t => {
  const env = await newDeviceEnv(t)
  env.llm.delay = 300
  let c = await env.mustDial('desk-esp32')
  await c.send({type: dp.Type.UtteranceStart, turn_id: 1, codec: dp.Supported})
  await c.sendFrame(1, 0, Buffer.alloc(640))
  c.closeNow()
  await eventually('session cleanup after disconnect while recording', () => env.srv.deviceCount() === 0)
  c = await env.mustDial('desk-esp32')
  c.runTurn(Context.background(), {turn: 1, pcm: speechLikePCM(16000, 0.6, 0.3)}).catch(() => {})
  await wait(200)
  c.closeNow()
  await eventually('LLM cancelled after disconnect during reply', () => env.llm.cancelled >= 1)
  await eventually('session cleanup', () => env.srv.deviceCount() === 0)
  for (let i = 0; i < 20; i++) {
    const d = await env.dial('lab-esp32')
    if (i % 2 === 0) d.close()
    else d.closeNow()
  }
  await eventually('no sessions after cycles', () => env.srv.deviceCount() === 0)
})

test('a client that never answers pings is dropped (heartbeat)', async t => {
  const env = await newDeviceEnv(t, c => (c.deviceHeartbeat = 200))
  await rawSession(env, null, {autoPong: false})
  await eventually('server to drop an unresponsive device', () => env.srv.deviceCount() === 0)
})

test('sessions are isolated; reconnecting replaces the old session', async t => {
  const env = await newDeviceEnv(t)
  const a = await env.mustDial('desk-esp32')
  const b = await env.mustDial('lab-esp32')
  const results = await Promise.all([a, b].map((c, i) => turn(c, {turn: 1, pcm: speechLikePCM(16000, 0.6 + 0.4 * i, 0.3)})))
  assert.equal(results[0].transcript, 'utterance of 600ms')
  assert.equal(results[1].transcript, 'utterance of 1s')
  for (const r of results) assert.ok(r.complete && r.frames.length > 0)
  await env.mustDial('desk-esp32')
  await eventually('replacement keeps one session per device', () => env.srv.deviceCount() === 2)
})

test('graceful shutdown sends going-away (1001)', async t => {
  const env = await newDeviceEnv(t)
  const c = await env.mustDial('desk-esp32')
  await env.srv.closeDevices()
  const [ctx, cancel] = Context.background().withTimeout(5000)
  const err = await c.waitClosed(ctx)
  cancel()
  assert.equal(err.code, 1001)
  await eventually('no sessions after shutdown', () => env.srv.deviceCount() === 0)
})

test('a busy recognizer is reported as retryable stt_busy and nothing reaches Gemini', async t => {
  const env = await newDeviceEnv(t)
  env.stt.busy = true
  const dev = await env.mustDial('desk-esp32')
  let res = await turn(dev, {turn: 1, pcm: speechLikePCM(16000, 0.6, 0.3), language: 'en'})
  assert.equal(res.error?.code, 'stt_busy')
  assert.equal(env.llm.seen().length, 0)
  env.stt.busy = false
  res = await turn(dev, {turn: 2, pcm: speechLikePCM(16000, 0.6, 0.3), language: 'en'})
  assert.ok(res.complete, 'retry after busy failed')
})

test('playback_state and ping are accepted; pong answered', async t => {
  const env = await newDeviceEnv(t)
  const s = await rawSession(env)
  s.send({type: dp.Type.PlaybackState, turn_id: 1, state: 'underrun', buffered_ms: 0, underruns: 1})
  s.send({type: dp.Type.Ping})
  const m = await s.readUntil(dp.Type.Pong, dp.Type.Error)
  assert.equal(m.type, dp.Type.Pong)
  const d = [...env.srv.devices.sessions.values()][0]
  await eventually('underrun counted', () => d.underruns === 1)
})
