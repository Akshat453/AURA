// Configuration from environment variables. Defaults, parsing rules (an
// unparsable number or duration falls back to its default, as the Go backend
// did) and validation messages are identical to the Go implementation, so
// every existing .env keeps working. Durations are milliseconds.
import fs from 'node:fs'
import dotenv from 'dotenv'
import {z} from 'zod'
import {atoi, parseBool, parseDuration, parseFloat64} from '../utils/goparse.js'
import {validZone, zoneOf} from '../utils/time.js'

export const DefaultWhisperOptions = ''

// loadDotEnv sets variables from an env file that are not already set (the
// process environment wins, as when start-local.sh sources .env). A missing
// file is not an error. Values are never logged.
export function loadDotEnv(path = '.env') {
  if (!fs.existsSync(path)) return
  dotenv.config({path, override: false, quiet: true})
}

const env = (e, k, d) => (e[k] !== undefined && e[k] !== '' ? e[k] : d)
// envOrUnset keeps an explicitly empty value (it disables an optional service).
const envOrUnset = (e, k, d) => (Object.hasOwn(e, k) ? e[k] : d)
const envInt = (e, k, d) => atoi(e[k] ?? '') ?? d
const envBool = (e, k, d) => parseBool(e[k] ?? '') ?? d
const envFloat = (e, k, d) => parseFloat64(e[k] ?? '') ?? d
const envDuration = (e, k, d) => parseDuration(e[k] ?? '') ?? d

// originPatterns returns the browser origins allowed to open /ws: the explicit
// VOICE_ALLOWED_ORIGINS list, or exactly this server's own address (and
// localhost on the same port).
export function originPatterns(list, addr) {
  if ((list ?? '').trim() !== '') {
    return list.split(',').map(p => p.trim()).filter(Boolean)
  }
  const hp = splitHostPort(addr)
  if (!hp) return [addr]
  const out = [joinHostPort(hp.host, hp.port), `localhost:${hp.port}`]
  if (hp.host !== '127.0.0.1') out.push(`127.0.0.1:${hp.port}`)
  return out
}

// splitHostPort mirrors net.SplitHostPort for "host:port" and "[v6]:port".
export function splitHostPort(addr) {
  if (typeof addr !== 'string') return null
  const v6 = /^\[([^\]]*)\]:(\d*)$/.exec(addr)
  if (v6) return {host: v6[1], port: v6[2]}
  const i = addr.lastIndexOf(':')
  if (i < 0) return null
  const host = addr.slice(0, i)
  if (host.includes(':')) return null
  return {host, port: addr.slice(i + 1)}
}

