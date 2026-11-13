// The assistant server: state shared by the browser and device sessions, and
// the Express application for the localhost listener (web UI, REST API, /ws).
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import express from 'express'
import {Context} from './utils/context.js'
import * as audio from './utils/audio.js'
import {httpError, secure, writeJSON} from './middleware/security.js'
import {Session as ActionSession} from './modules/actions/actions.js'
import {Unavailable} from './services/websearch/tavily.js'
import {GoogleIntegration} from './services/google/google.js'
import {macNotify} from './modules/reminders/notify.js'
import {BrowserGateway} from './websocket/browserGateway.js'
import {DeviceGateway} from './websocket/deviceGateway.js'
import {registerDocs} from './routes/docs.js'
import {registerProfessor} from './routes/professor.js'
import {registerGoogle} from './routes/google.js'
import {registerDev} from './routes/dev.js'
import {compare as evalCompare, loadManifest, findFixture} from './utils/eval.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const publicDir = path.resolve(here, '..', 'public')

export class AssistantServer {
  // providers: {stt, llm, tts}; cfg from config/env.js (or testConfig).
  constructor(cfg, log, {stt, llm, tts}) {
    this.cfg = {...cfg}
    this.log = log
    this.stt = stt
    this.llm = llm
    this.tts = tts
    this.clients = 0
    this.docs = null // rag Service; null when RAG is disabled
    this.web = new Unavailable() // never null
    this.devices = null // DeviceGateway when the device listener is enabled
    this.prof = null // ProfessorService when professor tools are enabled
    this.features = {timetable: false, reminders: false, notes: false, memos: false, drafts: false}
    this.browsers = new Set() // open browser tabs, for reminder notifications
    this.memoAudio = new Map() // recordings kept briefly until a memo is saved
    this.google = null
    this.router = null // professor tool routing; null = offer all tools
    // deviceDocs is the professor's runtime choice for desk devices (starts at
    // DEVICE_ALLOW_DOC_CONTEXT); it never overrides RAG_SEND_CONTEXT_TO_GEMINI.
    this.deviceDocs = cfg.deviceAllowDocContext
    const [baseCtx, stop] = Context.background().withCancel()
    this.baseCtx = baseCtx
    this.stopBase = stop
    this.browserGateway = new BrowserGateway(this)
    this.unsubscribe = null
  }

  setRetrieval(docs, web) {
    this.docs = docs
    if (web) this.web = web
  }

  // setProfessor enables the professor tools and reminder notifications.
  setProfessor(prof, features) {
    this.prof = prof
    this.features = {...features}
    if (prof && features.reminders) this.unsubscribe = prof.scheduler().subscribe(n => this.notifyReminder(n))
  }

  setToolRouter(r) {
    this.router = r
  }

  // enableGoogle turns on the optional integrations when configured.
  enableGoogle(opts = {}) {
    this.google = GoogleIntegration.create(this.cfg, {log: this.log, ...opts})
    return this.google !== null
  }

  newActions() {
    return this.prof ? new ActionSession(this.cfg.actionConfirmationTimeout) : null
  }

  addBrowser(cl) {
    this.browsers.add(cl)
  }

  removeBrowser(cl) {
    this.browsers.delete(cl)
  }

  // notifyReminder delivers to each open browser tab independently. ESP32
  // devices are not notified: the device protocol has no server-initiated speech.
  notifyReminder(n) {
    const list = [...this.browsers]
    for (const cl of list) {
      const [ctx, cancel] = Context.background().withTimeout(3000)
      cl.send(ctx, {type: 'reminder_due', reminder: n}).catch(() => {}).finally(cancel)
    }
    if (this.cfg.reminderMacNotifications) {
      macNotify('Reminder', n.reminder.title).catch(e => this.log.warn({error: e.message}, 'macOS notification failed'))
    }
    this.log.info({reminder_id: n.reminder.id, browser_tabs: list.length, overdue: n.overdue}, 'reminder notification sent')
  }

  // modelFor names the Whisper model that transcribes the given language.
  modelFor(language) {
    if (typeof this.stt?.model === 'function') return this.stt.model(language)
    return this.cfg.whisperModel
  }

  // capabilities reports what retrieval a turn may use.
  capabilities(opts) {
    const c = {documents: false, docsToLLM: false, webConfigured: this.web.configured(), documentFilter: opts.docFilter ?? '', professorTools: []}
    if (this.docs) {
      c.documents = this.docs.hasReadyDocuments()
      // Both the server setting and this session's explicit consent are required.
      c.docsToLLM = this.cfg.ragSendContext && !!opts.allowDocs
    }
    return c
  }

