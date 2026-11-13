// In-process test environments: a real TLS device listener with a freshly
// generated CA, and a browser /ws server with professor tools on a fake clock.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import {DateTime} from 'luxon'
import {AssistantServer} from '../../src/app.js'
import {testConfig} from '../../src/config/env.js'
import {silentLogger} from '../../src/config/logger.js'
import {Context} from '../../src/utils/context.js'
import * as protocol from '../../src/websocket/protocol.js'
import {caPEM, generateCA, issueServerCert, serverTLSOptions, CAFile} from '../../src/security/certificates.js'
import {Registry} from '../../src/modules/device/registry.js'
import {DeviceClient} from '../../src/modules/device/client.js'
import {ProfessorService} from '../../src/modules/professor/service.js'
import {FakeTTS, LengthSTT, MemoSTT, ScriptedLLM, SlowLLM, WavTTS} from './fakes.js'

export const tmpDir = (prefix = 'aura-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

export async function eventually(what, cond, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

export const wait = ms => new Promise(r => setTimeout(r, ms))

// Wednesday 21 October 2026, 09:00 IST.
export const testNow = DateTime.fromObject({year: 2026, month: 10, day: 21, hour: 9}, {zone: 'Asia/Kolkata'}).toMillis()

export class Clock {
  constructor(t) {
    this.t = t
  }
  now = () => this.t
}

let caCache = null
// sharedCA generates one CA + server certificate per test file (key
// generation is the slow part); each env still has its own registry.
async function sharedCA() {
  if (caCache) return caCache
  const dir = tmpDir('aura-tls-')
  await generateCA(dir, 'test CA')
  await issueServerCert(dir, ['127.0.0.1', 'voice-assistant.local'], 3600_000)
  caCache = {dir, ca: caPEM(path.join(dir, CAFile)), tls: serverTLSOptions(dir)}
  return caCache
}

export async function newDeviceEnv(t, mutate = null) {
  const dir = tmpDir()
  const tls = await sharedCA()
  const reg = Registry.open(path.join(dir, 'devices.json'))
  const secrets = {}
  for (const id of ['desk-esp32', 'lab-esp32']) secrets[id] = reg.add(id, id)
  const cfg = testConfig({maxRecordingSeconds: 5, historyTurns: 4, sttTimeout: 5000, llmTimeout: 10000, ttsTimeout: 5000,
    deviceFrameMS: 20, deviceLeadMS: 200, deviceMaxConnections: 4, deviceHeartbeat: 5000, deviceWriteTimeout: 2000, deviceHelloTimeout: 2000,
    toolMaxCalls: 2, ragTopK: 5, webSearchMaxResults: 5, defaultMode: 'general'})
  if (mutate) mutate(cfg)
  const env = {dir, reg, secrets, llm: new SlowLLM(5), stt: new LengthSTT(), tts: new WavTTS(0.6), ca: tls.ca, tlsDir: tls.dir}
  env.srv = new AssistantServer(cfg, silentLogger(), {stt: env.stt, llm: env.llm, tts: env.tts})
  const gw = env.srv.deviceGateway(reg)
  const addr = await gw.listen({host: '127.0.0.1', port: 0}, tls.tls)
  env.port = addr.port
  env.url = `wss://127.0.0.1:${addr.port}/device`
  env.clients = []
  env.dial = (id, extra = {}) => DeviceClient.dial({url: env.url, deviceId: id, secret: env.secrets[id], ca: env.ca, playbackBufferMS: 500, ...extra})
  env.mustDial = async (id, extra) => {
    const c = await env.dial(id, extra)
    env.clients.push(c)
    return c
  }
  t.after(async () => {
    for (const c of env.clients) c.closeNow()
    await env.srv.closeDevices()
    env.srv.shutdown()
  })
  return env
}

// turn runs one device turn with a 20 s timeout.
export async function turn(c, u, timeoutMs = 20000) {
  const [ctx, cancel] = Context.background().withTimeout(timeoutMs)
  try {
    return await c.runTurn(ctx, u)
  } finally {
    cancel()
  }
}

// TestWS is a minimal WebSocket client with an ordered message queue.
export class TestWS {
  constructor(ws) {
    this.ws = ws
    this.queue = []
    this.waiters = []
    this.closed = null
    ws.on('message', (data, isBinary) => {
      this.queue.push({data, isBinary})
      this.waiters.shift()?.()
    })
    ws.on('close', code => {
      this.closed = new Error(`closed ${code}`)
      for (const w of this.waiters.splice(0)) w()
    })
    ws.on('error', () => {})
  }

  static connect(url, opts = {}) {
    const ws = new WebSocket(url, {maxPayload: 8 << 20, ...opts})
    const t = new TestWS(ws)
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(t))
      ws.once('error', reject)
      ws.once('unexpected-response', (req, res) => {
        res.resume()
        reject(Object.assign(new Error(`unexpected status ${res.statusCode}`), {statusCode: res.statusCode}))
      })
    })
  }

  async read(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs
    while (this.queue.length === 0) {
      if (this.closed) throw this.closed
      const left = deadline - Date.now()
      if (left <= 0) throw new Error('read timeout')
      await new Promise(resolve => {
        const t = setTimeout(resolve, left)
        this.waiters.push(() => {
          clearTimeout(t)
          resolve()
        })
      })
    }
    return this.queue.shift()
  }

  // readEvent returns the next JSON text event (binary frames skipped).
  async readEvent(timeoutMs = 10000) {
    for (;;) {
      const m = await this.read(timeoutMs)
      if (!m.isBinary) return JSON.parse(m.data.toString('utf8'))
    }
  }

  async expect(type, timeoutMs = 10000) {
    const e = await this.readEvent(timeoutMs)
    if (e.type !== type) throw new Error(`got event ${JSON.stringify(e.type)} want ${JSON.stringify(type)}`)
    return e
  }

  sendEvent(e) {
    return new Promise((resolve, reject) => this.ws.send(protocol.encodeEvent(e), err => (err ? reject(err) : resolve())))
  }

  sendRaw(data, binary = true) {
    return new Promise((resolve, reject) => this.ws.send(data, {binary}, err => (err ? reject(err) : resolve())))
  }

  close() {
    this.ws.close(1000)
  }

  terminate() {
    this.ws.terminate()
  }
}