export const joinHostPort = (host, port) => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`)

// workday parses "HH:MM-HH:MM" into minutes after midnight.
function workday(v) {
  const parts = v.split('-')
  if (parts.length === 2) {
    const a = clock24(parts[0].trim())
    const b = clock24(parts[1].trim())
    if (a !== null && b !== null && b > a) return [a, b]
  }
  throw new Error('PROFESSOR_WORKDAY must look like 09:00-17:00')
}

function clock24(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null
  return Number(m[1]) * 60 + Number(m[2])
}

const fail = msg => {
  throw new Error(msg)
}

// Range checks, evaluated in the Go order so the first message matches.
const ConfigChecks = z.object({}).passthrough().superRefine((c, ctx) => {
  const checks = [
    [c.professorToolMaxCalls < 2 || c.professorToolMaxCalls > 6, 'PROFESSOR_TOOL_MAX_CALLS must be 2-6'],
  ]
  for (const [bad, message] of checks) if (bad) ctx.addIssue({code: 'custom', message})
})

export function load(e = process.env) {
  const c = {
    addr: env(e, 'VOICE_ADDR', '127.0.0.1:8090'),
    whisperURL: env(e, 'WHISPER_URL', 'http://127.0.0.1:8081'),
    whisperModel: env(e, 'WHISPER_MODEL', 'models/whisper/ggml-small.bin'),
    whisperOptions: env(e, 'WHISPER_OPTIONS', DefaultWhisperOptions),
    whisperMultilingualURL: envOrUnset(e, 'WHISPER_MULTILINGUAL_URL', 'http://127.0.0.1:8082'),
    whisperMultilingualModel: env(e, 'WHISPER_MULTILINGUAL_MODEL', 'models/whisper/ggml-large-v3-turbo-q5_0.bin'),
    geminiKey: e.GEMINI_API_KEY ?? '',
    geminiModel: env(e, 'GEMINI_MODEL', 'gemini-3.5-flash-lite'),
    thinkingLevel: env(e, 'GEMINI_THINKING_LEVEL', 'minimal'),
    piperENURL: env(e, 'PIPER_EN_URL', 'http://127.0.0.1:5000'),
    piperHIURL: env(e, 'PIPER_HI_URL', 'http://127.0.0.1:5001'),
    piperENVoice: env(e, 'PIPER_EN_VOICE', 'en_US-lessac-medium'),
    piperHIVoice: env(e, 'PIPER_HI_VOICE', 'hi_IN-priyamvada-medium'),
    maxRecordingSeconds: envInt(e, 'VOICE_MAX_RECORDING_SECONDS', 30),
    historyTurns: envInt(e, 'VOICE_HISTORY_TURNS', 8),
    maxOutputTokens: envInt(e, 'GEMINI_MAX_OUTPUT_TOKENS', 220),
    whisperMaxQueue: envInt(e, 'WHISPER_MAX_QUEUE', 4),
    sttTimeout: envDuration(e, 'VOICE_STT_TIMEOUT', 60000),
    llmTimeout: envDuration(e, 'VOICE_LLM_TIMEOUT', 30000),
    ttsTimeout: envDuration(e, 'VOICE_TTS_TIMEOUT', 30000),
    audioDebug: envBool(e, 'VOICE_AUDIO_DEBUG', false),
    devTools: envBool(e, 'VOICE_DEV_TOOLS', false),
    fixturesDir: env(e, 'VOICE_FIXTURES_DIR', 'runtime/fixtures'),
    reportDir: env(e, 'VOICE_REPORT_DIR', 'runtime/eval'),

    ragEnabled: envBool(e, 'RAG_ENABLED', true),
    ragHybrid: envBool(e, 'RAG_HYBRID_SEARCH', true),
    ragSendContext: envBool(e, 'RAG_SEND_CONTEXT_TO_GEMINI', true),
    ragStoragePath: env(e, 'RAG_STORAGE_PATH', './data/rag'),
    ragEmbeddingModel: env(e, 'RAG_EMBEDDING_MODEL', 'intfloat/multilingual-e5-small'),
    ragModelDir: env(e, 'RAG_EMBEDDING_MODEL_DIR', 'models/embeddings/multilingual-e5-small'),
    ragSidecarURL: env(e, 'RAG_SIDECAR_URL', 'http://127.0.0.1:8084'),
    ragTopK: envInt(e, 'RAG_TOP_K', 5),
    ragChunkTokens: envInt(e, 'RAG_CHUNK_TOKENS', 350),
    ragChunkOverlap: envInt(e, 'RAG_CHUNK_OVERLAP', 50),
    ragMaxUploadMB: envInt(e, 'RAG_MAX_UPLOAD_MB', 25),
    ragRRFK: envInt(e, 'RAG_RRF_K', 10),
    ragMinSimilarity: envFloat(e, 'RAG_MIN_SIMILARITY', 0.78),
    webSearchProvider: env(e, 'WEB_SEARCH_PROVIDER', 'tavily'),
    tavilyKey: e.TAVILY_API_KEY ?? '',
    tavilyBaseURL: env(e, 'TAVILY_BASE_URL', 'https://api.tavily.com'),
    webSearchMaxResults: envInt(e, 'WEB_SEARCH_MAX_RESULTS', 5),
    webSearchTimeout: envDuration(e, 'WEB_SEARCH_TIMEOUT', 8000),
    webSearchCacheTTL: envDuration(e, 'WEB_SEARCH_CACHE_TTL', 15 * 60000),
    toolMaxCalls: envInt(e, 'TOOL_MAX_CALLS_PER_TURN', 2),
    defaultMode: env(e, 'VOICE_DEFAULT_MODE', 'auto'),

    deviceAddr: e.DEVICE_ADDR ?? '',
    deviceTLSDir: env(e, 'DEVICE_TLS_DIR', 'data/device-tls'),
    deviceRegistry: env(e, 'DEVICE_REGISTRY', 'data/devices.json'),
    deviceDebugAudioDir: e.DEVICE_DEBUG_AUDIO_DIR ?? '',
    deviceFrameMS: envInt(e, 'DEVICE_FRAME_MS', 20),
    deviceLeadMS: envInt(e, 'DEVICE_PLAYBACK_LEAD_MS', 200),
    deviceMaxConnections: envInt(e, 'DEVICE_MAX_CONNECTIONS', 8),
    deviceHeartbeat: envDuration(e, 'DEVICE_HEARTBEAT', 15000),
    deviceWriteTimeout: envDuration(e, 'DEVICE_WRITE_TIMEOUT', 3000),
    deviceHelloTimeout: envDuration(e, 'DEVICE_HELLO_TIMEOUT', 5000),
    deviceUtteranceTimeout: envDuration(e, 'DEVICE_UTTERANCE_TIMEOUT', 0),
    deviceEcho: envBool(e, 'DEVICE_ECHO', false),
    deviceAllowDocContext: envBool(e, 'DEVICE_ALLOW_DOC_CONTEXT', false),
  }
  c.professorTimezone = env(e, 'PROFESSOR_TIMEZONE', 'Asia/Kolkata')
  c.professorDataPath = env(e, 'PROFESSOR_DATA_PATH', './data/professor')
  c.timetableEnabled = envBool(e, 'TIMETABLE_ENABLED', true)
  c.remindersEnabled = envBool(e, 'REMINDERS_ENABLED', true)
  c.notesEnabled = envBool(e, 'NOTES_ENABLED', true)
  c.voiceMemosEnabled = envBool(e, 'VOICE_MEMOS_ENABLED', true)
  c.emailDraftsEnabled = envBool(e, 'EMAIL_DRAFTS_ENABLED', true)
  // Note and memo text stays on this machine unless the server allows sharing
  // AND the browser session consents (devices: DEVICE_ALLOW_NOTE_CONTEXT).
  c.notesToGemini = envBool(e, 'NOTES_SEND_TO_GEMINI', false)
  c.reminderMacNotifications = envBool(e, 'REMINDER_MACOS_NOTIFICATIONS', false)
  c.deviceAllowNoteContext = envBool(e, 'DEVICE_ALLOW_NOTE_CONTEXT', false)
  c.actionConfirmationTimeout = envInt(e, 'ACTION_CONFIRMATION_TIMEOUT_SECONDS', 60) * 1000
  c.memoMaxSeconds = envInt(e, 'VOICE_MEMO_MAX_SECONDS', 120)
  c.memoMaxStorageMB = envInt(e, 'VOICE_MEMO_MAX_STORAGE_MB', 200)
  c.professorOutputTokens = envInt(e, 'PROFESSOR_TOOL_OUTPUT_TOKENS', 1024)
  c.professorToolMaxCalls = envInt(e, 'PROFESSOR_TOOL_MAX_CALLS', 4)
  c.professorToolRouting = envBool(e, 'PROFESSOR_TOOL_ROUTING', true)
  const checked = ConfigChecks.safeParse(c)
  if (!checked.success) fail(checked.error.issues[0].message)
  c.deviceProfessorTools = env(e, 'DEVICE_PROFESSOR_TOOLS', 'all')
  c.appEnv = env(e, 'APP_ENV', 'development').toLowerCase()
  c.nodeEnv = e.NODE_ENV ?? ''
  c.googleCalendarEnabled = envBool(e, 'GOOGLE_CALENDAR_ENABLED', false)
  c.gmailDraftsEnabled = envBool(e, 'GMAIL_DRAFTS_ENABLED', false)
  c.googleClientID = e.GOOGLE_OAUTH_CLIENT_ID ?? ''
  c.googleClientSecret = e.GOOGLE_OAUTH_CLIENT_SECRET ?? ''
  c.googleTokenPath = env(e, 'GOOGLE_TOKEN_PATH', './data/google-token.json')
  c.googleRedirectURL = env(e, 'GOOGLE_OAUTH_REDIRECT_URL', `http://${c.addr}/api/google/callback`)
  if (!validZone(c.professorTimezone)) fail('PROFESSOR_TIMEZONE must be an IANA time zone such as Asia/Kolkata')
  c.professorZone = zoneOf(c.professorTimezone)
  ;[c.workdayStart, c.workdayEnd] = workday(env(e, 'PROFESSOR_WORKDAY', '09:00-17:00'))

  const rules = [
    [c.actionConfirmationTimeout < 10000 || c.actionConfirmationTimeout > 600000, 'ACTION_CONFIRMATION_TIMEOUT_SECONDS must be 10-600'],
    [c.memoMaxSeconds < 5 || c.memoMaxSeconds > 600 || c.memoMaxStorageMB < 0 || c.professorOutputTokens < 256 || c.professorOutputTokens > 8192,
      'VOICE_MEMO_MAX_SECONDS must be 5-600, VOICE_MEMO_MAX_STORAGE_MB ≥ 0, PROFESSOR_TOOL_OUTPUT_TOKENS 256-8192'],
    [!['all', 'read', 'none'].includes(c.deviceProfessorTools), 'DEVICE_PROFESSOR_TOOLS must be all, read or none'],
  ]
  for (const [bad, message] of rules) if (bad) fail(message)
  c.allowedOrigins = originPatterns(e.VOICE_ALLOWED_ORIGINS, c.addr)
  const more = [
    [c.maxRecordingSeconds < 1 || c.maxRecordingSeconds > 120 || c.historyTurns < 1 || c.maxOutputTokens < 1, 'invalid numeric configuration'],
    [c.thinkingLevel === 'minimal' && c.geminiModel === 'gemini-3.8-flash', 'gemini-3.8-flash does not support minimal thinking; use low, medium, or high'],
    [!['minimal', 'low', 'medium', 'high'].includes(c.thinkingLevel), 'GEMINI_THINKING_LEVEL must be minimal, low, medium, or high'],
    [c.ragTopK < 1 || c.ragTopK > 20 || c.ragChunkTokens < 100 || c.ragChunkTokens > 480 || c.ragChunkOverlap < 0 || c.ragChunkOverlap >= Math.trunc(c.ragChunkTokens / 2) || c.ragMaxUploadMB < 1,
      'invalid RAG configuration (RAG_TOP_K 1-20, RAG_CHUNK_TOKENS 100-480, RAG_CHUNK_OVERLAP below half the chunk size)'],
    [c.webSearchMaxResults < 1 || c.webSearchMaxResults > 10 || c.toolMaxCalls < 1 || c.toolMaxCalls > 5, 'WEB_SEARCH_MAX_RESULTS must be 1-10 and TOOL_MAX_CALLS_PER_TURN 1-5'],
    [c.deviceFrameMS < 10 || c.deviceFrameMS > 100 || c.deviceFrameMS % 10 !== 0 || c.deviceLeadMS < c.deviceFrameMS || c.deviceLeadMS > 2000 || c.deviceMaxConnections < 1,
      'DEVICE_FRAME_MS must be 10-100 in steps of 10, DEVICE_PLAYBACK_LEAD_MS frame-2000, DEVICE_MAX_CONNECTIONS ≥ 1'],
    [c.webSearchProvider !== 'tavily' && c.webSearchProvider !== 'none', 'WEB_SEARCH_PROVIDER must be tavily or none'],
  ]
  for (const [bad, message] of more) if (bad) fail(message)
  return Object.freeze(withDefaults(c))
}

