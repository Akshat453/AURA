// whisper.cpp server client (POST /inference), a per-server request gate and
// the English / multilingual router.
import {WhisperSampleRate, wav} from '../../utils/audio.js'
import {Context} from '../../utils/context.js'
import {readLimited, requestError, statusText} from '../../utils/http.js'

export class BusyError extends Error {
  constructor() {
    super('speech recognizer busy; please try again')
    this.name = 'BusyError'
  }
}

export const isBusy = e => e instanceof BusyError

// Gate admits one request at a time to a whisper-server (which runs one
// inference at a time anyway) with a bounded FIFO waiting line. Browser and
// device turns share it; waiting requests leave as soon as their context ends,
// and an overload fails fast.
export class Gate {
  #busy = false
  #queue = []
  #maxQueue

  constructor(maxQueue) {
    this.#maxQueue = Math.max(maxQueue, 0)
  }

  get waiting() {
    return this.#queue.length
  }

  // acquire resolves the time spent waiting (ms); it rejects with BusyError
  // when the queue is full, or with ctx.err when ctx ends while waiting.
  acquire(ctx) {
    const start = performance.now()
    if (!this.#busy) {
      this.#busy = true
      return Promise.resolve(0)
    }
    if (this.#queue.length >= this.#maxQueue) return Promise.reject(new BusyError())
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          ctx?.signal.removeEventListener('abort', onAbort)
          resolve(performance.now() - start)
        },
      }
      const onAbort = () => {
        const i = this.#queue.indexOf(waiter)
        if (i >= 0) this.#queue.splice(i, 1)
        const e = ctx.err
        e.queuedMs = performance.now() - start
        reject(e)
      }
      if (ctx) {
        if (ctx.err) {
          reject(ctx.err)
          return
        }
        ctx.signal.addEventListener('abort', onAbort, {once: true})
      }
      this.#queue.push(waiter)
    })
  }

  release() {
    const next = this.#queue.shift()
    if (next) next.grant()
    else this.#busy = false
  }
}

// parseOptions reads "key=value,key=value" decoding options.
export function parseOptions(s) {
  const out = {}
  for (let pair of (s ?? '').split(',')) {
    pair = pair.trim()
    if (pair === '') continue
    const i = pair.indexOf('=')
    if (i < 0 || pair.slice(0, i).trim() === '') throw new Error(`invalid Whisper option ${JSON.stringify(pair)}`)
    const k = pair.slice(0, i).trim()
    if (['file', 'language', 'translate', 'response_format'].includes(k)) throw new Error(`Whisper option ${JSON.stringify(k)} is managed by the application`)
    out[k] = pair.slice(i + 1).trim()
  }
  return out
}

// Whisper's annotations such as "(speaking in foreign language)", "[BLANK_AUDIO]".
const nonSpeechTag = /\[[^\]]*\]|\([^)]*\)/g

// isNonSpeech reports whether the transcript has no words outside annotations,
// so a tag is never forwarded to the LLM as if the user had said it.
export function isNonSpeech(text) {
  return text.replace(nonSpeechTag, '').replace(/^[ \t\n.,!?\-…]+|[ \t\n.,!?\-…]+$/g, '') === ''
}

export function whisperLanguage(language) {
  const l = (language ?? '').trim().toLowerCase()
  if (l === 'en' || l === 'hi') return l
  if (l === 'hinglish') return 'hi'
  return 'auto'
}

export function languageCode(language) {
  const l = (language ?? '').trim().toLowerCase()
  if (l === 'en' || l === 'english') return 'en'
  if (l === 'hi' || l === 'hindi') return 'hi'
  return l
}

export class Whisper {
  constructor(baseURL, {fetchImpl = fetch, options = {}, gate = null} = {}) {
    this.baseURL = baseURL.replace(/\/+$/, '')
    this.fetch = fetchImpl
    this.options = options // extra whisper-server form fields sent with every request
    this.gate = gate
  }

  withGate(gate) {
    this.gate = gate
    return this
  }

  async ready(ctx = Context.background()) {
    let res
    try {
      res = await this.fetch(this.baseURL + '/', {signal: ctx.signal})
    } catch (e) {
      throw requestError(e, `Get "${this.baseURL}/"`, ctx)
    }
    await res.body?.cancel?.()
    if (res.status >= 500) throw new Error(`whisper unavailable: ${statusText(res)}`)
  }