// startHTTP serves srv's localhost handler on a random port.
export async function startHTTP(t, srv) {
  const server = srv.createHTTPServer()
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  t.after(async () => {
    // Upgraded (WebSocket) sockets are not covered by closeAllConnections.
    for (const c of srv.browserGateway.wss.clients) c.terminate()
    server.closeAllConnections?.()
    await new Promise(r => server.close(() => r()))
  })
  return {server, port, base: `http://127.0.0.1:${port}`, wsURL: `ws://127.0.0.1:${port}/ws`}
}

export async function openTab(env) {
  const ws = await TestWS.connect(env.wsURL)
  env.tabs.push(ws)
  await ws.expect('hello')
  await ws.expect('ready')
  return new Tab(ws)
}

export class Tab {
  constructor(ws) {
    this.ws = ws
    this.turn = 0
  }

  // say sends typed input and collects the turn's events.
  async say(text, language = 'en', extra = {}) {
    this.turn++
    await this.ws.sendEvent({type: 'text_input', turn_id: this.turn, text, language, ...extra})
    const r = {text: '', events: [], pending: null, result: null, failed: null}
    for (;;) {
      const e = await this.ws.readEvent()
      r.events.push(e)
      if (e.type === 'llm_delta') r.text += e.text
      else if (e.type === 'action_pending') r.pending = e
      else if (e.type === 'action_result') r.result = e
      else if (e.type === 'error') {
        r.failed = e
        return r
      } else if (e.type === 'turn_complete' && e.turn_id === this.turn) return r
    }
  }

  async confirm(id, decision, edits) {
    const e = {type: 'action_confirm', action_id: id, decision}
    if (edits) e.edits = edits
    await this.ws.sendEvent(e)
    for (;;) {
      const ev = await this.ws.readEvent(5000)
      if (ev.type === 'action_result') return ev
    }
  }
}

export const actionStatus = e => e?.action?.status ?? ''

export async function newBrowserEnv(t, plan, mutate = null) {
  const clock = new Clock(testNow)
  const prof = ProfessorService.open({dir: tmpDir(), zoneName: 'Asia/Kolkata', now: clock.now, memoMaxBytes: 1 << 20, memoMaxSeconds: 30})
  const cfg = testConfig({maxRecordingSeconds: 5, historyTurns: 4, sttTimeout: 5000, llmTimeout: 10000, ttsTimeout: 5000,
    toolMaxCalls: 3, ragTopK: 5, webSearchMaxResults: 5, defaultMode: 'auto', maxOutputTokens: 220, professorOutputTokens: 1024,
    actionConfirmationTimeout: 60000, notesToGemini: true, deviceProfessorTools: 'all', professorToolMaxCalls: 4})
  if (mutate) mutate(cfg)
  const llm = new ScriptedLLM(plan)
  const srv = new AssistantServer(cfg, silentLogger(), {stt: new MemoSTT(), llm, tts: new FakeTTS()})
  srv.setProfessor(prof, {timetable: true, reminders: true, notes: true, memos: true, drafts: true})
  const http = await startHTTP(t, srv)
  const env = {srv, prof, llm, clock, ...http, tabs: []}
  t.after(() => {
    for (const tab of env.tabs) tab.terminate()
    srv.shutdown()
    env.prof.close()
  })
  env.open = () => openTab(env)
  env.reminders = () => env.prof.reminders({})
  return env
}

// api sends an HTTP request; header adds X-Voice-Assistant: 1.
export async function api(env, method, p, body, header = false, extraHeaders = {}) {
  const headers = {...extraHeaders}
  if (header) headers['X-Voice-Assistant'] = '1'
  let data
  if (Buffer.isBuffer(body)) data = body
  else if (body !== undefined && body !== null) data = JSON.stringify(body)
  const res = await fetch(env.base + p, {method, headers, body: data})
  const buf = Buffer.from(await res.arrayBuffer())
  return {res, status: res.status, body: buf, text: buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8'))}
}
