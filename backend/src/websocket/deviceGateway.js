// ESP32 device gateway. Devices connect to /device on a separate TLS
// listener, authenticate with a per-device HMAC challenge-response, and then
// share the browser's turn pipeline (recording, Whisper, Gemini, Piper,
// sessions, cancellation): only the wire format differs. docs/DEVICE_PROTOCOL.md
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import {WebSocketServer} from 'ws'
import {Channel, ChannelClosedError} from '../utils/channel.js'
import {canceled, Context, sleep} from '../utils/context.js'
import * as audio from '../utils/audio.js'
import * as dp from './deviceProtocol.js'
import * as protocol from './protocol.js'
import {Pacer} from './playbackPacer.js'
import {Client} from './client.js'
import {newNonce} from '../security/hmac.js'
import {sendWS, closeWS, rejectUpgrade, waitPong} from './transport.js'

const maxPendingHandshakes = 16

const randomHex = n => crypto.randomBytes(n).toString('hex')

export class DeviceGateway {
  constructor(server, registry) {
    this.s = server
    this.reg = registry
    const [base, stop] = Context.background().withCancel()
    this.base = base
    this.stop = stop
    this.pending = 0
    this.sessions = new Map() // one session per device id
    this.active = new Set() // running serve() promises
    this.wss = new WebSocketServer({noServer: true, maxPayload: protocol.HeaderSize + dp.MaxFrameBytes + 512, perMessageDeflate: false})
  }

  // listen starts the WSS listener with tlsOptions; it serves only /device and /healthz.
  listen(addr, tlsOptions) {
    const httpsServer = https.createServer({...tlsOptions, maxHeaderSize: 16 << 10}, (req, res) => this.handleHTTP(req, res))
    httpsServer.headersTimeout = 5000
    httpsServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
    httpsServer.on('tlsClientError', () => {}) // bad handshakes (plaintext, untrusted clients) are not server errors
    this.httpsServer = httpsServer
    return new Promise((resolve, reject) => {
      httpsServer.once('error', reject)
      httpsServer.listen(addr.port, addr.host, () => {
        httpsServer.off('error', reject)
        resolve(httpsServer.address())
      })
    })
  }

