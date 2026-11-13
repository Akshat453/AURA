// Test doubles for the providers (ported from the Go test suite).
import crypto from 'node:crypto'
import {Channel} from '../../src/utils/channel.js'
import {sleep} from '../../src/utils/context.js'
import {formatDuration} from '../../src/utils/goparse.js'
import {speechLikePCM, wav} from '../../src/utils/audio.js'
import {BusyError} from '../../src/services/speech/whisper.js'
import {isEndTurn} from '../../src/services/provider.js'
import {keywordText} from '../../src/services/rag/store.js'

// LengthSTT transcribes as "utterance of <duration>" (or scripted texts in order).
export class LengthSTT {
  constructor() {
    this.calls = 0
    this.busy = false
    this.texts = []
    this.hinted = []
  }
  async ready() {}
  async transcribeWith(ctx, pcm, language, extra) {
    this.hinted.push({language, extra, bytes: pcm.length})
    return this.transcribe(ctx, pcm, language)
  }
  async transcribe(_ctx, pcm, language) {
    this.calls++
    if (this.busy) throw new BusyError()
    if (this.texts.length) return {text: this.texts.shift(), language}
    return {text: 'utterance of ' + formatDuration(Math.trunc(pcm.length / 32)), language: 'en'}
  }
}

// SlowLLM streams its answer in pieces and reports cancellation.
export class SlowLLM {
  constructor(delay = 5) {
    this.delay = delay
    this.cancelled = 0
    this.prompts = new Map()
    this.requests = []
    this.scripted = null // when set, it answers instead (tool-calling tests)
  }
  async ready() {}
  seen() {
    return [...this.requests]
  }
  async stream(ctx, req, delta) {
    this.prompts.set(req.prompt, req.history.length)
    this.requests.push(req)
    if (this.scripted) return this.scripted.stream(ctx, req, delta)
    let answer = ''
    for (const part of ['First sentence of the reply. ', 'Second sentence follows. ', 'Third and final sentence.']) {
      try {
        await sleep(this.delay, ctx)
      } catch (e) {
        this.cancelled++
        throw e
      }
      answer += part
      await delta(part)
    }
    return answer
  }
}

// WavTTS returns speech-like audio at Piper's 22.05 kHz and records what it said.
export class WavTTS {
  constructor(seconds = 0.6) {
    this.seconds = seconds
    this.spoken = []
  }
  async ready() {}
  said() {
    return this.spoken.join(' ')
  }
  async synthesize(_ctx, text) {
    this.spoken.push(text)
    return {wav: wav(speechLikePCM(22050, this.seconds, 0.3), 22050), sampleRate: 22050, voice: 'fake'}
  }
}

// ScriptedLLM behaves like Gemini's function calling: for each prompt it
// calls the scripted tools through the tools the server offered (so all
// validation and confirmation rules apply), then answers with final text.
export class ScriptedLLM {
  constructor(plan) {
    this.plan = plan
    this.requests = []
    this.results = []
  }
  async ready() {}
  calls() {
    return this.requests.length
  }
  last() {
    return this.results.length ? this.results[this.results.length - 1] : null
  }
  async stream(ctx, req, delta) {
    this.requests.push(req)
    let [calls, final] = this.plan(req.prompt)
    for (const c of calls ?? []) {
      const tool = (req.tools ?? []).find(t => t.name === c.name)
      let res = {error: 'tool not offered: ' + c.name}
      if (tool) {
        try {
          res = await tool.run(ctx, c.args)
        } catch (e) {
          if (isEndTurn(e)) {
            this.results.push(e.result)
            return ''
          }
          throw e
        }
      }
      this.results.push(res)
    }
    if (!final) final = 'OK.'
    await delta(final)
    return final
  }
}

// CapturedSTT reports each call on a channel.
export class CapturedSTT {
  constructor() {
    this.calls = new Channel(16)
  }
  async ready() {}
  async transcribe(_ctx, pcm, language) {
    await this.calls.send({bytes: pcm.length, language})
    return {text: 'test transcript', language: 'en'}
  }
}

export class FakeLLM {
  async ready() {}
  async stream(_ctx, req, delta) {
    const answer = 'Received ' + req.prompt + '.'
    await delta(answer)
    return answer
  }
}

export class CountingLLM {
  constructor() {
    this.calls = 0
  }
  async ready() {}
  async stream() {
    this.calls++
    return ''
  }
}

export class FakeTTS {
  async ready() {}
  async synthesize() {
    return {wav: wav(Buffer.alloc(3200), 16000), sampleRate: 16000, voice: 'fake'}
  }
}

// MemoSTT transcribes any audio as a fixed sentence.
export class MemoSTT {
  async ready() {}
  async transcribe() {
    return {text: ' Ask the lab assistant to reset the switches. ', language: 'en'}
  }
}

const unit = v => {
  let n = 0
  for (const x of v) n += x * x
  const d = Math.sqrt(n) + 1e-9
  return Float32Array.from(v, x => x / d)
}

// goHash is Go's `h = h*31 + int(r)` on a 64-bit int, bucketed into n.
function goHash(w, n) {
  let h = 0n
  for (const r of w) h = BigInt.asIntN(64, h * 31n + BigInt(r.codePointAt(0)))
  const b = BigInt(n)
  return Number(((h % b) + b) % b)
}

// WordEmbedder is a deterministic bag-of-words embedder (server tests).
export class WordEmbedder {
  model() {
    return 'test-words'
  }
  async embed(_ctx, texts) {
    return texts.map(t => {
      const v = new Array(32).fill(0)
      for (const w of t.toLowerCase().split(/\s+/u).filter(Boolean)) v[goHash(w, 32)]++
      return unit(v)
    })
  }
}

// HashEmbedder is the RAG tests' sha256 bag-of-words embedder; it counts texts.
export class HashEmbedder {
  constructor() {
    this.calls = 0
    this.fail = false
  }
  model() {
    return 'fake-embedder'
  }
  async embed(_ctx, texts) {
    if (this.fail) throw new Error('sidecar down')
    this.calls += texts.length
    return texts.map(t => {
      const v = new Array(64).fill(0)
      for (const w of keywordText(t).toLowerCase().split(/\s+/u).filter(Boolean)) {
        const h = crypto.createHash('sha256').update(w.replace(/^[.,:;?!]+|[.,:;?!]+$/g, '')).digest()
        v[h[0] % 64]++
      }
      return unit(v)
    })
  }
}

const hindiToEnglish = {'नॉर्मलाइजेशन': 'normalization', 'दोहराना': 'revise', 'नोट': 'note'}

// HindiWordEmbedder maps a few Hindi words to English (stands in for the multilingual model).
export class HindiWordEmbedder {
  model() {
    return 'test-words'
  }
  async embed(_ctx, texts) {
    return texts.map(t => {
      const v = new Array(64).fill(0)
      for (let w of t.toLowerCase().split(/\s+/u).filter(Boolean)) {
        w = w.replace(/^[.,:#?]+|[.,:#?]+$/g, '')
        if (hindiToEnglish[w]) w = hindiToEnglish[w]
        v[goHash(w, 64)]++
      }
      return unit(v)
    })
  }
}

// ConstEmbedder gives every text the same vector: only keywords decide.
export class ConstEmbedder {
  async embed(_ctx, texts) {
    return texts.map(() => Float32Array.from([1, 0]))
  }
}
