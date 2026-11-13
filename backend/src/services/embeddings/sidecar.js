// Client for scripts/rag_sidecar.py on localhost: multilingual-e5 embeddings
// (POST /embed) and PyMuPDF PDF extraction (POST /extract/pdf).
import {Context} from '../../utils/context.js'
import {readLimited, requestError, statusText} from '../../utils/http.js'

export class Sidecar {
  constructor(baseURL, modelName, {timeoutMs = 120_000, fetchImpl = fetch} = {}) {
    this.baseURL = baseURL.replace(/\/+$/, '')
    this.modelName = modelName
    this.timeoutMs = timeoutMs
    this.fetch = fetchImpl
  }

  model() {
    return this.modelName
  }

  #signal(ctx) {
    return AbortSignal.any([ctx.signal, AbortSignal.timeout(this.timeoutMs)])
  }

  async ready(ctx = Context.background()) {
    let res
    try {
      res = await this.fetch(this.baseURL + '/', {signal: this.#signal(ctx)})
    } catch (e) {
      throw new Error(`RAG sidecar unavailable: ${requestError(e, `Get "${this.baseURL}/"`, ctx).message}`, {cause: e})
    }
    let info
    try {
      info = JSON.parse((await readLimited(res, 1 << 20)).toString('utf8'))
    } catch (e) {
      throw new Error(`RAG sidecar: ${e.message}`, {cause: e})
    }
    const model = info?.model ?? info?.Model ?? ''
    if (model !== this.modelName) throw new Error(`RAG sidecar serves ${JSON.stringify(model)}, configured ${JSON.stringify(this.modelName)}`)
  }

  async #post(ctx, path, contentType, body) {
    let res
    try {
      res = await this.fetch(this.baseURL + path, {method: 'POST', headers: {'Content-Type': contentType}, body, signal: this.#signal(ctx)})
    } catch (e) {
      throw new Error(`RAG sidecar unavailable: ${requestError(e, `Post "${this.baseURL + path}"`, ctx).message}`, {cause: e})
    }
    const raw = await readLimited(res, 256 << 20)
    if (res.status !== 200) {
      let msg = ''
      try {
        const e = JSON.parse(raw.toString('utf8'))
        msg = e.error ?? e.Error ?? ''
      } catch {
        // not JSON
      }
      throw new Error(`RAG sidecar ${statusText(res)}: ${msg}`)
    }
    return JSON.parse(raw.toString('utf8'))
  }

  // embed returns one unit-length vector per text; kind is "query" or "passage".
  async embed(ctx, texts, kind) {
    const out = []
    for (let start = 0; start < texts.length; start += 16) { // small batches let queries interleave with ingestion
      const res = await this.#post(ctx, '/embed', 'application/json', JSON.stringify({texts: texts.slice(start, start + 16), kind}))
      out.push(...(res.vectors ?? res.Vectors ?? []))
    }
    if (out.length !== texts.length) throw new Error(`RAG sidecar returned ${out.length} vectors for ${texts.length} texts`)
    return out.map(v => Float32Array.from(v))
  }

  async extractPDF(ctx, data) {
    const res = await this.#post(ctx, '/extract/pdf', 'application/pdf', data)
    return (res.pages ?? res.Pages ?? []).map(p => ({page: p.page ?? p.Page ?? 0, heading: '', text: p.text ?? p.Text ?? ''}))
  }
}
