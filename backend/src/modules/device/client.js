// Reference device client used by the simulator and the tests. It does
// exactly what firmware must do: verify the server certificate against the
// provisioned CA (including the host name), answer the HMAC challenge, stream
// PCM utterances and buffer downlink audio. TLS verification is never disabled.
import WebSocket from 'ws'
import {Channel} from '../../utils/channel.js'
import {sleep} from '../../utils/context.js'
import * as protocol from '../../websocket/protocol.js'
import * as dp from '../../websocket/deviceProtocol.js'
import {mac} from '../../security/hmac.js'

export class CloseError extends Error {
  constructor(code, reason) {
    super(`failed to get reader: received close frame: status = ${code} and reason = ${JSON.stringify(reason)}`)
    this.name = 'CloseError'
    this.code = code
    this.reason = reason
  }
}

export class DeviceClient {
  constructor(ws, cfg) {
    this.ws = ws
    this.cfg = cfg
    this.ready = null
    this.inbox = new Channel(1 << 15)
    this.closeErr = null
  }

  // dial connects, verifies TLS and authenticates.
  // cfg: {url, deviceId, secret, ca (PEM), serverName, playbackBufferMS, firmware, autoPong}
  static async dial(cfg, {timeoutMs = 15000} = {}) {
    const opts = {ca: cfg.ca, rejectUnauthorized: true, minVersion: 'TLSv1.2', maxPayload: 1 << 20, handshakeTimeout: timeoutMs, autoPong: cfg.autoPong !== false}
    if (cfg.serverName) opts.servername = cfg.serverName
    const ws = new WebSocket(cfg.url, opts)
    const c = new DeviceClient(ws, {playbackBufferMS: 500, ...cfg})
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        try {
          const {header: h, payload} = protocol.decodeAudio(data)
          if (h.kind !== protocol.AudioOutputPCM) return
          c.inbox.send({frame: {turn: h.turnId, seq: h.sequence, pcm: Buffer.from(payload), at: performance.now()}}).catch(() => {})
        } catch {
          // ignore invalid frames
        }
        return
      }
      let m
      try {
        m = dp.decodeMessage(data)
      } catch {
        return
      }
      if (m.type === dp.Type.Ping) c.send({type: dp.Type.Pong}).catch(() => {})
      c.inbox.send({msg: m}).catch(() => {})
    })
    ws.on('close', (code, reason) => {
      c.closeErr = new CloseError(code, reason.toString())
      c.inbox.close()
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error('dial timeout'))
      }, timeoutMs)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', e => {
        clearTimeout(timer)
        reject(e)
      })
      ws.once('unexpected-response', (req, res) => {
        clearTimeout(timer)
        const err = new Error(`failed to WebSocket dial: expected handshake response status code 101 but got ${res.statusCode}`)
        err.statusCode = res.statusCode
        res.resume()
        reject(err)
      })
    })
    ws.on('error', () => {})
    const challenge = await c.#readMessage(timeoutMs)
    if (challenge.type !== dp.Type.Challenge || !challenge.nonce) {
      ws.terminate()
      throw new Error(`expected challenge, got ${JSON.stringify(challenge.type)}`)
    }
    const m = mac(cfg.secret, cfg.deviceId, challenge.nonce)
    await c.send({type: dp.Type.Hello, v: dp.ProtocolVersion, device_id: cfg.deviceId, firmware: cfg.firmware ?? '', mac: m, codecs: [dp.Supported], playback_buffer_ms: c.cfg.playbackBufferMS})
    const ready = await c.#readMessage(timeoutMs)
    if (ready.type !== dp.Type.Ready) {
      ws.terminate()
      throw new Error(`server refused the device: ${ready.code} ${ready.message}`)
    }
    c.ready = ready
    return c
  }

  async #readMessage(timeoutMs) {
    const timer = setTimeout(() => this.ws.terminate(), timeoutMs)
    try {
      for (;;) {
        const {value, ok} = await this.inbox.recv()
        if (!ok) throw this.closeErr ?? new Error('connection closed')
        if (value.msg) return value.msg
      }
    } finally {
      clearTimeout(timer)
    }
  }

  send(m) {
    return new Promise((resolve, reject) => this.ws.send(dp.encodeMessage(m), err => (err ? reject(err) : resolve())))
  }

  sendRaw(data, binary = false) {
    return new Promise((resolve, reject) => this.ws.send(data, {binary}, err => (err ? reject(err) : resolve())))
  }

  sendFrame(turn, seq, pcm) {
    return this.sendRaw(protocol.encodeAudio({kind: protocol.AudioInputPCM, turnId: turn, sequence: seq}, pcm), true)
  }

  // close ends the session normally; closeNow drops it (simulates Wi-Fi loss).
  close() {
    this.ws.close(1000, 'bye')
  }

  closeNow() {
    this.ws.terminate()
  }

  async next(ctx) {
    const {value, ok} = await this.inbox.recv(ctx)
    if (!ok) throw this.closeErr ?? new Error('connection closed')
    return value
  }

  // runTurn records one utterance and collects the reply until
  // turn_complete, an error for the turn, or ctx ends.
  // u: {turn, pcm, language, mode, frameBytes, realTime, abortAfterFirstAudio, returnAfterFirstAudio}
  async runTurn(ctx, u) {
    const frameBytes = u.frameBytes || 640
    const res = {transcript: '', language: '', events: [], frames: [], ttsStart: 0, ttsEnd: null, complete: null, error: null, sentEndAt: 0, firstAudioAt: 0,
      abortedAt: 0, startedAt: performance.now(), metrics: null, playback: null, stale: []}
    await this.send({type: dp.Type.UtteranceStart, turn_id: u.turn, codec: dp.Supported, language: u.language ?? '', mode: u.mode ?? ''})
    // Wait for audio_start (or an error) before streaming the microphone.
    for (;;) {
      const inb = await this.next(ctx)
      if (inb.frame) {
        if (inb.frame.turn !== u.turn) res.stale.push(inb.frame)
        continue
      }
      res.events.push(inb.msg)
      if (inb.msg.type === dp.Type.AudioStart && inb.msg.turn_id === u.turn) break
      if (inb.msg.type === dp.Type.Error) {
        res.error = inb.msg
        return res
      }
    }
    const frameMs = Math.trunc(frameBytes / dp.BytesPerMS)
    const start = performance.now()
    let seq = 0
    for (let off = 0; off < u.pcm.length; off += frameBytes) {
      let end = Math.min(off + frameBytes, u.pcm.length)
      if ((end - off) % 2 !== 0) end--
      await this.sendFrame(u.turn, seq, u.pcm.subarray(off, end))
      seq++
      if (u.realTime) await sleep(start + seq * frameMs - performance.now(), ctx)
    }
    await this.send({type: dp.Type.UtteranceEnd, turn_id: u.turn, frames: seq})
    res.sentEndAt = performance.now()
    return this.#collect(ctx, u, res)
  }

  async #collect(ctx, u, res) {
    for (;;) {
      const inb = await this.next(ctx)
      const f = inb.frame
      if (f) {
        if (f.turn !== u.turn) { // never play audio from another turn
          res.stale.push(f)
          continue
        }
        if (!res.firstAudioAt) {
          res.firstAudioAt = f.at
          if (u.returnAfterFirstAudio) {
            res.frames.push(f)
            return res
          }
          if (u.abortAfterFirstAudio) {
            res.abortedAt = performance.now()
            await this.send({type: dp.Type.Abort, turn_id: u.turn})
          }
        }
        res.frames.push(f)
        continue
      }
      const m = inb.msg
      if (m.turn_id !== 0 && m.turn_id !== u.turn) continue
      res.events.push(m)
      switch (m.type) {
        case dp.Type.STTResult:
          res.transcript = m.text
          res.language = m.language
          break
        case dp.Type.TTSStart:
          res.ttsStart = performance.now()
          break
        case dp.Type.TTSEnd:
          res.ttsEnd = m
          break
        case dp.Type.Metrics:
          res.metrics = m.metrics
          break
        case dp.Type.Error:
          res.error = m
          return res
        case dp.Type.TurnComplete:
          res.complete = m
          if (u.abortAfterFirstAudio && !res.ttsEnd) continue // wait for the aborted stream's tts_end
          res.playback = simulatePlayback(res.frames, this.ready.frame_ms, this.ready.lead_ms)
          return res
      }
      if (u.abortAfterFirstAudio && res.complete && res.ttsEnd) return res
    }
  }

  // waitClosed discards messages until the connection ends and returns why.
  async waitClosed(ctx) {
    for (;;) {
      try {
        await this.next(ctx)
      } catch (e) {
        return e
      }
    }
  }
}

