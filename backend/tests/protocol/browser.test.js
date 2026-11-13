// Browser WebSocket protocol (/ws): VAP1 input frames, resampling, ordering,
// debug audio, discarded recordings, development STT-only turns, origins.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {AssistantServer} from '../../src/app.js'
import {testConfig} from '../../src/config/env.js'
import {silentLogger} from '../../src/config/logger.js'
import {resamplePCM16, speechLikePCM, wav, WhisperSampleRate} from '../../src/utils/audio.js'
import * as protocol from '../../src/websocket/protocol.js'
import {normalizedLanguage, textLanguage} from '../../src/websocket/client.js'
import {saveManifest} from '../../src/utils/eval.js'
import {CapturedSTT, CountingLLM, FakeLLM, FakeTTS} from '../helpers/fakes.js'
import {startHTTP, TestWS, tmpDir} from '../helpers/env.js'

const frame = (turnId, sequence, pcm) => protocol.encodeAudio({kind: protocol.AudioInputPCM, turnId, sequence}, pcm)

async function server(t, cfgOver, stt, llm = new FakeLLM()) {
  const srv = new AssistantServer(testConfig({maxRecordingSeconds: 30, historyTurns: 2, sttTimeout: 1000, llmTimeout: 1000, ttsTimeout: 1000, ...cfgOver}), silentLogger(), {stt, llm, tts: new FakeTTS()})
  const http = await startHTTP(t, srv)
  t.after(() => srv.shutdown())
  return http
}

const awaitSTT = async stt => {
  const [ctx, cancel] = (await import('../../src/utils/context.js')).Context.background().withTimeout(5000)
  try {
    return (await stt.calls.recv(ctx)).value
  } finally {
    cancel()
  }
}

test('VAP1 header layout is byte-exact and big-endian', () => {
  const b = protocol.encodeAudio({kind: 5, flags: 0x0102, turnId: 0x01020304, sequence: 0xa0b0c0d0}, Buffer.from([9, 8]))
  assert.deepEqual([...b], [0x56, 0x41, 0x50, 0x31, 1, 5, 0x01, 0x02, 1, 2, 3, 4, 0xa0, 0xb0, 0xc0, 0xd0, 9, 8])
  const {header, payload} = protocol.decodeAudio(b)
  assert.deepEqual(header, {kind: 5, flags: 0x0102, turnId: 0x01020304, sequence: 0xa0b0c0d0})
  assert.deepEqual([...payload], [9, 8])
  assert.throws(() => protocol.decodeAudio(Buffer.from('bad')), /invalid audio frame header/)
  assert.throws(() => protocol.decodeAudio(Buffer.from('VAP2' + '\0'.repeat(12))), /invalid audio frame header/)
  const v2 = Buffer.from(b)
  v2[4] = 2
  assert.throws(() => protocol.decodeAudio(v2), /invalid audio frame header/, 'version byte checked')
})

test('a 48 kHz recording is resampled once to 16 kHz in order, with debug copies', async t => {
  const stt = new CapturedSTT()
  const {wsURL} = await server(t, {audioDebug: true, whisperModel: 'ggml-base.bin'}, stt)
  const ws = await TestWS.connect(wsURL)
  t.after(() => ws.terminate())
  await ws.expect('hello')
  await ws.expect('ready')
  await ws.sendEvent({type: 'debug_enable', debug: true})
  await ws.expect('debug_state')
  await ws.sendEvent({type: 'listen_start', turn_id: 7, language: 'hinglish', sample_rate: 48000})
  await ws.expect('ready')
  const pcm = speechLikePCM(48000, 1, 0.3)
  let seq = 0
  for (let off = 0; off < pcm.length; off += 2048) await ws.sendRaw(frame(7, seq++, pcm.subarray(off, Math.min(off + 2048, pcm.length))))
  await ws.sendEvent({type: 'listen_stop', turn_id: 7})
  const call = await awaitSTT(stt)
  assert.equal(call.bytes, WhisperSampleRate * 2)
  assert.equal(call.language, 'hi', 'Hinglish is transcribed as Hindi')
  let seenInput = false
  let seenWhisper = false
  for (;;) {
    const m = await ws.read()
    if (m.isBinary) {
      const {header} = protocol.decodeAudio(m.data)
      seenInput ||= header.kind === protocol.AudioDebugInputWAV
      seenWhisper ||= header.kind === protocol.AudioDebugWhisperWAV
      continue
    }
    if (JSON.parse(m.data).type === 'stt_result') break
  }
  assert.ok(seenInput && seenWhisper)
})

test('a bad frame discards the recording and is reported once; the next turn works', async t => {
  const stt = new CapturedSTT()
  const {wsURL} = await server(t, {}, stt)
  const ws = await TestWS.connect(wsURL)
  t.after(() => ws.terminate())
  await ws.expect('hello')
  await ws.expect('ready')
  const speech = speechLikePCM(48000, 1, 0.3)
  const send = (turn, s) => ws.sendRaw(frame(turn, s, speech.subarray(s * 960, (s + 1) * 960)))
  await ws.sendEvent({type: 'listen_start', turn_id: 1, language: 'en', sample_rate: 48000})
  await ws.expect('ready')
  await send(1, 0)
  for (let s = 2; s < 50; s++) await send(1, s) // sequence 1 is missing
  await ws.sendEvent({type: 'listen_stop', turn_id: 1})
  await ws.sendEvent({type: 'debug_enable'}) // sentinel: answered in order
  const errors = []
  for (;;) {
    const e = await ws.readEvent()
    if (e.type === 'error') errors.push(e)
    if (e.type === 'debug_state') break
  }
  assert.equal(errors.length, 1)
  assert.equal(errors[0].turn_id, 1)
  assert.equal(errors[0].code, 'bad_audio')
  assert.equal(stt.calls.length, 0, 'discarded recording reached STT')
  await ws.sendEvent({type: 'listen_start', turn_id: 2, language: 'en', sample_rate: 48000})
  await ws.expect('ready')
  for (let s = 0; s < 50; s++) await send(2, s)
  await ws.sendEvent({type: 'listen_stop', turn_id: 2})
  assert.equal((await awaitSTT(stt)).bytes, (50 * 960) / 3)
})

