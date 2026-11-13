// Browser WebSocket endpoint (/ws). Browsers must come from this server's own
// origin (VOICE_ALLOWED_ORIGINS); clients without an Origin header (local
// tools such as e2e-check) are accepted, as with the Go backend.
import {WebSocketServer} from 'ws'
import * as protocol from './protocol.js'
import * as audio from '../utils/audio.js'
import {Client} from './client.js'
import {rejectUpgrade, sendWS} from './transport.js'

// globMatch implements Go's path.Match for host patterns (case-insensitive).
export function globMatch(pattern, s) {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end < 0) return false
      let cls = pattern.slice(i + 1, end)
      if (cls.startsWith('^')) cls = '^' + cls.slice(1)
      re += '[' + cls.replace(/\\/g, '\\\\') + ']'
      i = end
    } else if (c === '\\' && i + 1 < pattern.length) {
      re += '\\' + pattern[++i]
    } else re += c.replace(/[.+^${}()|]/g, '\\$&')
  }
  try {
    return new RegExp(re + '$').test(s)
  } catch {
    return false
  }
}

// authorizeOrigin mirrors coder/websocket's origin check; it returns an error
// message, or null when the origin is allowed.
export function authorizeOrigin(origin, host, patterns) {
  if (!origin) return null
  let u
  try {
    u = new URL(origin)
  } catch (e) {
    return `failed to parse Origin header ${JSON.stringify(origin)}: ${e.message}`
  }
  const originHost = u.host
  if ((host ?? '').toLowerCase() === originHost.toLowerCase() && originHost !== '') return null
  for (const p of patterns ?? []) {
    if (globMatch(p.toLowerCase(), originHost.toLowerCase())) return null
  }
  if (originHost === '') return `request Origin ${JSON.stringify(origin)} is not a valid URL with a host`
  return `request Origin ${JSON.stringify(originHost)} is not authorized for Host ${JSON.stringify(host ?? '')}`
}

export class BrowserGateway {
  constructor(server) {
    this.s = server
    // coder/websocket's default read limit is 32 KiB per message.
    this.wss = new WebSocketServer({noServer: true, maxPayload: 32768, perMessageDeflate: false})
  }

  handleUpgrade(req, socket, head) {
    const denied = authorizeOrigin(req.headers.origin, req.headers.host, this.s.cfg.allowedOrigins)
    if (denied) return rejectUpgrade(socket, 403, denied)
    this.wss.handleUpgrade(req, socket, head, ws => this.serve(ws))
  }

  serve(ws) {
    const s = this.s
    const [ctx, cancel] = s.baseCtx.withCancel()
    const transport = {
      sendText: text => sendWS(ws, text, {timeoutMs: 10000}),
      sendBinary: buf => sendWS(ws, buf, {binary: true, timeoutMs: 10000}),
    }
    const cl = new Client(s, transport, {connCtx: ctx})
    s.clients++
    s.addBrowser(cl)
    let chain = Promise.resolve()
    ws.on('message', (data, isBinary) => {
      // One message at a time, in order, like Go's read loop.
      chain = chain.then(async () => {
        if (ctx.err) return
        if (!isBinary) {
          try {
            await cl.control(ctx, data)
          } catch (e) {
            await cl.fail(ctx, 0, 'bad_request', e)
          }
        } else {
          try {
            cl.binary(data)
          } catch (e) {
            await cl.fail(ctx, e.turn ?? 0, 'bad_audio', e)
          }
        }
      })
    })
    ws.on('close', () => {
      cl.sess.abort()
      cancel()
      s.clients--
      s.removeBrowser(cl)
    })
    ws.on('error', () => {})
    const hello = {type: 'hello', version: protocol.Version, debug: s.cfg.audioDebug,
      audio: {binary_header_bytes: protocol.HeaderSize, channels: 1, input: 'pcm_s16le', output: 'wav', sample_rate: 'client_actual',
        whisper_model: s.modelFor('en'), whisper_multilingual_model: s.modelFor('hi'), whisper_sample_rate: audio.WhisperSampleRate},
      capabilities: null}
    chain = chain.then(async () => {
      hello.capabilities = await s.publicCapabilities(ctx)
      await cl.trySend(ctx, hello)
      await cl.trySend(ctx, {type: 'ready'})
    })
  }
}
