#!/usr/bin/env node
// e2e-check drives one or two real turns over the browser WebSocket protocol,
// from a WAV recording (voice path: Whisper) or typed text, and prints what
// the browser would receive: transcript, route, sources, answer, speech and metrics.
import fs from 'node:fs'
import WebSocket from 'ws'
import {parseFlags} from '../src/utils/flags.js'
import {decodeWAV} from '../src/utils/audio.js'
import * as protocol from '../src/websocket/protocol.js'

function fatal(err) {
  if (err) {
    process.stderr.write(String(err.message ?? err) + '\n')
    process.exit(1)
  }
}

async function main() {
  const {values: f} = parseFlags(process.argv.slice(2), {
    url: {type: 'string', default: 'ws://127.0.0.1:8090/ws', usage: 'assistant WebSocket URL'},
    file: {type: 'string', default: '', usage: 'mono PCM16 WAV input (voice path)'},
    text: {type: 'string', default: '', usage: 'typed question (text path), instead of -file'},
    language: {type: 'string', default: 'auto', usage: 'en, hi, auto, or hinglish'},
    mode: {type: 'string', default: '', usage: 'general, documents, web or auto (empty = server default)'},
    'allow-docs': {type: 'bool', default: false, usage: 'consent to sending matching document passages to Gemini'},
    'follow-up': {type: 'string', default: '', usage: 'optional second text turn on the same session'},
    'abort-after': {type: 'duration', default: 0, usage: 'send abort this long after the first answer text (cancellation test)'},
  }, 'e2e-check')
  if ((f.file === '') === (f.text === '')) {
    process.stderr.write('exactly one of -file or -text is required\n')
    process.exit(2)
  }
  const deadline = setTimeout(() => fatal(new Error('context deadline exceeded')), 120000)
  const ws = new WebSocket(f.url, {maxPayload: 32 << 20})
  const queue = []
  let waiter = null
  let closed = null
  ws.on('message', (data, isBinary) => {
    queue.push({data, isBinary})
    waiter?.()
  })
  ws.on('close', code => {
    closed = new Error(`websocket closed (${code})`)
    waiter?.()
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  }).catch(fatal)
  const read = timeoutMs => new Promise((resolve, reject) => {
    const take = () => {
      if (queue.length) return resolve(queue.shift())
      if (closed) return reject(closed)
      waiter = () => {
        waiter = null
        clearTimeout(t)
        take()
      }
      return null
    }
    const t = timeoutMs ? setTimeout(() => {
      waiter = null
      reject(new Error('read timeout'))
    }, timeoutMs) : null
    take()
  })
  const writeEvent = e => ws.send(protocol.encodeEvent({version: protocol.Version, ...e}))
  const options = {mode: f.mode, allow_doc_context: f['allow-docs']}
  if (f.file) {
    let wav
    try {
      wav = decodeWAV(fs.readFileSync(f.file))
    } catch (e) {
      fatal(e)
    }
    writeEvent({...options, type: 'listen_start', turn_id: 1, language: f.language, sample_rate: wav.sampleRate})
    let seq = 0
    for (let off = 0; off < wav.pcm.length; off += 4096) {
      ws.send(protocol.encodeAudio({kind: protocol.AudioInputPCM, turnId: 1, sequence: seq}, wav.pcm.subarray(off, Math.min(off + 4096, wav.pcm.length))))
      seq++
    }
    writeEvent({type: 'listen_stop', turn_id: 1})
  } else {
    writeEvent({...options, type: 'text_input', turn_id: 1, text: f.text, language: f.language})
  }
  const fresh = turn => ({turn, transcript: '', language: '', answer: '', audio_sentences: 0, valid_wavs: 0, metrics: null})
  let out = fresh(1)
  let completed = 0
  let abortedAt = 0
  const print = r => process.stdout.write(JSON.stringify(r, null, 2) + '\n')
  for (;;) {
    let msg
    try {
      msg = await read(abortedAt ? Math.max(1, abortedAt + 1500 - Date.now()) : 0)
    } catch (e) {
      if (abortedAt) { // after an abort, watch 1.5 s for stale audio
        print(out)
        process.exit(0)
      }
      fatal(e)
    }
    if (msg.isBinary) {
      const {header, payload} = protocol.decodeAudio(msg.data)
      if (header.kind === protocol.AudioOutputWAV && header.turnId === out.turn) {
        if (abortedAt) {
          out.audio_frames_after_abort = (out.audio_frames_after_abort ?? 0) + 1
          continue
        }
        out.audio_sentences++
        try {
          decodeWAV(payload)
          out.valid_wavs++
        } catch {}
      }
      continue
    }
    const e = JSON.parse(msg.data.toString('utf8'))
    if (e.turn_id && e.turn_id !== out.turn) continue
    switch (e.type) {
      case 'stt_result':
        out.transcript = e.text ?? ''
        out.language = e.language ?? ''
        break
      case 'route':
        out.route = e.plan
        break
      case 'sources':
        out.sources = (e.sources ?? []).map(s => ({id: s.id, kind: s.kind, title: s.title, document: s.document, page: s.page, url: s.url}))
        break
      case 'tool_error':
        ;(out.tool_errors ??= []).push(`${e.code}: ${e.message}`)
        break
      case 'llm_delta':
        out.answer += e.text ?? ''
        if (f['abort-after'] > 0 && !abortedAt && out.turn === 1) {
          await new Promise(r => setTimeout(r, f['abort-after']))
          writeEvent({type: 'abort', turn_id: out.turn})
          abortedAt = Date.now()
          out.aborted = true
        }
        break
      case 'tts_start':
        ;(out.spoken ??= []).push(e.text)
        break
      case 'metrics':
        out.metrics = e.metrics
        break
      case 'error':
        fatal(new Error(`${e.code}: ${e.message}`))
        break
      case 'turn_complete':
        if (e.message === 'aborted') continue
        print(out)
        completed++
        if (completed === 1 && f['follow-up']) {
          out = fresh(2)
          writeEvent({...options, type: 'text_input', turn_id: 2, text: f['follow-up'], language: f.language})
          continue
        }
        clearTimeout(deadline)
        ws.close()
        return
    }
  }
}

main()
