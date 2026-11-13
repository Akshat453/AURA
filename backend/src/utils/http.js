// Helpers for outgoing HTTP requests (global fetch, which is undici).

// rootCause returns the innermost error of a fetch failure.
export function rootCause(err) {
  let e = err
  for (let i = 0; i < 8 && e?.cause; i++) e = e.cause
  if (e instanceof AggregateError && e.errors?.length) return e.errors[0]
  return e
}

export function hasCode(err, code) {
  for (let e = err, i = 0; e && i < 8; e = e.cause, i++) {
    if (e.code === code) return true
    if (e instanceof AggregateError && e.errors?.some(x => x?.code === code)) return true
  }
  return false
}

// requestError turns a fetch exception into a readable error that keeps the
// cause chain (for ECONNREFUSED checks) and the context error when cancelled.
export function requestError(err, what, ctx) {
  if (ctx?.err) return ctx.err
  if (err?.name === 'CanceledError' || err?.name === 'DeadlineError') return err
  const cause = rootCause(err)
  const detail = cause?.code ? `${cause.code}${cause.message && !cause.message.includes(cause.code) ? ` (${cause.message})` : ''}` : cause?.message ?? String(err)
  const e = new Error(`${what}: ${detail}`, {cause: err})
  return e
}

// readLimited reads at most limit bytes of a response body.
export async function readLimited(res, limit) {
  if (!res.body) return Buffer.alloc(0)
  const chunks = []
  let total = 0
  for await (const chunk of res.body) {
    const b = Buffer.from(chunk)
    if (total + b.length > limit) {
      chunks.push(b.subarray(0, limit - total))
      total = limit
      try {
        await res.body.cancel?.()
      } catch {
        // already closed
      }
      break
    }
    chunks.push(b)
    total += b.length
  }
  return Buffer.concat(chunks, total)
}

export const statusText = res => `${res.status} ${res.statusText || httpStatusText(res.status)}`.trim()

const texts = {200: 'OK', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout'}
export const httpStatusText = code => texts[code] ?? ''