  // publicCapabilities tells the UI what retrieval is available.
  async publicCapabilities(ctx) {
    const c = {
      rag_enabled: this.docs !== null, web_search: this.web.configured(), web_provider: this.web.name(),
      send_context_allowed: this.cfg.ragSendContext, default_mode: this.cfg.defaultMode,
      notes_send_allowed: this.prof !== null && this.cfg.notesToGemini,
      device_docs: this.cfg.ragSendContext && this.deviceDocs, devices_enabled: this.devices !== null,
    }
    if (this.docs) {
      c.max_upload_mb = Math.floor(this.docs.maxUploadBytes() / 2 ** 20)
      c.embedding_model = this.cfg.ragEmbeddingModel
      const [rctx, cancel] = (ctx ?? this.baseCtx).withTimeout(2000)
      try {
        await this.docs.embedderReady(rctx)
        c.embedder_ready = true
      } catch {
        c.embedder_ready = false
      } finally {
        cancel()
      }
      c.documents_ready = this.docs.hasReadyDocuments()
    }
    return c
  }

  deviceDocsStatus() {
    return {allowed: this.cfg.ragSendContext && this.deviceDocs, server_allowed: this.cfg.ragSendContext, devices_enabled: this.devices !== null}
  }

  calendarTool() {
    return this.google?.calendarTool() ?? null
  }

  googleStatus() {
    if (!this.google) return {configured: false, calendar: this.cfg.googleCalendarEnabled, gmail: this.cfg.gmailDraftsEnabled}
    return this.google.status()
  }

  // fixtureEval scores a WebSocket turn against its fixture (development tools).
  fixtureEval(r, whisperPCM, transcript, resampleMs, whisperMs) {
    const out = {
      fixture: r.fixture, input_sample_rate: r.sampleRate, input_samples: Math.floor(r.pcm.length / 2),
      input_duration_ms: Math.trunc((Math.floor(r.pcm.length / 2) * 1000) / r.sampleRate), whisper_sample_rate: audio.WhisperSampleRate,
      whisper_samples: Math.floor(whisperPCM.length / 2), whisper_duration_ms: Math.trunc((Math.floor(whisperPCM.length / 2) * 1000) / audio.WhisperSampleRate),
      language_sent: sttLang(r.language), model: this.modelFor(sttLang(r.language)), resample_ms: resampleMs, whisper_ms: whisperMs,
      levels: audio.analyzePCM16(r.pcm, r.sampleRate),
    }
    let f
    let wavData
    try {
      ;({fixture: f, wav: wavData} = this.loadFixture(r.fixture))
    } catch (e) {
      out.error = e.message
      return out
    }
    out.score = evalCompare(f.reference, transcript, f.language)
    try {
      const ref = audio.decodeToPCM16(wavData)
      if (ref.sampleRate === audio.WhisperSampleRate) out.fidelity = audio.align(ref.pcm, whisperPCM, ref.sampleRate, ref.sampleRate / 2)
    } catch {
      // not comparable
    }
    return out
  }

  // loadFixture reads only files named in the manifest, never arbitrary paths.
  loadFixture(id) {
    const m = loadManifest(this.cfg.fixturesDir)
    const f = findFixture(m, id)
    if (!f || path.isAbsolute(f.file) || f.file.split(/[\\/]/).includes('..') || f.file === '') throw new Error('unknown fixture')
    return {fixture: f, wav: fs.readFileSync(path.join(this.cfg.fixturesDir, f.file))}
  }

  // holdAudio keeps a memo recording in memory (only when asked) until saved.
  holdAudio(wavData) {
    const id = randomHex(12)
    const now = Date.now()
    for (const [k, v] of this.memoAudio) if (now > v.expires) this.memoAudio.delete(k)
    while (this.memoAudio.size >= 4) {
      let oldest = null
      for (const [k, v] of this.memoAudio) if (oldest === null || v.expires < this.memoAudio.get(oldest).expires) oldest = k
      this.memoAudio.delete(oldest)
    }
    this.memoAudio.set(id, {wav: wavData, expires: now + 15 * 60000})
    return id
  }

  takeAudio(id) {
    const h = this.memoAudio.get(id)
    this.memoAudio.delete(id)
    if (!h || Date.now() > h.expires) return null
    return h.wav
  }