// withDefaults adds the derived helpers the rest of the code uses.
function withDefaults(c) {
  return {
    ...c,
    production: c.appEnv === 'production' || c.nodeEnv.toLowerCase() === 'production',
    professorToolsEnabled: c.timetableEnabled || c.remindersEnabled || c.notesEnabled || c.voiceMemosEnabled || c.emailDraftsEnabled,
    audioDebugAllowed: c.audioDebug || c.devTools,
  }
}

// testConfig returns a configuration with the given overrides and zero values
// elsewhere, like a Go config.Config literal in a test.
export function testConfig(overrides = {}) {
  const base = {
    addr: '127.0.0.1:0', whisperModel: '', whisperMultilingualModel: '', geminiModel: 'test', thinkingLevel: 'minimal',
    maxRecordingSeconds: 0, historyTurns: 0, maxOutputTokens: 0, whisperMaxQueue: 0, sttTimeout: 0, llmTimeout: 0, ttsTimeout: 0,
    audioDebug: false, devTools: false, fixturesDir: '', reportDir: '',
    ragEnabled: false, ragHybrid: false, ragSendContext: false, ragStoragePath: '', ragEmbeddingModel: '', ragTopK: 0, ragChunkTokens: 0,
    ragChunkOverlap: 0, ragMaxUploadMB: 0, ragRRFK: 0, ragMinSimilarity: 0, webSearchProvider: 'none', tavilyKey: '', webSearchMaxResults: 0,
    toolMaxCalls: 0, defaultMode: '', allowedOrigins: [],
    deviceAddr: '', deviceTLSDir: '', deviceRegistry: '', deviceDebugAudioDir: '', deviceFrameMS: 0, deviceLeadMS: 0, deviceMaxConnections: 0,
    deviceHeartbeat: 0, deviceWriteTimeout: 0, deviceHelloTimeout: 0, deviceUtteranceTimeout: 0, deviceEcho: false, deviceAllowDocContext: false,
    professorTimezone: 'UTC', professorZone: 'UTC', professorDataPath: '', deviceProfessorTools: '', workdayStart: 0, workdayEnd: 0,
    timetableEnabled: false, remindersEnabled: false, notesEnabled: false, voiceMemosEnabled: false, emailDraftsEnabled: false,
    notesToGemini: false, reminderMacNotifications: false, deviceAllowNoteContext: false, actionConfirmationTimeout: 0,
    memoMaxSeconds: 0, memoMaxStorageMB: 0, professorOutputTokens: 0, professorToolMaxCalls: 0, professorToolRouting: false,
    appEnv: 'development', nodeEnv: '', googleCalendarEnabled: false, gmailDraftsEnabled: false, googleClientID: '', googleClientSecret: '',
    googleTokenPath: '', googleRedirectURL: '',
  }
  return withDefaults({...base, ...overrides})
}