  handleHTTP(req, res) {
    const url = new URL(req.url, 'https://device')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (url.pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method Not Allowed', {Allow: 'GET, HEAD'})
      res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'})
      res.end('ok\n')
      return
    }
    if (url.pathname === '/device') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method Not Allowed', {Allow: 'GET, HEAD'})
      if (req.headers.origin) return plain(res, 403, 'browsers cannot connect to the device endpoint')
      return plain(res, 426, 'WebSocket protocol violation: Connection header does not contain Upgrade', {Upgrade: 'websocket'})
    }
    plain(res, 404, '404 page not found')
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'https://device')
    if (url.pathname !== '/device' || req.method !== 'GET') return rejectUpgrade(socket, 404, '404 page not found')
    // Browsers always send Origin; devices never do. Refusing browser
    // connections here means no web page can talk to the device endpoint.
    if (req.headers.origin) return rejectUpgrade(socket, 403, 'browsers cannot connect to the device endpoint')
    if (this.pending + 1 > maxPendingHandshakes) return rejectUpgrade(socket, 503, 'too many handshakes in progress')
    this.pending++
    let released = false
    const release = () => {
      if (!released) {
        released = true
        this.pending--
      }
    }
    socket.once('close', release)
    this.wss.handleUpgrade(req, socket, head, ws => {
      const p = this.serve(ws, req, release).catch(e => this.s.log.error({error: e.message}, 'device session crashed')).finally(() => {
        release()
        this.active.delete(p)
      })
      this.active.add(p)
    })
  }

  // serve runs one device connection from challenge to disconnect.
  async serve(ws, req, release) {
    const cfg = this.s.cfg
    const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`
    const [ctx, cancel] = this.base.withCancel()
    // Messages are handled one at a time, like Go's single read loop; the
    // socket is paused while a backlog is waiting, so memory stays bounded.
    const inbox = new Channel(256)
    let closeInfo = null
    ws.on('message', (data, isBinary) => {
      inbox.send({data, isBinary}).catch(() => {})
      if (inbox.length >= 256 && !ws.isPaused) ws.pause()
    })
    inbox.drained = () => {
      if (ws.isPaused && inbox.length < 64) ws.resume()
    }
    ws.on('close', (code, reason) => {
      closeInfo = {code, reason: reason.toString()}
      inbox.close()
      cancel()
    })
    ws.on('error', () => {})
    const write = m => sendWS(ws, dp.encodeMessage(m), {timeoutMs: cfg.deviceWriteTimeout})
    const reject = async (code, message, logReason, status) => {
      this.s.log.warn({remote, code, reason: logReason}, 'device rejected')
      await write({type: dp.Type.Error, code, message}).catch(() => {})
      closeWS(ws, status, message)
    }
    try {
      const nonce = newNonce()
      try {
        await write({type: dp.Type.Challenge, v: dp.ProtocolVersion, nonce})
      } catch {
        return
      }
      const [hctx, hcancel] = ctx.withTimeout(cfg.deviceHelloTimeout)
      let first
      try {
        first = await inbox.recv(hctx)
      } catch {
        first = null
      } finally {
        hcancel()
      }
      if (!first?.ok) {
        this.s.log.warn({remote, error: closeInfo ? `closed (${closeInfo.code})` : 'context deadline exceeded'}, 'device handshake incomplete')
        ws.terminate()
        return
      }
      let hello
      try {
        if (first.value.isBinary || first.value.data.length > dp.MaxControlBytes) throw new Error()
        hello = dp.decodeMessage(first.value.data)
      } catch {
        await reject('bad_hello', 'first message must be a JSON hello', 'malformed hello', 1008)
        return
      }
      const invalid = dp.validateHello(hello)
      if (invalid) {
        await reject('bad_hello', invalid, invalid, 1008)
        return
      }
      try {
        this.reg.verify(hello.device_id, nonce, hello.mac)
      } catch (e) {
        // Same message for unknown, revoked and wrong-secret devices; the log keeps the reason.
        await sleep(300) // slow down guessing
        this.s.log.warn({remote, device_id: hello.device_id, reason: e.message}, 'device authentication failed')
        await write({type: dp.Type.Error, code: 'unauthorized', message: 'authentication failed'}).catch(() => {})
        closeWS(ws, 1008, 'authentication failed')
        return
      }
      let codec
      try {
        codec = dp.negotiate(hello.codecs)
      } catch (e) {
        await reject('unsupported_codec', e.message, e.message, 1003)
        return
      }
      release()

      const frame = cfg.deviceFrameMS
      const cl = new Client(this.s, null, {connCtx: ctx})
      const d = new DeviceLink(this, cl, ws, hello.device_id, randomHex(8), codec, frame, dp.leadFor(cfg.deviceLeadMS, frame, hello.playback_buffer_ms), cancel)
      cl.dev = d
      if (!this.register(d)) {
        await reject('busy', 'too many devices connected', 'connection limit', 1013)
        return
      }
      const started = Date.now()
      try {
        this.s.log.info({device_id: d.id, session: d.session, remote, firmware: hello.firmware, lead_ms: d.lead, frame_ms: cfg.deviceFrameMS}, 'device connected')
        try {
          await d.writeJSON(ctx, {type: dp.Type.Ready, v: dp.ProtocolVersion, session_id: d.session, codec, frame_ms: cfg.deviceFrameMS, lead_ms: d.lead,
            max_utterance_ms: cfg.maxRecordingSeconds * 1000, max_frame_bytes: dp.MaxFrameBytes, heartbeat_ms: cfg.deviceHeartbeat})
        } catch {
          return
        }
        d.heartbeat(ctx)
        const reason = await d.readLoop(ctx, inbox, () => closeInfo)
        cl.sess.abort()
        d.stopUtteranceTimer()
        this.s.log.info({device_id: d.id, session: d.session, seconds: Math.trunc((Date.now() - started) / 1000), reason, reported_underruns: d.underruns}, 'device disconnected')
      } finally {
        this.unregister(d)
      }
    } finally {
      cancel()
      if (ws.readyState === ws.OPEN) ws.terminate()
    }
  }

  register(d) {
    const old = this.sessions.get(d.id)
    if (old) {
      // A reconnecting device replaces its previous session (e.g. after Wi-Fi loss).
      old.cancel()
      closeWS(old.ws, 1001, 'replaced by a new connection')
    } else if (this.sessions.size >= this.s.cfg.deviceMaxConnections) {
      return false
    }
    this.sessions.set(d.id, d)
    return true
  }

  unregister(d) {
    if (this.sessions.get(d.id) === d) this.sessions.delete(d.id)
  }

  count() {
    return this.sessions.size
  }

  // close tells connected devices the server is going away, cancels their
  // turns and waits for their sessions to end (bounded by ctx).
  async close(ctx = null) {
    const waits = []
    for (const d of this.sessions.values()) {
      waits.push(new Promise(resolve => {
        if (d.ws.readyState === d.ws.CLOSED) return resolve()
        d.ws.once('close', resolve)
        closeWS(d.ws, 1001, 'server shutting down')
      }))
    }
    const bound = ctx ? ctx.done() : sleep(5000).catch(() => {})
    await Promise.race([Promise.all(waits), bound])
    this.stop()
    await Promise.race([Promise.all([...this.active]), bound])
    if (this.httpsServer) {
      await new Promise(resolve => this.httpsServer.close(() => resolve()))
      this.httpsServer.closeAllConnections?.()
    }
  }
}

function plain(res, status, text, headers = {}) {
  res.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers})
  res.end(text + '\n')
}

// DeviceLink is the device-specific side of a client session.
export class DeviceLink {
  constructor(g, cl, ws, id, session, codec, frame, lead, cancel) {
    Object.assign(this, {g, cl, ws, id, session, codec, frame, lead, cancel})
    this.stream = null
    this.lastTurn = 0
    this.echo = false
    this.timer = null
    this.underruns = 0
  }

  get cfg() {
    return this.g.s.cfg
  }

  // writeJSON writes a control message; a turn's cancellation never
  // interrupts a started write (bounded by the write timeout).
  writeJSON(_ctx, m) {
    return sendWS(this.ws, dp.encodeMessage(m), {timeoutMs: this.cfg.deviceWriteTimeout})
  }

  writeFrame(ctx, header, pcm) {
    if (ctx.err) return Promise.reject(ctx.err) // turn aborted: send nothing more
    return sendWS(this.ws, protocol.encodeAudio(header, pcm), {binary: true, timeoutMs: this.cfg.deviceWriteTimeout})
  }

  // event maps pipeline events to the device protocol. Text streaming,
  // sources and debug events are browser-only and are not sent to devices.
  async event(ctx, e) {
    switch (e.type) {
      case 'ready':
        if (!e.turn_id) return
        return this.writeJSON(ctx, {type: dp.Type.AudioStart, turn_id: e.turn_id, codec: this.codec, max_frame_bytes: dp.MaxFrameBytes})
      case 'stt_result':
        return this.writeJSON(ctx, {type: dp.Type.STTResult, turn_id: e.turn_id, text: e.text, language: e.language})
      case 'metrics':
        return this.writeJSON(ctx, {type: dp.Type.Metrics, turn_id: e.turn_id, metrics: e.metrics})
      case 'turn_complete':
        return this.writeJSON(ctx, {type: dp.Type.TurnComplete, turn_id: e.turn_id, aborted: e.message === 'aborted'})
      case 'error':
        return this.writeJSON(ctx, {type: dp.Type.Error, turn_id: e.turn_id, code: e.code, message: e.message})
    }
  }

  // heartbeat pings every DEVICE_HEARTBEAT and closes sessions that do not
  // answer, or whose credential was revoked.
  async heartbeat(ctx) {
    const interval = this.cfg.deviceHeartbeat
    while (!ctx.err) {
      try {
        await sleep(interval, ctx)
      } catch {
        return
      }
      if (!this.g.reg.active(this.id)) {
        this.g.s.log.warn({device_id: this.id}, 'device credential revoked; closing session')
        closeWS(this.ws, 1008, 'credential revoked')
        this.cancel()
        return
      }
      const ok = await waitPong(this.ws, interval, ctx) // the read side processes the pong
      if (ctx.err) return
      if (!ok) {
        this.g.s.log.warn({device_id: this.id, error: 'ping timed out'}, 'device heartbeat failed; closing session')
        this.ws.terminate()
        this.cancel()
        return
      }
    }
  }

  // readLoop handles device messages until the connection ends.
  async readLoop(ctx, inbox, closeInfo) {
    for (;;) {
      let msg
      try {
        msg = await inbox.recv(ctx)
      } catch {
        return 'closed by server'
      }
      inbox.drained?.()
      if (!msg.ok) {
        if (ctx.err && !closeInfo()) return 'closed by server'
        const c = closeInfo()
        return c ? `failed to get reader: received close frame: status = ${c.code} and reason = ${JSON.stringify(c.reason)}` : 'closed'
      }
      const {data, isBinary} = msg.value
      if (isBinary) {
        await this.binary(ctx, data)
        continue
      }
      if (data.length > dp.MaxControlBytes) {
        await this.cl.fail(ctx, 0, 'bad_message', new Error('control message too large'))
        continue
      }
      let m
      try {
        m = dp.decodeMessage(data)
      } catch {
        await this.cl.fail(ctx, 0, 'bad_message', new Error('control message is not valid JSON'))
        continue
      }
      try {
        await this.control(ctx, m)
      } catch (e) {
        await this.cl.fail(ctx, m.turn_id, 'bad_request', e)
      }
    }
  }

  async binary(ctx, data) {
    let header
    let payload
    let err = null
    try {
      ;({header, payload} = protocol.decodeAudio(data))
      if (header.kind !== protocol.AudioInputPCM) err = new Error('devices may only send input PCM frames (kind 1)')
      else if (payload.length === 0 || payload.length % 2 !== 0) err = new Error('audio payload must be a non-empty whole number of 16-bit samples')
      else if (payload.length > dp.MaxFrameBytes) err = new Error(`audio frame larger than ${dp.MaxFrameBytes} bytes`)
    } catch (e) {
      err = e
      header = {turnId: 0}
    }
    if (err) {
      this.dropRecording(header.turnId)
      await this.cl.fail(ctx, header.turnId, 'bad_audio', err)
      return
    }
    try {
      this.cl.binary(data)
    } catch (e) {
      await this.cl.fail(ctx, e.turn ?? 0, 'bad_audio', e)
    }
  }

  // dropRecording discards the active recording of turn after a framing error.
  dropRecording(turn) {
    if (this.cl.rec.active && this.cl.rec.turn === turn) {
      this.cl.rec = {...this.cl.rec, active: false, chunks: [], bytes: 0}
      this.cl.dropped = turn
    }
  }

  controlEvent(ctx, e) {
    return this.cl.control(ctx, {...eventDefaults(), ...e, version: protocol.Version})
  }

  async control(ctx, m) {
    const cfg = this.cfg
    switch (m.type) {
      case dp.Type.UtteranceStart: {
        if (m.mode === 'echo') {
          if (!cfg.deviceEcho) throw new Error('echo mode is disabled (DEVICE_ECHO=false)')
          m.mode = ''
          this.echo = true
        } else {
          this.echo = false
        }
        const invalid = dp.validateUtteranceStart(m, this.codec)
        if (invalid) throw new Error(invalid)
        const stale = m.turn_id <= this.lastTurn
        if (!stale) this.lastTurn = m.turn_id
        if (stale) throw new Error(`turn_id ${m.turn_id} is not newer than the previous turn`)
        // Starting a new utterance cancels any reply still in progress (single
        // active turn per device); its audio stops at once. The consent flags
        // come from server settings only, never from the device's message.
        await this.controlEvent(ctx, {type: 'listen_start', turn_id: m.turn_id, language: m.language, sample_rate: dp.SampleRate, mode: m.mode,
          allow_doc_context: this.g.s.deviceDocs, allow_note_context: cfg.deviceAllowNoteContext})
        this.startUtteranceTimer(ctx, m.turn_id)
        return
      }
      case dp.Type.UtteranceEnd: {
        this.stopUtteranceTimer()
        const r = this.cl.rec
        const active = r.active && r.turn === m.turn_id
        if (active && m.frames > 0 && m.frames !== r.nextSeq) {
          this.cl.rec = {...r, active: false, chunks: [], bytes: 0}
          this.cl.dropped = m.turn_id
          throw new Error(`frames lost: received ${r.nextSeq} of ${m.frames}`)
        }
        const echo = active && this.echo
        if (echo) this.cl.rec = {...r, active: false, chunks: [], bytes: 0}
        if (!active) throw new Error(`no active utterance ${m.turn_id}`)
        const pcm = Buffer.concat(r.chunks, r.bytes)
        this.saveDebugAudio(m.turn_id, pcm)
        if (echo) {
          this.echoBack(this.cl.sess.begin(ctx), m.turn_id, pcm).catch(() => {})
          return
        }
        return this.controlEvent(ctx, {type: 'listen_stop', turn_id: m.turn_id})
      }
      case dp.Type.Abort:
        this.stopUtteranceTimer()
        return this.controlEvent(ctx, {type: 'abort', turn_id: m.turn_id})
      case dp.Type.PlaybackState:
        if (m.state === 'underrun') {
          this.underruns++
          this.g.s.log.info({device_id: this.id, turn_id: m.turn_id, buffered_ms: m.buffered_ms, underruns: m.underruns}, 'device playback underrun')
        }
        return
      case dp.Type.Ping:
        return this.writeJSON(ctx, {type: dp.Type.Pong})
      case dp.Type.Pong:
        return
    }
    throw new Error(`unknown message type ${JSON.stringify(m.type)}`)
  }

  // startUtteranceTimer ends a recording whose utterance_end never arrives.
  startUtteranceTimer(ctx, turn) {
    let limit = this.cfg.deviceUtteranceTimeout
    if (!(limit > 0)) limit = this.cfg.maxRecordingSeconds * 1000 + 5000
    this.stopUtteranceTimer()
    this.timer = setTimeout(() => {
      const fire = this.cl.rec.active && this.cl.rec.turn === turn
      if (fire) {
        this.cl.rec = {...this.cl.rec, active: false, chunks: [], bytes: 0}
        this.cl.dropped = turn
        this.cl.fail(ctx, turn, 'utterance_timeout', new Error('utterance_end not received in time; recording discarded')).catch(() => {})
      }
    }, limit)
  }

  stopUtteranceTimer() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  // saveDebugAudio writes the exact received PCM when DEVICE_DEBUG_AUDIO_DIR
  // is set: one new owner-only file per turn, never overwritten.
  saveDebugAudio(turn, pcm) {
    const dir = this.cfg.deviceDebugAudioDir
    if (!dir || pcm.length === 0) return
    try {
      fs.mkdirSync(dir, {recursive: true, mode: 0o700})
    } catch (e) {
      this.g.s.log.warn({error: e.message}, 'debug audio directory unavailable')
      return
    }
    const now = new Date()
    const p2 = n => String(n).padStart(2, '0')
    const stamp = `${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCDate())}T${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}.${String(now.getUTCMilliseconds()).padStart(3, '0')}000`
    const name = `${this.id}-${this.session}-turn${turn}-${stamp}.wav`
    try {
      fs.writeFileSync(path.join(dir, name), audio.wav(pcm, dp.SampleRate), {flag: 'wx', mode: 0o600})
    } catch (e) {
      this.g.s.log.warn({error: e.message}, 'debug audio not saved')
      return
    }
    this.g.s.log.info({device_id: this.id, turn_id: turn, file: name, bytes: pcm.length}, 'device debug audio saved')
  }

  // echoBack streams the received utterance back unchanged (DEVICE_ECHO=true):
  // a check of uplink, downlink and pacing without any AI model.
  async echoBack(ctx, turn, pcm) {
    try {
      await this.pushPCM(ctx, turn, pcm)
      await this.endSpeech(ctx, turn)
    } catch (e) {
      await this.cl.fail(ctx, turn, 'playback_failed', e)
      return
    }
    await this.event(ctx, {type: 'turn_complete', turn_id: turn}).catch(() => {})
  }

  // speak converts one Piper sentence to the negotiated 16 kHz PCM and queues it.
  async speak(ctx, turn, a) {
    let decoded
    try {
      decoded = audio.decodeWAV(a.wav)
    } catch (e) {
      throw new Error(`TTS audio is not PCM16 WAV: ${e.message}`, {cause: e})
    }
    const pcm = audio.resamplePCM16(decoded.pcm, decoded.sampleRate, dp.SampleRate)
    return this.pushPCM(ctx, turn, pcm)
  }

  pushPCM(ctx, turn, pcm) {
    let st = this.stream
    if (!st || st.turn !== turn) {
      st = new PCMStream(this, turn, ctx)
      this.stream = st
    }
    return st.push(ctx, pcm)
  }

  // endSpeech flushes the turn's stream and waits until every frame was sent.
  endSpeech(ctx, turn) {
    const st = this.stream
    if (!st || st.turn !== turn) return Promise.resolve()
    return st.finish(ctx)
  }
}

function eventDefaults() {
  return {type: '', version: 0, turn_id: 0, sequence: 0, language: '', sample_rate: 0, capture_sample_rate: 0, debug: false, text: '', code: '', message: '',
    metrics: null, audio: null, mode: '', allow_doc_context: false, allow_note_context: false, document_id: '', sources: null, plan: null, capabilities: null,
    stt_only: false, fixture: '', eval: null, action_id: '', decision: '', edits: null, action: null, reminder: null, notes: null}
}

// PCMStream sends one turn's speech as paced PCM frames. Producers wait when
// its bounded queue is full, so memory stays bounded however long the reply.
class PCMStream {
  constructor(d, turn, ctx) {
    this.d = d
    this.turn = turn
    this.frames = new Channel(Math.trunc((d.lead + 1000) / d.frame) + 1)
    this.pending = Buffer.alloc(0) // partial frame carried between sentences
    this.err = null
    this.finished = false
    this.done = this.#run(ctx)
  }

  async push(ctx, pcm) {
    const size = dp.frameBytes(this.d.frame)
    this.pending = this.pending.length ? Buffer.concat([this.pending, pcm]) : Buffer.from(pcm)
    while (this.pending.length >= size) {
      const frame = Buffer.from(this.pending.subarray(0, size))
      this.pending = this.pending.subarray(size)
      await this.#enqueue(ctx, frame)
    }
  }

  async #enqueue(ctx, frame) {
    try {
      await this.frames.send(frame, ctx)
    } catch (e) {
      if (e instanceof ChannelClosedError) throw this.err ?? canceled
      throw e
    }
  }

  async finish(ctx) {
    if (this.pending.length > 0) { // last partial frame, still whole samples
      const last = this.pending
      this.pending = Buffer.alloc(0)
      try {
        await this.#enqueue(ctx, last)
      } catch (e) {
        if (ctx.err) throw ctx.err
      }
    }
    this.frames.close()
    await Promise.race([this.done, ctx.done().then(() => {
      throw ctx.err
    })])
    if (this.err) throw this.err
  }

  async #run(ctx) {
    const d = this.d
    try {
      try {
        await d.writeJSON(ctx, {type: dp.Type.TTSStart, turn_id: this.turn, codec: d.codec, frame_ms: d.frame, lead_ms: d.lead})
      } catch (e) {
        this.err = e
        return
      }
      const pacer = new Pacer(d.frame, d.lead)
      let seq = 0
      let bytes = 0
      let aborted = false
      for (;;) {
        let msg
        try {
          msg = await this.frames.recv(ctx)
        } catch {
          aborted = true
          break
        }
        if (!msg.ok) break
        const now = performance.now()
        const due = pacer.due(now)
        if (due > now) {
          try {
            await sleep(due - now, ctx)
          } catch {
            aborted = true
            break
          }
        }
        try {
          await d.writeFrame(ctx, {kind: protocol.AudioOutputPCM, turnId: this.turn, sequence: seq}, msg.value)
        } catch (e) {
          this.err = e
          aborted = true
          break
        }
        pacer.markSent(performance.now())
        seq++
        bytes += msg.value.length
      }
      await d.writeJSON(ctx, {type: dp.Type.TTSEnd, turn_id: this.turn, frames: seq, duration_ms: Math.trunc(bytes / dp.BytesPerMS), aborted, underruns: pacer.underruns}).catch(() => {})
      if (aborted && !this.err && ctx.err) this.err = ctx.err
    } finally {
      this.frames.close() // wakes a producer blocked on a full queue
      if (d.stream === this) d.stream = null
    }
  }
}
