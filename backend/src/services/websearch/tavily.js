// web_search behind a replaceable provider; the provider is Tavily
// (https://docs.tavily.com), basic depth (1 credit per search).
import {sleep} from '../../utils/context.js'
import {readLimited, requestError, statusText} from '../../utils/http.js'

export class NotConfiguredError extends Error {
  constructor() {
    super('web search is not configured (set TAVILY_API_KEY)')
    this.name = 'NotConfiguredError'
  }
}
export class UnauthorizedError extends Error {
  constructor() {
    super('web search API key was rejected')
    this.name = 'UnauthorizedError'
  }
}
export class QuotaError extends Error {
  constructor() {
    super('web search quota exhausted for this billing period')
    this.name = 'QuotaError'
  }
}
export class RateLimitError extends Error {
  constructor(retryAfterMs) {
    super(retryAfterMs > 0 ? `web search rate limited; retry after ${retryAfterMs / 1000}s` : 'web search rate limited')
    this.name = 'RateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}
class TransientError extends Error {}

export const MaxQueryRunes = 400
const maxSnippet = 700

const fieldsJoin = s => s.split(/\s+/u).filter(Boolean).join(' ')

// validateQuery trims a query and rejects empty or oversized input.
export function validateQuery(q) {
  q = fieldsJoin(q ?? '')
  if (q === '') throw new Error('search query is empty')
  if ([...q].length > MaxQueryRunes) throw new Error(`search query longer than ${MaxQueryRunes} characters`)
  return q
}

function truncate(s, n) {
  const r = [...s]
  if (r.length <= n) return s
  return r.slice(0, n).join('').trim() + '…'
}

export class Unavailable {
  async search() {
    throw new NotConfiguredError()
  }
  name() {
    return 'none'
  }
  configured() {
    return false
  }
}

export class Tavily {
  constructor(apiKey, maxResults, timeoutMs, cacheTTLMs, {fetchImpl = fetch, now = () => Date.now()} = {}) {
    this.apiKey = (apiKey ?? '').trim()
    this.baseURL = 'https://api.tavily.com'
    this.maxResults = maxResults
    this.timeoutMs = timeoutMs
    this.cacheTTL = cacheTTLMs
    this.fetch = fetchImpl
    this.now = now
    this.cache = new Map()
  }

  name() {
    return 'tavily'
  }

  configured() {
    return this.apiKey !== ''
  }

  // search returns at most limit results (bounded by maxResults and 10),
  // cached per normalized query for cacheTTL to avoid repeated credit use.
  async search(ctx, query, limit) {
    if (!this.configured()) throw new NotConfiguredError()
    query = validateQuery(query)
    if (limit <= 0 || limit > this.maxResults) limit = this.maxResults
    limit = Math.min(Math.max(limit, 1), 10)
    const key = query.toLowerCase() + '\x00' + limit
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < this.cacheTTL) return hit.results
    let results
    let err
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        results = await this.#search(ctx, query, limit)
        err = null
        break
      } catch (e) {
        err = e
        if (!(e instanceof TransientError) || ctx.err) break
        await sleep(400, ctx) // one retry for timeouts, network errors and 5xx only
      }
    }
    if (err) throw err instanceof TransientError ? new Error(err.message, {cause: err.cause}) : err
    this.cache.set(key, {at: this.now(), results})
    for (const [k, c] of this.cache) if (this.now() - c.at >= this.cacheTTL) this.cache.delete(k) // keep the cache bounded
    return results
  }

  async #search(ctx, query, limit) {
    const body = JSON.stringify({
      query, max_results: limit, search_depth: 'basic', topic: 'general',
      include_answer: false, include_raw_content: false, include_images: false, include_published_date: true,
    })
    const timeout = AbortSignal.timeout(Math.max(1, this.timeoutMs))
    const signal = AbortSignal.any([ctx.signal, timeout])
    let res
    let raw
    try {
      res = await this.fetch(this.baseURL.replace(/\/+$/, '') + '/search', {
        method: 'POST', body, signal, headers: {Authorization: 'Bearer ' + this.apiKey, 'Content-Type': 'application/json'},
      })
      raw = await readLimited(res, 4 << 20)
    } catch (e) {
      if (ctx.err) throw ctx.err
      throw new TransientError(`web search request failed: ${requestError(e, 'POST /search').message}`, {cause: e})
    }
    if (res.status === 401) throw new UnauthorizedError()
    if (res.status === 429) {
      const seconds = Number.parseInt(res.headers.get('retry-after') ?? '', 10)
      throw new RateLimitError(Number.isFinite(seconds) ? seconds * 1000 : 0)
    }
    if (res.status === 432 || res.status === 433) throw new QuotaError()
    if (res.status >= 500) throw new TransientError(`web search provider error: ${statusText(res)}`)
    if (res.status !== 200) throw new Error(`web search rejected the request: ${statusText(res)}`)
    let parsed
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch (e) {
      throw new Error(`web search response could not be parsed: ${e.message}`, {cause: e})
    }
    const retrievedAt = new Date(this.now()).toISOString()
    const out = []
    for (const r of parsed?.results ?? []) {
      let u
      try {
        u = new URL(String(r.url ?? ''))
      } catch {
        continue
      }
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.host === '') continue // never pass through a URL we cannot link safely
      const title = String(r.title ?? '').trim() || u.host
      out.push({title, url: String(r.url), snippet: truncate(fieldsJoin(String(r.content ?? '')), maxSnippet), published: String(r.published_date ?? '').trim(),
        retrieved_at: retrievedAt, score: Number(r.score) || 0, provider: 'tavily'})
      if (out.length === limit) break
    }
    return out
  }
}