// simulatePlayback applies the device contract to observed arrival times
// (ms): start once lead is buffered (or the stream ended), play one frame per
// frame duration, and on an empty buffer count an underrun and re-buffer lead.
export function simulatePlayback(frames, frameMs, leadMs) {
  const st = {frames: frames.length, audioMs: 0, startDelay: 0, underruns: 0, maxBuffered: 0, gaps: 0}
  if (frames.length === 0 || frameMs <= 0) return st
  for (const f of frames) st.audioMs += Math.trunc(f.pcm.length / dp.BytesPerMS)
  const need = Math.trunc(leadMs / frameMs)
  let i = 0
  const buffered = t => {
    let n = 0
    for (let j = i; j < frames.length && !(frames[j].at > t); j++) n++
    return n
  }
  const prefill = from => {
    let k = Math.min(from + need, frames.length) - 1
    if (k < from) k = from
    return frames[k].at
  }
  let playhead = prefill(0)
  st.startDelay = playhead - frames[0].at
  while (i < frames.length) {
    if (frames[i].at > playhead) { // buffer empty when this frame was due
      st.underruns++
      const resume = prefill(i)
      st.gaps += resume - playhead
      playhead = resume
    }
    const b = buffered(playhead) * frameMs
    if (b > st.maxBuffered) st.maxBuffered = b
    playhead += Math.trunc(frames[i].pcm.length / dp.BytesPerMS)
    i++
  }
  return st
}