  // handler builds the Express application for the localhost listener.
  handler() {
    const app = express()
    app.disable('x-powered-by')
    app.disable('etag')
    app.set('query parser', 'simple')
    app.use(secure)
    const routes = []
    const route = (method, pattern, ...handlers) => {
      routes.push({method, re: patternRegex(pattern)})
      app[method.toLowerCase()](pattern, ...handlers.map(h => wrap(h)))
    }
    route('GET', '/healthz', (req, res) => writeJSON(res, {status: 'ok', clients: this.clients}))
    route('GET', '/readyz', (req, res) => this.ready(req, res))
    registerDocs(this, route)
    registerProfessor(this, route)
    registerGoogle(this, route)
    if (this.cfg.devTools) registerDev(this, route, app)
    // Web UI: "/" serves the page; assets live under /web/ (the same paths
    // the Go server served, so the frontend is unchanged).
    const index = path.join(publicDir, 'web', 'index.html')
    app.get('/', (req, res) => res.type('html').send(fs.readFileSync(index)))
    app.use('/web', express.static(path.join(publicDir, 'web'), {cacheControl: false, etag: false, lastModified: false, index: 'index.html'}))
    // Wrong method on a known path: 405 with Allow, like Go's ServeMux.
    app.use((req, res, next) => {
      const allowed = [...new Set(routes.filter(r => r.re.test(req.path)).map(r => r.method))]
      if (allowed.length && !allowed.includes(req.method)) {
        if (allowed.includes('GET')) allowed.push('HEAD')
        res.set('Allow', allowed.join(', '))
        httpError(res, 'Method Not Allowed', 405)
        return
      }
      next()
    })
    app.use((req, res) => httpError(res, '404 page not found', 404))
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      this.log.error({error: err.message}, 'request failed')
      httpError(res, err.message, 500)
    })
    return app
  }

  // createHTTPServer returns the localhost listener (HTTP + /ws upgrades).
  createHTTPServer() {
    const server = http.createServer(this.handler())
    server.headersTimeout = 5000
    server.on('upgrade', (req, socket, head) => {
      const p = new URL(req.url, 'http://localhost').pathname
      if (p === '/ws') this.browserGateway.handleUpgrade(req, socket, head)
      else socket.destroy()
    })
    return server
  }

  async ready(req, res) {
    const [ctx, cancel] = this.baseCtx.withTimeout(2000)
    const checks = {}
    const run = async (name, fn) => {
      try {
        await fn(ctx)
        checks[name] = 'ok'
      } catch (e) {
        checks[name] = e.message
      }
    }
    await Promise.all([run('whisper', c => this.stt.ready(c)), run('gemini', c => this.llm.ready(c)), run('piper', c => this.tts.ready(c))])
    if (!this.docs) checks.rag = 'disabled'
    else {
      try {
        await this.docs.embedderReady(ctx)
        checks.rag = 'ok'
      } catch (e) {
        checks.rag = 'degraded: ' + e.message
      }
    }
    checks.web_search = this.web.configured() ? `configured (${this.web.name()})` : 'not configured'
    cancel()
    writeJSON(res, sortKeys(checks), checks.whisper !== 'ok' || checks.piper !== 'ok' ? 503 : 200)
  }

  // deviceHandler enables the device gateway for registry.
  deviceGateway(registry) {
    this.devices = new DeviceGateway(this, registry)
    return this.devices
  }

  deviceCount() {
    return this.devices?.count() ?? 0
  }

  async closeDevices(ctx) {
    await this.devices?.close(ctx)
  }

  shutdown() {
    this.unsubscribe?.()
    this.stopBase()
  }
}

const sortKeys = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]))

const sttLang = l => (l === 'en' || l === 'hi' ? l : l === 'hinglish' ? 'hi' : 'auto')

function randomHex(n) {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n))).toString('hex')
}

// patternRegex turns an Express path pattern ("/api/notes/:id") into a regex.
function patternRegex(pattern) {
  return new RegExp('^' + pattern.replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_]+/g, '[^/]+') + '/?$')
}

// wrap forwards rejected promises of async handlers to Express.
const wrap = h => (req, res, next) => {
  try {
    const r = h(req, res, next)
    if (r && typeof r.catch === 'function') r.catch(next)
  } catch (e) {
    next(e)
  }
}

export {evalCompare}
