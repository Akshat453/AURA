#!/usr/bin/env node
// AURA professor voice assistant backend: the web UI, REST API and browser
// WebSocket on VOICE_ADDR (localhost), and the ESP32 WSS gateway on
// DEVICE_ADDR. Local speech services (whisper.cpp, Piper) and the RAG sidecar
// run as separate processes (scripts/start-local.sh).
import net from 'node:net'
import {AssistantServer} from './app.js'
import {load, loadDotEnv, splitHostPort} from './config/env.js'
import {createLogger} from './config/logger.js'
import {Context, sleep} from './utils/context.js'
import {Gemini} from './services/llm/gemini.js'
import {Gate, parseOptions, Router, Whisper} from './services/speech/whisper.js'
import {Piper} from './services/tts/piper.js'
import {Tavily, Unavailable} from './services/websearch/tavily.js'
import {Sidecar} from './services/embeddings/sidecar.js'
import {Service as RAGService} from './services/rag/service.js'
import {ProfessorService} from './modules/professor/service.js'
import {IntentRouter} from './services/assist/intent.js'
import {Registry} from './modules/device/registry.js'
import {serverTLSOptions} from './security/certificates.js'

export async function main() {
  loadDotEnv(process.env.AURA_ENV_FILE || '.env')
  const log = createLogger()
  let cfg
  try {
    cfg = load()
  } catch (e) {
    log.error({error: e.message}, 'configuration failed')
    process.exit(1)
  }
  let gem
  try {
    gem = Gemini.create(cfg.geminiKey, cfg.geminiModel, cfg.thinkingLevel, cfg.maxOutputTokens)
  } catch (e) {
    log.error({error: e.message}, 'Gemini initialization failed')
    process.exit(1)
  }
  let options
  try {
    options = parseOptions(cfg.whisperOptions)
  } catch (e) {
    log.error({error: e.message}, 'configuration failed')
    process.exit(1)
  }
  // One gate per whisper-server: one inference at a time, bounded FIFO waiting line.
  const speech = new Router({english: new Whisper(cfg.whisperURL, {options, gate: new Gate(cfg.whisperMaxQueue)}), englishModel: cfg.whisperModel})
  if (cfg.whisperMultilingualURL !== '') {
    speech.other = new Whisper(cfg.whisperMultilingualURL, {options, gate: new Gate(cfg.whisperMaxQueue)})
    speech.otherModel = cfg.whisperMultilingualModel
  }
  log.info({english_url: cfg.whisperURL, english_model: speech.model('en'), multilingual_url: cfg.whisperMultilingualURL, multilingual_model: speech.model('hi'), options}, 'whisper')
  const app = new AssistantServer(cfg, log, {stt: speech, llm: gem, tts: new Piper(cfg.piperENURL, cfg.piperHIURL, cfg.piperENVoice, cfg.piperHIVoice)})
  const [stop, stopAll] = Context.background().withCancel()

  let web = new Unavailable()
  if (cfg.webSearchProvider === 'tavily' && cfg.tavilyKey !== '') {
    const tavily = new Tavily(cfg.tavilyKey, cfg.webSearchMaxResults, cfg.webSearchTimeout, cfg.webSearchCacheTTL)
    tavily.baseURL = cfg.tavilyBaseURL // overridable only for local integration tests
    web = tavily
  }
  let docs = null
  let sidecar = null
  if (cfg.ragEnabled) {
    sidecar = new Sidecar(cfg.ragSidecarURL, cfg.ragEmbeddingModel)
    try {
      docs = new RAGService({dir: cfg.ragStoragePath, maxUploadBytes: cfg.ragMaxUploadMB * 2 ** 20, chunkTokens: cfg.ragChunkTokens, chunkOverlap: cfg.ragChunkOverlap,
        topK: cfg.ragTopK, hybrid: cfg.ragHybrid, minSimilarity: cfg.ragMinSimilarity, rrfK: cfg.ragRRFK}, sidecar, sidecar, log)
      docs.run(stop) // background indexing; queries never wait for it
    } catch (e) {
      log.error({error: e.message}, 'document index failed to open; continuing without local documents')
      docs = null
    }
  }
  app.setRetrieval(docs, web)

  // Professor tools. Notes and memos are indexed in the document index when RAG is enabled.
  let prof = null
  if (cfg.professorToolsEnabled) {
    try {
      prof = ProfessorService.open({dir: cfg.professorDataPath, zoneName: cfg.professorTimezone, workdayStart: cfg.workdayStart, workdayEnd: cfg.workdayEnd,
        memoMaxBytes: cfg.memoMaxStorageMB * 2 ** 20, memoMaxSeconds: cfg.memoMaxSeconds, index: docs, log})
    } catch (e) {
      log.error({error: e.message}, 'professor tools failed to open; continuing without them')
    }
    if (prof) {
      const features = {timetable: cfg.timetableEnabled, reminders: cfg.remindersEnabled, notes: cfg.notesEnabled, memos: cfg.voiceMemosEnabled, drafts: cfg.emailDraftsEnabled}
      app.setProfessor(prof, features)
      if (cfg.professorToolRouting && sidecar) {
        const router = new IntentRouter(sidecar)
        app.setToolRouter(router) // until init succeeds every request gets all tools
        ;(async () => {
          for (let attempt = 0; attempt < 60 && !stop.err; attempt++) {
            const [ictx, cancel] = stop.withTimeout(30000)
            try {
              await router.init(ictx)
              log.info('tool routing ready')
              return
            } catch {
              // sidecar not up yet
            } finally {
              cancel()
            }
            try {
              await sleep(10000, stop)
            } catch {
              return
            }
          }
          if (!stop.err) log.warn('tool routing unavailable (embedding sidecar not reachable); offering all tools')
        })()
      }
      if (features.reminders) prof.scheduler().run(stop) // overdue reminders fire once at startup
      setImmediate(() => {
        try {
          prof.reconcile()
        } catch (e) {
          log.warn({error: e.message}, 'note index reconcile failed')
        }
      })
      log.info({data: cfg.professorDataPath, timezone: cfg.professorTimezone, timetable: features.timetable, reminders: features.reminders, notes: features.notes,
        memos: features.memos, drafts: features.drafts, notes_to_gemini: cfg.notesToGemini, device_tools: cfg.deviceProfessorTools,
        confirmation_timeout_s: Math.trunc(cfg.actionConfirmationTimeout / 1000), google: app.enableGoogle()}, 'professor tools')
    }
  }
  log.info({rag: docs !== null, rag_storage: cfg.ragStoragePath, embedding_model: cfg.ragEmbeddingModel, send_context_to_gemini: cfg.ragSendContext,
    web_search: web.configured(), web_provider: web.name(), default_mode: cfg.defaultMode}, 'retrieval')

  const hp = splitHostPort(cfg.addr)
  if (!hp || net.isIP(hp.host) === 0 || !isLoopbackIP(hp.host)) {
    log.warn({addr: cfg.addr}, 'VOICE_ADDR is not a loopback address: the browser UI and document API are reachable from the network')
  }

  // ESP32 devices: a separate TLS listener that serves only /device.
  let gateway = null
  if (cfg.deviceAddr !== '') {
    let reg
    let tlsOptions
    try {
      reg = Registry.open(cfg.deviceRegistry)
    } catch (e) {
      log.error({error: e.message}, 'device registry failed')
      process.exit(1)
    }
    try {
      tlsOptions = serverTLSOptions(cfg.deviceTLSDir)
    } catch (e) {
      log.error({error: e.message}, 'device TLS failed')
      process.exit(1)
    }
    gateway = app.deviceGateway(reg)
    const dh = splitHostPort(cfg.deviceAddr)
    try {
      await gateway.listen({host: dh?.host || undefined, port: Number(dh?.port ?? 0)}, tlsOptions)
      log.info({addr: cfg.deviceAddr, frame_ms: cfg.deviceFrameMS, lead_ms: cfg.deviceLeadMS, echo: cfg.deviceEcho, debug_audio: cfg.deviceDebugAudioDir !== ''}, 'device listener (WSS)')
    } catch (e) {
      log.error({error: e.message}, 'device listener failed')
      process.exit(1)
    }
  }

  const server = app.createHTTPServer()
  await new Promise((resolve, reject) => {
    server.once('error', e => {
      log.error({error: e.message}, 'server failed')
      reject(e)
      process.exit(1)
    })
    server.listen(Number(hp?.port ?? 8090), hp?.host || undefined, resolve)
  })
  log.info({addr: cfg.addr}, 'server listening')

  let shuttingDown = false
  const shutdown = async signal => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({signal}, 'shutting down')
    const [down, cancel] = Context.background().withTimeout(5000)
    try {
      if (gateway) await app.closeDevices(down) // devices get "going away" and reconnect later
      await Promise.race([new Promise(r => server.close(() => r())), down.done()])
      server.closeAllConnections?.()
    } finally {
      cancel()
      stopAll()
      app.shutdown()
      prof?.close()
      docs?.close()
      process.exit(0)
    }
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  return {app, server}
}

function isLoopbackIP(host) {
  if (net.isIPv4(host)) return host.startsWith('127.')
  return host === '::1'
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