  transcribe(ctx, pcm, language) {
    return this.transcribeWAV(ctx, wav(pcm, WhisperSampleRate), language)
  }

  // transcribeWAV sends an existing WAV file unchanged, with exactly the request
  // parameters used for live audio (the evaluation's direct baseline).
  transcribeWAV(ctx, data, language) {
    return this.#gated(ctx, data, language, null)
  }

  // transcribeWith adds whisper-server fields for this request only (for
  // example a prompt while a confirmation question is pending).
  transcribeWith(ctx, pcm, language, extra) {
    return this.#gated(ctx, wav(pcm, WhisperSampleRate), language, extra)
  }

  async #gated(ctx, data, language, extra) {
    let queuedMs = 0
    if (this.gate) {
      queuedMs = await this.gate.acquire(ctx)
      try {
        const res = await this.#request(ctx, data, language, extra)
        return {...res, queuedMs}
      } finally {
        this.gate.release()
      }
    }
    return {...(await this.#request(ctx, data, language, extra)), queuedMs}
  }

  async #request(ctx, data, language, extra) {
    const form = new FormData()
    form.append('file', new Blob([data], {type: 'audio/wav'}), 'utterance.wav')
    language = whisperLanguage(language)
    form.append('language', language)
    form.append('translate', 'false')
    form.append('response_format', 'verbose_json')
    form.append('no_language_probabilities', 'true')
    form.append('no_timestamps', 'true')
    for (const [k, v] of Object.entries(this.options)) if (!extra || !Object.hasOwn(extra, k)) form.append(k, v)
    for (const [k, v] of Object.entries(extra ?? {})) form.append(k, v)
    const url = this.baseURL + '/inference'
    let res
    try {
      res = await this.fetch(url, {method: 'POST', body: form, signal: ctx.signal})
    } catch (e) {
      throw requestError(e, `Post "${url}"`, ctx)
    }
    const raw = (await readLimited(res, 2 << 20)).toString('utf8')
    if (res.status !== 200) throw new Error(`whisper ${statusText(res)}: ${raw.trim()}`)
    let out
    try {
      out = JSON.parse(raw)
    } catch (e) {
      throw new Error(`decode whisper response: ${e.message}`, {cause: e})
    }
    const text = String(out.text ?? '').trim()
    if (isNonSpeech(text)) throw new Error('no speech recognized')
    let lang = languageCode(String(out.language ?? ''))
    if (lang === '') lang = language
    return {text, language: lang}
  }
}

// Router sends English to a fast model and every other language (hi, and auto
// detection) to a more accurate multilingual model (docs/STT_EVALUATION.md).
export class Router {
  constructor({english, other = null, englishModel = '', otherModel = ''}) {
    this.english = english
    this.other = other
    this.englishModel = englishModel
    this.otherModel = otherModel
  }

  #pick(language) {
    return language === 'en' || !this.other ? this.english : this.other
  }

  model(language) {
    return language === 'en' || !this.other ? this.englishModel : this.otherModel
  }

  transcribe(ctx, pcm, language) {
    return this.#pick(language).transcribe(ctx, pcm, language)
  }

  transcribeWith(ctx, pcm, language, extra) {
    return this.#pick(language).transcribeWith(ctx, pcm, language, extra)
  }

  transcribeWAV(ctx, data, language) {
    return this.#pick(language).transcribeWAV(ctx, data, language)
  }

  async ready(ctx) {
    try {
      await this.english.ready(ctx)
    } catch (e) {
      throw new Error(`english model: ${e.message}`, {cause: e})
    }
    if (this.other) {
      try {
        await this.other.ready(ctx)
      } catch (e) {
        throw new Error(`multilingual model: ${e.message}`, {cause: e})
      }
    }
  }
}

// Answers to a pending confirmation question are short ("जी हाँ", "ठीक है").
// While a question is pending, Hindi answers are transcribed with this prompt
// after silence padding (measured with confirm-bench: approvals 55% → 73%).
export const ConfirmPromptHindi = 'हाँ। नहीं। जी हाँ। ठीक है। रहने दो।'