test('STT-only fixture turns need VOICE_DEV_TOOLS and are scored without the LLM', async t => {
  const dir = tmpDir()
  const fixturePCM = speechLikePCM(16000, 1, 0.3)
  fs.writeFileSync(path.join(dir, 'f.wav'), wav(fixturePCM, 16000))
  saveManifest(dir, {version: 1, fixtures: [{id: 'fx', language: 'en', file: 'f.wav', reference: 'test transcript', sample_rate: 16000}]})
  for (const devTools of [false, true]) {
    const stt = new CapturedSTT()
    const llm = new CountingLLM()
    const {wsURL} = await server(t, {devTools, fixturesDir: dir}, stt, llm)
    const ws = await TestWS.connect(wsURL)
    await ws.expect('hello')
    await ws.expect('ready')
    await ws.sendEvent({type: 'listen_start', turn_id: 1, language: 'en', sample_rate: 48000, stt_only: true, fixture: 'fx'})
    if (!devTools) {
      assert.equal((await ws.readEvent()).type, 'error', 'stt_only accepted without VOICE_DEV_TOOLS')
    } else {
      await ws.expect('ready')
      const pcm48 = resamplePCM16(fixturePCM, 16000, 48000)
      for (let i = 0, off = 0; off < pcm48.length; i++, off += 256) await ws.sendRaw(frame(1, i, pcm48.subarray(off, Math.min(off + 256, pcm48.length))))
      await ws.sendEvent({type: 'listen_stop', turn_id: 1})
      let done = false
      while (!done) {
        const e = await ws.readEvent()
        assert.notEqual(e.type, 'error', JSON.stringify(e))
        if (e.type === 'stt_result') {
          assert.ok(e.eval.score.exact, JSON.stringify(e.eval))
          assert.ok(e.eval.fidelity.correlation >= 0.99)
          assert.equal(e.eval.whisper_samples, fixturePCM.length / 2)
        }
        done = e.type === 'turn_complete'
      }
      assert.equal(llm.calls, 0)
    }
    ws.terminate()
  }
})

test('typed Auto language follows the script; an explicit selection wins', () => {
  for (const [text, want] of [['What is CS-301?', 'en'], ['यूनिट 3 में क्या है?', 'hi'], ['Unit 3 mein kya hai?', 'en']]) {
    assert.equal(normalizedLanguage('auto', textLanguage(text)), want)
  }
  assert.equal(normalizedLanguage('hinglish', textLanguage('Unit 3 mein kya hai?')), 'hinglish')
})

test('browser origin allow-list: own origin only (other local ports and sites refused)', async t => {
  const srv = new AssistantServer(testConfig({historyTurns: 2, allowedOrigins: ['127.0.0.1:8090', 'localhost:8090']}), silentLogger(), {stt: new CapturedSTT(), llm: new FakeLLM(), tts: new FakeTTS()})
  const {wsURL} = await startHTTP(t, srv)
  for (const [origin, ok] of [['http://127.0.0.1:8090', true], ['http://localhost:8090', true], ['http://localhost:3000', false], ['https://evil.example', false]]) {
    let status = 101
    try {
      const ws = await TestWS.connect(wsURL, {headers: {Origin: origin}})
      ws.terminate()
    } catch (e) {
      status = e.statusCode
    }
    assert.equal(status === 101, ok, `${origin}: ${status}`)
    if (!ok) assert.equal(status, 403)
  }
  // No Origin header (local tools such as e2e-check) is accepted.
  const ws = await TestWS.connect(wsURL)
  ws.terminate()
})

test('oversized browser messages close the connection (32 KiB read limit, 1009)', async t => {
  const {wsURL} = await server(t, {}, new CapturedSTT())
  const ws = await TestWS.connect(wsURL)
  await ws.expect('hello')
  await ws.expect('ready')
  await ws.sendRaw(Buffer.alloc(40000))
  const code = await new Promise(r => ws.ws.once('close', c => r(c)))
  assert.equal(code, 1009)
})

test('control-message validation: unknown event, empty or long text, bad sample rate', async t => {
  const {wsURL} = await server(t, {}, new CapturedSTT())
  const ws = await TestWS.connect(wsURL)
  t.after(() => ws.terminate())
  await ws.expect('hello')
  await ws.expect('ready')
  for (const [e, msg] of [
    [{type: 'format_disk'}, /unknown event/],
    [{type: 'text_input', turn_id: 1, text: ''}, /empty text/],
    [{type: 'text_input', turn_id: 1, text: 'x'.repeat(2001)}, /longer than 2000/],
    [{type: 'listen_start', turn_id: 1, sample_rate: 1000}, /unsupported microphone sample rate/],
    [{type: 'listen_stop', turn_id: 9}, /no matching recording/],
  ]) {
    await ws.sendEvent(e)
    const r = await ws.readEvent()
    assert.equal(r.type, 'error')
    assert.equal(r.code, 'bad_request')
    assert.match(r.message, msg)
  }
  await ws.sendRaw('{"type":', false)
  assert.equal((await ws.readEvent()).code, 'bad_request')
  await ws.sendRaw(Buffer.from('VAP1'))
  assert.equal((await ws.readEvent()).code, 'bad_audio')
})
