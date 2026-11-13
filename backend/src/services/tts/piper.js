// Piper HTTP client with one warm server per voice (English and Hindi).
import {Agent, fetch as undiciFetch} from 'undici'
import {Context} from '../../utils/context.js'
import {readLimited, requestError, statusText} from '../../utils/http.js'

export const hasDevanagari = s => /[ऀ-ॿ]/.test(s)

export class Piper {
  #agent = null

  constructor(enURL, hiURL, enVoice, hiVoice, {fetchImpl = null} = {}) {
    this.enURL = enURL.replace(/\/+$/, '')
    this.hiURL = hiURL.replace(/\/+$/, '')
    this.enVoice = enVoice
    this.hiVoice = hiVoice
    this.customFetch = fetchImpl
  }

  route(text, lang) {
    if (lang === 'hi' || lang === 'hinglish' || hasDevanagari(text)) return [this.hiURL, this.hiVoice]
    return [this.enURL, this.enVoice]
  }

  #fetch(url, init) {
    if (this.customFetch) return this.customFetch(url, init)
    this.#agent ??= new Agent({keepAliveTimeout: 30_000})
    return undiciFetch(url, {...init, dispatcher: this.#agent})
  }

  // closeIdleConnections drops kept-alive connections (Go's CloseIdleConnections).
  closeIdleConnections() {
    const a = this.#agent
    this.#agent = null
    a?.destroy().catch(() => {})
  }

  // ready checks both voices, retrying once on fresh connections.
  async ready(ctx = Context.background()) {
    try {
      await this.#ready(ctx)
    } catch (e) {
      if (ctx.err) throw e
      await this.#ready(ctx)
    }
  }

  async #ready(ctx) {
    for (const u of [this.enURL, this.hiURL]) {
      let r
      try {
        r = await this.#fetch(u + '/info', {signal: ctx.signal})
      } catch (e) {
        this.closeIdleConnections()
        throw requestError(e, `Get "${u}/info"`, ctx)
      }
      await r.body?.cancel?.()
      if (r.status !== 200) {
        this.closeIdleConnections()
        throw new Error(`piper unavailable: ${statusText(r)}`)
      }
      // macOS AirPlay Receiver also answers 200 on port 5000 (on all
      // interfaces and IPv6, so also "localhost:5000"); only Piper replies with JSON.
      const type = r.headers.get('content-type') ?? ''
      if (!type.startsWith('application/json')) {
        this.closeIdleConnections()
        throw new Error(`${u} is not a Piper server (got ${JSON.stringify(type)}, server ${JSON.stringify(r.headers.get('server') ?? '')}); check PIPER_*_URL`)
      }
    }
  }

  // synthesize retries once on a fresh connection after a failed answer: while
  // Piper is down, port 5000 reaches AirPlay, and without dropping that
  // kept-alive connection every later reply would go there.
  async synthesize(ctx, text, lang) {
    try {
      return await this.#synthesize(ctx, text, lang)
    } catch (e) {
      if (ctx.err) throw e
      this.closeIdleConnections()
      return this.#synthesize(ctx, text, lang)
    }
  }

  async #synthesize(ctx, text, lang) {
    const [u, voice] = this.route(text, lang)
    let r
    try {
      r = await this.#fetch(u + '/synthesize', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text, voice}), signal: ctx.signal})
    } catch (e) {
      throw requestError(e, `Post "${u}/synthesize"`, ctx)
    }
    const data = await readLimited(r, 16 << 20)
    if (r.status !== 200) throw new Error(`piper ${statusText(r)}: ${data.toString('utf8').trim()}`)
    if (data.length < 44 || data.toString('latin1', 0, 4) !== 'RIFF') throw new Error('piper returned invalid WAV')
    return {wav: data, sampleRate: data.readUInt32LE(24), voice}
  }
}
