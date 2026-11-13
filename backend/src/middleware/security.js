// HTTP security middleware and response helpers.
import net from 'node:net'

// httpError writes a plain-text error like Go's http.Error (the web page
// shows the text to the user).
export function httpError(res, message, status) {
  if (res.headersSent) return
  res.status(status)
  res.set('Content-Type', 'text/plain; charset=utf-8')
  res.set('X-Content-Type-Options', 'nosniff')
  res.send(message + '\n')
}

// writeJSON writes v as JSON with a trailing newline (Go's json.Encoder).
export function writeJSON(res, v, status = 200) {
  res.status(status)
  res.set('Content-Type', 'application/json')
  res.send(JSON.stringify(v ?? null) + '\n')
}

// secure adds headers to every response: no MIME sniffing, no caching.
export function secure(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Cache-Control', 'no-store')
  next()
}

export function isLoopback(address) {
  if (!address) return false
  let a = address
  if (a.startsWith('::ffff:')) a = a.slice(7)
  if (net.isIPv4(a)) return a.startsWith('127.')
  return a === '::1'
}

// localOnly rejects anything but loopback clients (defense in depth: the
// server already listens on 127.0.0.1 by default).
export function localOnly(req, res, next) {
  if (!isLoopback(req.socket.remoteAddress)) {
    httpError(res, 'development tools are available on localhost only', 403)
    return
  }
  next()
}

// sameOrigin blocks cross-site requests from other web pages open in the same
// browser: state-changing calls must carry a custom header (which forces a
// CORS preflight this server never approves) and, if sent, a same-host Origin.
export function sameOrigin(req, res, next) {
  if (req.get('X-Voice-Assistant') !== '1') {
    httpError(res, 'missing X-Voice-Assistant header', 403)
    return
  }
  const origin = req.get('Origin')
  if (origin) {
    let host
    try {
      host = new URL(origin).host
    } catch {
      host = null
    }
    if (host === null || host !== req.get('Host')) {
      httpError(res, 'cross-origin request rejected', 403)
      return
    }
  }
  const site = req.get('Sec-Fetch-Site')
  if (site && site !== 'same-origin' && site !== 'none') {
    httpError(res, 'cross-site request rejected', 403)
    return
  }
  next()
}

export class BodyTooLargeError extends Error {
  constructor() {
    super('http: request body too large')
    this.name = 'BodyTooLargeError'
  }
}

// readBody reads the request body, failing once more than limit bytes arrive
// (like http.MaxBytesReader).
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let done = false
    req.on('data', chunk => {
      if (done) return
      total += chunk.length
      if (total > limit) {
        done = true
        req.removeAllListeners('data')
        req.resume()
        reject(new BodyTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!done) {
        done = true
        resolve(Buffer.concat(chunks, total))
      }
    })
    req.on('error', e => {
      if (!done) {
        done = true
        reject(e)
      }
    })
  })
}

const goKind = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'boolean' ? 'bool' : typeof v === 'object' ? 'object' : typeof v)

// decodeJSON reads a JSON body (≤ 256 KB) into a Zod object schema, with Go's
// json.Decoder rules: keys match fields case-insensitively, unknown fields
// are rejected, a type mismatch is an error. On failure it answers 400 and
// returns null.
export async function decodeJSON(req, res, schema, structName = 'body', limit = 256 << 10) {
  let raw
  try {
    raw = await readBody(req, limit)
  } catch (e) {
    httpError(res, 'invalid JSON: ' + e.message, 400)
    return null
  }
  let value
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch (e) {
    httpError(res, 'invalid JSON: ' + (raw.length === 0 ? 'EOF' : e.message), 400)
    return null
  }
  if (goKind(value) !== 'object') {
    httpError(res, `invalid JSON: json: cannot unmarshal ${goKind(value)} into Go value of type ${structName}`, 400)
    return null
  }
  const shape = schema.shape
  const fold = new Map(Object.keys(shape).map(k => [k.toLowerCase(), k]))
  const mapped = {}
  for (const [k, v] of Object.entries(value)) {
    const field = Object.hasOwn(shape, k) ? k : fold.get(k.toLowerCase())
    if (!field) {
      httpError(res, `invalid JSON: json: unknown field ${JSON.stringify(k)}`, 400)
      return null
    }
    mapped[field] = v
  }
  const parsed = schema.safeParse(mapped)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const field = issue.path.join('.')
    const got = goKind(issue.path.reduce((o, p) => o?.[p], mapped))
    httpError(res, `invalid JSON: json: cannot unmarshal ${got} into Go struct field ${structName}.${field} of type ${issue.expected ?? 'value'}`, 400)
    return null
  }
  return parsed.data
}
