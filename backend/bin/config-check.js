#!/usr/bin/env node
// config-check audits .env without changing it and without printing any
// secret: for every variable the application reads it reports whether it is
// set, empty, missing (default used) or invalid, which feature needs it, and
// whether referenced models, voices, certificates and tools exist.
//
//   node bin/config-check.js            # table for .env in the current directory
//   node bin/config-check.js -env path  # another file
//
// Exit status 1 means something required is missing or invalid.
import fs from 'node:fs'
import path from 'node:path'
import {parseFlags} from '../src/utils/flags.js'
import {atoi, parseBool, parseDuration, parseFloat64} from '../src/utils/goparse.js'
import {validZone} from '../src/utils/time.js'
import {load, splitHostPort} from '../src/config/env.js'
import {tooOpen} from '../src/security/permissions.js'

// parseDotEnv reads KEY=VALUE lines (comments, blank lines, "export "
// prefixes and surrounding quotes are handled) and returns values and key order.
export function parseDotEnv(file) {
  const env = {}
  const order = []
  for (let line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    line = line.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice(7)
    const i = line.indexOf('=')
    if (i < 0) continue
    const k = line.slice(0, i).trim()
    let v = line.slice(i + 1).trim()
    const c = v.indexOf(' #')
    if (c >= 0 && !v.startsWith('"') && !v.startsWith("'")) v = v.slice(0, c).trim()
    v = v.replace(/^["']+|["']+$/g, '')
    if (!Object.hasOwn(env, k)) order.push(k)
    env[k] = v
  }
  return {env, order}
}

const get = (env, name, def) => (env[name] ? env[name] : def)
const isTrue = (name, def) => env => parseBool(get(env, name, def)) === true
const notEmpty = (name, def) => env => get(env, name, def) !== ''
const anyTrue = (...names) => env => names.some(n => isTrue(n, 'false')(env))
const always = () => true
const exists = p => (fs.existsSync(p) ? '' : 'file not found: ' + p)

const K = {string: 0, int: 1, bool: 2, duration: 3, float: 4, url: 5, secret: 6, timezone: 7, enum: 8}

const catalogue = [
  // Core assistant
  {name: 'GEMINI_API_KEY', group: 'Core', feature: 'Answers (Gemini)', kind: K.secret, required: always},
  {name: 'GEMINI_MODEL', group: 'Core', feature: 'Answers (Gemini)', def: 'gemini-3.5-flash-lite'},
  {name: 'GEMINI_THINKING_LEVEL', group: 'Core', feature: 'Answers (Gemini)', def: 'minimal', kind: K.enum, values: ['minimal', 'low', 'medium', 'high']},
  {name: 'GEMINI_MAX_OUTPUT_TOKENS', group: 'Core', feature: 'Answer length', def: '220', kind: K.int},
  {name: 'VOICE_ADDR', group: 'Core', feature: 'Web page and API address', def: '127.0.0.1:8090'},
  {name: 'VOICE_ALLOWED_ORIGINS', group: 'Core', feature: 'Browser origin allow-list', def: '(this server only)'},
  {name: 'VOICE_HISTORY_TURNS', group: 'Core', feature: 'Conversation memory', def: '8', kind: K.int},
  {name: 'VOICE_MAX_RECORDING_SECONDS', group: 'Core', feature: 'Longest question', def: '30', kind: K.int},
  {name: 'VOICE_STT_TIMEOUT', group: 'Core', feature: 'Timeouts', def: '60s', kind: K.duration},
  {name: 'VOICE_LLM_TIMEOUT', group: 'Core', feature: 'Timeouts', def: '30s', kind: K.duration},
  {name: 'VOICE_TTS_TIMEOUT', group: 'Core', feature: 'Timeouts', def: '30s', kind: K.duration},
  {name: 'VOICE_DEFAULT_MODE', group: 'Core', feature: 'Default answer source', def: 'auto', kind: K.enum, values: ['auto', 'general', 'documents', 'web']},
  {name: 'TOOL_MAX_CALLS_PER_TURN', group: 'Core', feature: 'Search tool calls per question', def: '2', kind: K.int},
  {name: 'LOG_LEVEL', group: 'Core', feature: 'Log verbosity (Node backend)', def: 'info', kind: K.enum, values: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']},
  // Speech
  {name: 'WHISPER_URL', group: 'Speech', feature: 'Speech recognition (English)', def: 'http://127.0.0.1:8081', kind: K.url},
  {name: 'WHISPER_MODEL', group: 'Speech', feature: 'Speech recognition (English)', def: 'models/whisper/ggml-small.bin', path: v => exists(v)},
  {name: 'WHISPER_MULTILINGUAL_URL', group: 'Speech', feature: 'Speech recognition (Hindi/Hinglish/Auto)', def: 'http://127.0.0.1:8082', kind: K.url},
  {name: 'WHISPER_MULTILINGUAL_MODEL', group: 'Speech', feature: 'Speech recognition (Hindi/Hinglish/Auto)', def: 'models/whisper/ggml-large-v3-turbo-q5_0.bin',
    path: (v, env) => (Object.hasOwn(env, 'WHISPER_MULTILINGUAL_URL') && env.WHISPER_MULTILINGUAL_URL === '' ? '' : exists(v))},
  {name: 'WHISPER_OPTIONS', group: 'Speech', feature: 'Whisper decoding options', def: '(measured defaults)'},
  {name: 'WHISPER_MAX_QUEUE', group: 'Speech', feature: 'Waiting requests per Whisper server', def: '4', kind: K.int},
  {name: 'WHISPER_RESIDENCY_KEEP_ALIVE_S', group: 'Speech', feature: 'Keep Whisper fast after idle (start-local.sh)', def: '3600', kind: K.int},
  {name: 'PIPER_EN_URL', group: 'Speech', feature: 'Speech synthesis (English)', def: 'http://127.0.0.1:5000', kind: K.url},
  {name: 'PIPER_HI_URL', group: 'Speech', feature: 'Speech synthesis (Hindi)', def: 'http://127.0.0.1:5001', kind: K.url},
  {name: 'PIPER_EN_VOICE', group: 'Speech', feature: 'English voice', def: 'en_US-lessac-medium', path: v => exists(path.join('models/piper', v + '.onnx'))},
  {name: 'PIPER_HI_VOICE', group: 'Speech', feature: 'Hindi voice', def: 'hi_IN-priyamvada-medium', path: v => exists(path.join('models/piper', v + '.onnx'))},
  // Phase 4
  {name: 'RAG_ENABLED', group: 'Phase 4', feature: 'Document search', def: 'true', kind: K.bool},
  {name: 'RAG_STORAGE_PATH', group: 'Phase 4', feature: 'Document files and index', def: './data/rag'},
  {name: 'RAG_SIDECAR_URL', group: 'Phase 4', feature: 'Embeddings and PDF text (local)', def: 'http://127.0.0.1:8084', kind: K.url},
  {name: 'RAG_EMBEDDING_MODEL', group: 'Phase 4', feature: 'Embedding model name', def: 'intfloat/multilingual-e5-small'},
  {name: 'RAG_EMBEDDING_MODEL_DIR', group: 'Phase 4', feature: 'Embedding model files', def: 'models/embeddings/multilingual-e5-small',
    path: (v, env) => (isTrue('RAG_ENABLED', 'true')(env) ? exists(path.join(v, 'model.onnx')) : '')},
  {name: 'RAG_SEND_CONTEXT_TO_GEMINI', group: 'Phase 4', feature: 'Privacy: master switch for "Let Gemini read my documents" (false = never sent)', def: 'true', kind: K.bool},
  {name: 'RAG_HYBRID_SEARCH', group: 'Phase 4', feature: 'Keyword + semantic search', def: 'true', kind: K.bool},
  {name: 'RAG_TOP_K', group: 'Phase 4', feature: 'Passages per search', def: '5', kind: K.int},
  {name: 'RAG_CHUNK_TOKENS', group: 'Phase 4', feature: 'Indexing', def: '350', kind: K.int},
  {name: 'RAG_CHUNK_OVERLAP', group: 'Phase 4', feature: 'Indexing', def: '50', kind: K.int},
  {name: 'RAG_MAX_UPLOAD_MB', group: 'Phase 4', feature: 'Upload limit', def: '25', kind: K.int},
  {name: 'RAG_MIN_SIMILARITY', group: 'Phase 4', feature: 'Search relevance threshold', def: '0.78', kind: K.float},
  {name: 'RAG_RRF_K', group: 'Phase 4', feature: 'Search ranking', def: '10', kind: K.int},
  {name: 'WEB_SEARCH_PROVIDER', group: 'Phase 4', feature: 'Web search', def: 'tavily', kind: K.enum, values: ['tavily', 'none']},
  {name: 'TAVILY_API_KEY', group: 'Phase 4', feature: 'Web search (optional)', kind: K.secret},
  {name: 'TAVILY_BASE_URL', group: 'Phase 4', feature: 'Web search endpoint (tests only)', def: 'https://api.tavily.com', kind: K.url},
  {name: 'WEB_SEARCH_MAX_RESULTS', group: 'Phase 4', feature: 'Web search', def: '5', kind: K.int},
  {name: 'WEB_SEARCH_TIMEOUT', group: 'Phase 4', feature: 'Web search', def: '8s', kind: K.duration},
  {name: 'WEB_SEARCH_CACHE_TTL', group: 'Phase 4', feature: 'Web search', def: '15m', kind: K.duration},
  // Phase 5
  {name: 'PROFESSOR_TIMEZONE', group: 'Phase 5', feature: 'Timetable and reminders time zone', def: 'Asia/Kolkata', kind: K.timezone},
  {name: 'PROFESSOR_DATA_PATH', group: 'Phase 5', feature: 'Timetable, reminders, notes, memos, drafts (SQLite)', def: './data/professor'},
  {name: 'PROFESSOR_WORKDAY', group: 'Phase 5', feature: 'Free-time answers', def: '09:00-17:00'},
  {name: 'TIMETABLE_ENABLED', group: 'Phase 5', feature: 'Timetable', def: 'true', kind: K.bool},
  {name: 'REMINDERS_ENABLED', group: 'Phase 5', feature: 'Reminders', def: 'true', kind: K.bool},
  {name: 'NOTES_ENABLED', group: 'Phase 5', feature: 'Notes', def: 'true', kind: K.bool},
  {name: 'VOICE_MEMOS_ENABLED', group: 'Phase 5', feature: 'Voice memos', def: 'true', kind: K.bool},
  {name: 'EMAIL_DRAFTS_ENABLED', group: 'Phase 5', feature: 'Email/announcement drafts', def: 'true', kind: K.bool},
  {name: 'ACTION_CONFIRMATION_TIMEOUT_SECONDS', group: 'Phase 5', feature: 'Confirmation questions', def: '60', kind: K.int},
  {name: 'NOTES_SEND_TO_GEMINI', group: 'Phase 5', feature: 'Privacy: note text to Gemini (with consent)', def: 'false', kind: K.bool},
  {name: 'PROFESSOR_TOOL_MAX_CALLS', group: 'Phase 5', feature: 'Tool calls per professor request', def: '4', kind: K.int},
  {name: 'PROFESSOR_TOOL_ROUTING', group: 'Phase 5', feature: 'Faster answers (tool selection)', def: 'true', kind: K.bool},
  {name: 'PROFESSOR_TOOL_OUTPUT_TOKENS', group: 'Phase 5', feature: 'Draft length', def: '1024', kind: K.int},
  {name: 'VOICE_MEMO_MAX_SECONDS', group: 'Phase 5', feature: 'Voice memos', def: '120', kind: K.int},
  {name: 'VOICE_MEMO_MAX_STORAGE_MB', group: 'Phase 5', feature: 'Voice memos', def: '200', kind: K.int},
  {name: 'REMINDER_MACOS_NOTIFICATIONS', group: 'Phase 5', feature: 'macOS notifications', def: 'false', kind: K.bool},
  // Google (optional)
  {name: 'GOOGLE_CALENDAR_ENABLED', group: 'Google', feature: 'Google Calendar (read-only)', def: 'false', kind: K.bool},
  {name: 'GMAIL_DRAFTS_ENABLED', group: 'Google', feature: 'Gmail drafts', def: 'false', kind: K.bool},
  {name: 'GOOGLE_OAUTH_CLIENT_ID', group: 'Google', feature: 'Google sign-in', kind: K.secret, required: anyTrue('GOOGLE_CALENDAR_ENABLED', 'GMAIL_DRAFTS_ENABLED')},
  {name: 'GOOGLE_OAUTH_CLIENT_SECRET', group: 'Google', feature: 'Google sign-in (Desktop clients may omit it)', kind: K.secret},
  {name: 'GOOGLE_OAUTH_REDIRECT_URL', group: 'Google', feature: 'Google sign-in', def: 'http://<VOICE_ADDR>/api/google/callback', kind: K.url},
  {name: 'GOOGLE_TOKEN_PATH', group: 'Google', feature: 'Stored Google token', def: './data/google-token.json'},
  // ESP32 device gateway
  {name: 'DEVICE_ADDR', group: 'ESP32', feature: 'Device listener (empty = off)'},
  {name: 'DEVICE_TLS_DIR', group: 'ESP32', feature: 'Device TLS certificates', def: 'data/device-tls', required: notEmpty('DEVICE_ADDR', ''),
    path: (v, env) => {
      if (get(env, 'DEVICE_ADDR', '') === '') return ''
      for (const f of ['ca.crt', 'server.crt', 'server.key']) {
        const p = exists(path.join(v, f))
        if (p) return p + ' (run devicectl init-ca and server-cert)'
      }
      try {
        if (tooOpen(fs.statSync(path.join(v, 'server.key')))) return 'server.key is readable by others (chmod 600)'
      } catch {}
      return ''
    }},
  {name: 'DEVICE_REGISTRY', group: 'ESP32', feature: 'Provisioned devices', def: 'data/devices.json', required: notEmpty('DEVICE_ADDR', ''),
    path: (v, env) => (get(env, 'DEVICE_ADDR', '') === '' ? '' : exists(v) ? exists(v) + ' (run devicectl add)' : '')},
  {name: 'DEVICE_FRAME_MS', group: 'ESP32', feature: 'Device audio', def: '20', kind: K.int},
  {name: 'DEVICE_PLAYBACK_LEAD_MS', group: 'ESP32', feature: 'Device audio', def: '200', kind: K.int},
  {name: 'DEVICE_MAX_CONNECTIONS', group: 'ESP32', feature: 'Device listener', def: '8', kind: K.int},
  {name: 'DEVICE_HEARTBEAT', group: 'ESP32', feature: 'Device listener', def: '15s', kind: K.duration},
  {name: 'DEVICE_WRITE_TIMEOUT', group: 'ESP32', feature: 'Device listener', def: '3s', kind: K.duration},
  {name: 'DEVICE_HELLO_TIMEOUT', group: 'ESP32', feature: 'Device listener', def: '5s', kind: K.duration},
  {name: 'DEVICE_UTTERANCE_TIMEOUT', group: 'ESP32', feature: 'Device listener', def: '(max recording + 5 s)', kind: K.duration},
  {name: 'DEVICE_ALLOW_DOC_CONTEXT', group: 'ESP32', feature: 'Privacy: desk-device document switch at startup (needs the master switch)', def: 'false', kind: K.bool},
  {name: 'DEVICE_ALLOW_NOTE_CONTEXT', group: 'ESP32', feature: 'Privacy: note text for devices', def: 'false', kind: K.bool},
  {name: 'DEVICE_PROFESSOR_TOOLS', group: 'ESP32', feature: 'What devices may do', def: 'all', kind: K.enum, values: ['all', 'read', 'none']},
  {name: 'DEVICE_ECHO', group: 'ESP32', feature: 'Device echo test (development)', def: 'false', kind: K.bool},
  {name: 'DEVICE_DEBUG_AUDIO_DIR', group: 'ESP32', feature: 'Save device audio (development)'},
  // Demo data
  {name: 'APP_ENV', group: 'Demo data', feature: 'Environment (seed/reset refuse production)', def: 'development', kind: K.enum, values: ['development', 'production']},
  {name: 'DEMO_DATA_PATH', group: 'Demo data', feature: 'Separate SQLite demo databases', def: './data/demo'},
  {name: 'DEMO_ADDR', group: 'Demo data', feature: 'Demo instance address (start-demo.sh)', def: '127.0.0.1:8091'},
  // Debugging and tests
  {name: 'VOICE_AUDIO_DEBUG', group: 'Debug/test', feature: 'Audio debug panel', def: 'false', kind: K.bool},
  {name: 'VOICE_DEV_TOOLS', group: 'Debug/test', feature: 'STT evaluation dashboard (/dev/)', def: 'false', kind: K.bool},
  {name: 'VOICE_FIXTURES_DIR', group: 'Debug/test', feature: 'Evaluation fixtures', def: 'runtime/fixtures'},
  {name: 'VOICE_REPORT_DIR', group: 'Debug/test', feature: 'Evaluation reports', def: 'runtime/eval'},
  {name: 'VOICE_NETWORK_TESTS', group: 'Debug/test', feature: 'tests only (not read by the app)', kind: K.bool},
]

function validate(v, val) {
  switch (v.kind) {
    case K.int: return atoi(val) === null ? 'not a whole number' : ''
    case K.bool: return parseBool(val) === null ? 'must be true or false' : ''
    case K.duration: return parseDuration(val) === null ? 'not a duration such as 30s' : ''
    case K.float: return parseFloat64(val) === null ? 'not a number' : ''
    case K.timezone: return validZone(val) ? '' : 'unknown time zone'
    case K.enum: return v.values.includes(val) ? '' : 'must be one of ' + v.values.join(', ')
    case K.url: {
      let u
      try {
        u = new URL(val)
      } catch {
        return 'not a URL'
      }
      if (u.host === '') return 'not a URL'
      if (v.name.startsWith('PIPER') && u.hostname === 'localhost') return 'use 127.0.0.1, not localhost (AirPlay also listens on port 5000)'
      return ''
    }
  }
  return ''
}

function main() {
  const {values: flags} = parseFlags(process.argv.slice(2), {env: {type: 'string', default: '.env', usage: 'env file to audit (never modified)'}}, 'config-check')
  let parsed
  try {
    parsed = parseDotEnv(flags.env)
  } catch (e) {
    process.stdout.write(`Cannot read ${flags.env}: ${e.message}\nCreate it with: cp .env.example .env, then add GEMINI_API_KEY.\n`)
    process.exit(1)
  }
  const {env, order} = parsed
  const known = new Set()
  let problems = 0
  let out = '| Environment variable | Status | Required? | Feature | Action needed |\n|---|---|---|---|---|\n'
  for (const v of catalogue) {
    known.add(v.name)
    const present = Object.hasOwn(env, v.name)
    const val = env[v.name]
    let required = v.required ? v.required(env) : false
    let req = required ? 'Required' : v.required ? 'Only if enabled' : 'Optional'
    if (v.group === 'Debug/test') req = 'Optional (debug/test)'
    let status
    let action
    if (!present && required) [status, action] = ['Missing', 'Add it to .env']
    else if (present && val === '' && required) [status, action] = ['Empty', 'Set a value in .env']
    else if (v.kind === K.secret && present && val !== '') [status, action] = ['Configured', 'None']
    else if (v.kind === K.secret) {
      ;[status, action] = [present ? 'Empty' : 'Missing', 'None (optional)']
      if (v.name === 'TAVILY_API_KEY') action = 'Optional: add a Tavily key to enable web search'
      if (v.name.startsWith('GOOGLE_')) [status, action] = ['Not required (Google integration disabled)', 'None']
    } else if (!present) [status, action] = [`Not set — default ${v.def || '(none)'}`, 'None']
    else if (val === '') {
      ;[status, action] = ['Empty (feature off)', 'None']
      if (v.def && v.name !== 'WHISPER_MULTILINGUAL_URL') status = `Empty — default ${v.def}`
    } else {
      const p = validate(v, val)
      ;[status, action] = p ? ['Invalid: ' + p, 'Fix the value in .env'] : ['Configured', 'None']
    }
    const effective = get(env, v.name, v.def ?? '')
    if (v.path && !status.startsWith('Invalid')) {
      const p = v.path(effective, env)
      if (p) {
        ;[status, action] = ['Path problem: ' + p, 'Run ./scripts/setup-local.sh or fix the path']
        required = true
      }
    }
    if (status.startsWith('Invalid') || status.startsWith('Path problem') || ((status === 'Missing' || status === 'Empty') && required)) problems++
    out += `| \`${v.name}\` | ${status} | ${req} | ${v.group}: ${v.feature} | ${action} |\n`
  }
  process.stdout.write(out)
  const unknown = order.filter(k => !known.has(k)).sort()
  if (unknown.length) process.stdout.write(`\nUnknown keys in ${flags.env} (not read by the application; check for typos): ${unknown.join(', ')}\n`)
  process.stdout.write('\nLocal services and tools:\n')
  for (const p of [
    {name: 'whisper-server binary', path: 'runtime/whisper.cpp/build/bin/whisper-server', fix: './scripts/setup-local.sh'},
    {name: 'Piper (Python venv)', path: 'runtime/piper-venv/bin/python', fix: './scripts/setup-local.sh'},
    {name: 'RAG sidecar (Python venv)', path: 'runtime/rag-venv/bin/python', fix: 'RAG_PYTHON=/path/to/python3.10+ ./scripts/setup-local.sh'},
    {name: 'Node.js backend dependencies', path: 'backend/node_modules', fix: 'npm ci --prefix backend'},
  ]) {
    let state = 'found'
    if (exists(p.path)) {
      state = 'MISSING — ' + p.fix
      problems++
    }
    process.stdout.write(`  ${p.name.padEnd(28)} ${state}\n`)
  }
  // Ports must not collide.
  const defaults = {VOICE_ADDR: '127.0.0.1:8090', WHISPER_URL: 'http://127.0.0.1:8081', PIPER_EN_URL: 'http://127.0.0.1:5000', PIPER_HI_URL: 'http://127.0.0.1:5001', RAG_SIDECAR_URL: 'http://127.0.0.1:8084'}
  const ports = {}
  for (const n of ['VOICE_ADDR', 'WHISPER_URL', 'WHISPER_MULTILINGUAL_URL', 'PIPER_EN_URL', 'PIPER_HI_URL', 'RAG_SIDECAR_URL', 'DEVICE_ADDR']) {
    let v = get(env, n, defaults[n] ?? '')
    if (n === 'WHISPER_MULTILINGUAL_URL') v = Object.hasOwn(env, n) ? env[n] : 'http://127.0.0.1:8082'
    if (v === '') continue
    let host = v
    try {
      const u = new URL(v)
      if (u.host) host = u.host
    } catch {}
    const hp = splitHostPort(host)
    if (hp) (ports[hp.port] ??= []).push(n)
  }
  for (const [port, names] of Object.entries(ports)) {
    if (names.length > 1) {
      process.stdout.write(`  Port ${port} is used by ${names.join(' and ')} — each service needs its own port\n`)
      problems++
    }
  }
  // The application's own validation (ranges and combinations).
  try {
    load({...process.env, ...env})
    process.stdout.write('\nApplication configuration check: passed (all values within the ranges the assistant accepts)\n')
  } catch (e) {
    process.stdout.write(`\nApplication configuration check: FAILED — ${e.message}\n`)
    problems++
  }
  if (problems > 0) {
    process.stdout.write(`${problems} problem(s) need attention.\n`)
    process.exit(1)
  }
  process.stdout.write('No problems found. Secret values were not printed.\n')
}

main()
