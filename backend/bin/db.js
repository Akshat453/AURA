#!/usr/bin/env node
// db checks, seeds and resets the assistant's SQLite databases.
//
//   node bin/db.js check                 # health of the app and demo databases (read-only)
//   node bin/db.js seed                  # demo data into the demo databases (idempotent)
//   node bin/db.js counts                # rows per table, demo vs. professor-created
//   node bin/db.js reset                 # dev only: back up, recreate and seed the demo databases
//   node bin/db.js seed --target app     # demo rows into the real app database (only rows with seed ids)
//   node bin/db.js unseed --target app   # remove those demo rows again
//
// The demo databases live in DEMO_DATA_PATH (default ./data/demo), so the
// professor's own data in PROFESSOR_DATA_PATH and RAG_STORAGE_PATH is never
// touched by default. Seed and reset refuse to run when APP_ENV (or NODE_ENV)
// is production unless --force is given. Output never contains secrets.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import Database from 'better-sqlite3'
import {parseFlags} from '../src/utils/flags.js'
import {load, loadDotEnv} from '../src/config/env.js'
import {ProfessorService, Tables} from '../src/modules/professor/service.js'
import {Service as RAGService} from '../src/services/rag/service.js'
import {stamp} from '../src/utils/time.js'
import {DateTime} from 'luxon'

const demoDocs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'demo-docs')
const ragTables = ['documents', 'chunks', 'chunks_fts', 'embedding_cache']

const fail = msg => {
  process.stderr.write(`ERROR: ${msg}\n`)
  process.exit(1)
}

function usage() {
  process.stderr.write('usage: node bin/db.js check|counts|seed|unseed|reset [--target demo|app] [--force]\n')
  process.exit(2)
}

function targets(cfg) {
  const demo = process.env.DEMO_DATA_PATH || './data/demo'
  const mk = (name, professorDir, ragDir) => ({name, professorDir, ragDir, professorDB: path.join(professorDir, 'professor.db'), ragIndex: path.join(ragDir, 'index.db')})
  return {app: mk('app', cfg.professorDataPath, cfg.ragStoragePath), demo: mk('demo', path.join(demo, 'professor'), path.join(demo, 'rag'))}
}

const open = (cfg, t) => {
  try {
    return ProfessorService.open({dir: t.professorDir, zoneName: cfg.professorTimezone})
  } catch (e) {
    return fail(`open the ${t.name} professor database: ${e.message}`)
  }
}

// health opens a database read-only, runs SELECT 1, checks the expected
// tables, integrity and foreign keys.
function health(file, tables) {
  let db
  try {
    db = new Database(file, {readonly: true, fileMustExist: true})
  } catch {
    throw new Error('cannot open')
  }
  try {
    db.pragma('busy_timeout = 5000')
    if (db.prepare('SELECT 1 AS one').get().one !== 1) throw new Error('SELECT 1 failed')
    for (const name of tables) {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)) throw new Error(`table ${name} is missing`)
    }
    const integrity = db.pragma('integrity_check', {simple: true})
    if (integrity !== 'ok') throw new Error(`integrity check failed: ${integrity}`)
    if (db.pragma('foreign_key_check').length > 0) throw new Error('foreign key check reported violations')
  } finally {
    db.close()
  }
}

function check(t, required) {
  let ok = true
  for (const d of [{label: 'professor database', file: t.professorDB, tables: Tables}, {label: 'document index', file: t.ragIndex, tables: ragTables}]) {
    const label = `${t.name} ${d.label}`
    if (!fs.existsSync(d.file)) {
      if (required) {
        process.stdout.write(`${label.padEnd(28)} ERROR: file not found (it is created when the app first starts)\n`)
        ok = false
      } else process.stdout.write(`${label.padEnd(28)} not created yet (run: node backend/bin/db.js seed)\n`)
      continue
    }
    try {
      health(d.file, d.tables)
      process.stdout.write(`${label.padEnd(28)} OK\n`)
    } catch (e) {
      process.stdout.write(`${label.padEnd(28)} ERROR: ${e.message}\n`)
      ok = false
    }
  }
  return ok
}

async function seed(cfg, t) {
  const s = open(cfg, t)
  let sum
  try {
    sum = s.seed()
  } catch (e) {
    fail(`seed: ${e.message}`)
  } finally {
    s.close()
  }
  process.stdout.write(`Seeded the ${t.name} professor database:` + Tables.map(tb => ` ${tb} ${sum[tb]}`).join('') + '\n')
  if (t.name !== 'demo') {
    process.stdout.write("Demo documents are added only to the demo document index, never to the app's.\n")
    return
  }
  // Demo documents go through the real upload path; identical content is
  // detected by hash, so re-running adds nothing. The demo app indexes them.
  let docs
  try {
    docs = new RAGService({dir: t.ragDir, maxUploadBytes: cfg.ragMaxUploadMB * 2 ** 20, chunkTokens: cfg.ragChunkTokens, chunkOverlap: cfg.ragChunkOverlap,
      topK: cfg.ragTopK, hybrid: cfg.ragHybrid, minSimilarity: cfg.ragMinSimilarity, rrfK: cfg.ragRRFK}, {model: () => cfg.ragEmbeddingModel, embed: async () => []}, null, null)
  } catch (e) {
    fail(`open the demo document index: ${e.message}`)
  }
  let added = 0
  let existing = 0
  try {
    for (const name of fs.readdirSync(demoDocs).sort()) {
      const res = await docs.upload(null, name, fs.readFileSync(path.join(demoDocs, name)))
      if (res.duplicate) existing++
      else added++
    }
  } catch (e) {
    fail(`upload: ${e.message}`)
  } finally {
    docs.close()
  }
  process.stdout.write(`Demo documents: ${added} added, ${existing} already present (indexed when the demo app starts).\n`)
}

function counts(cfg, t) {
  const s = open(cfg, t)
  const {demo, other} = s.demoCounts()
  s.close()
  process.stdout.write(`${'table'.padEnd(16)} ${'demo'.padStart(6)} ${'professor'.padStart(10)}\n`)
  for (const table of Tables) process.stdout.write(`${table.padEnd(16)} ${String(demo[table]).padStart(6)} ${String(other[table]).padStart(10)}\n`)
  if (!fs.existsSync(t.ragIndex)) return
  const db = new Database(t.ragIndex, {readonly: true})
  try {
    for (const table of ['documents', 'chunks', 'embedding_cache']) {
      process.stdout.write(`${table.padEnd(16)} ${String(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).padStart(6)} ${'-'.padStart(10)}\n`)
    }
    const status = db.prepare('SELECT status, COUNT(*) AS n FROM documents GROUP BY status').all().map(r => `${r.status} ${r.n}`).sort()
    if (status.length) process.stdout.write(`documents by status: ${status.join(', ')}\n`)
  } finally {
    db.close()
  }
}

function pidRunning(pidFile) {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
    if (!(pid > 0)) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// reset moves the current demo databases into a timestamped backup folder
// (nothing is deleted) so seed recreates them from scratch.
function reset(t) {
  const root = path.dirname(t.professorDir)
  if (pidRunning(path.join('runtime', 'run', 'demo.pid'))) fail('the demo app is running; stop it first with: ./scripts/start-demo.sh stop')
  const backup = path.join(root + '-backups', stamp(DateTime.local()))
  let moved = 0
  for (const dir of [t.professorDir, t.ragDir]) {
    if (!fs.existsSync(dir)) continue
    fs.mkdirSync(backup, {recursive: true, mode: 0o700})
    try {
      fs.renameSync(dir, path.join(backup, path.basename(dir)))
    } catch (e) {
      fail(`back up ${path.basename(dir)}: ${e.message}`)
    }
    moved++
  }
  process.stdout.write(moved > 0 ? `Backed up the previous demo databases to ${backup}\n` : 'No previous demo databases; creating new ones.\n')
}

async function main() {
  if (process.argv.length < 3) usage()
  const cmd = process.argv[2]
  const {values: f} = parseFlags(process.argv.slice(3), {
    target: {type: 'string', default: 'demo', usage: 'demo (DEMO_DATA_PATH) or app (PROFESSOR_DATA_PATH and RAG_STORAGE_PATH)'},
    force: {type: 'bool', default: false, usage: 'allow seed/reset when APP_ENV=production'},
    env: {type: 'string', default: '.env', usage: 'env file to read (values already in the environment win)'},
  }, 'db')
  try {
    loadDotEnv(f.env)
  } catch (e) {
    fail(`cannot read the env file: ${e.message}`)
  }
  let cfg
  try {
    cfg = load()
  } catch (e) {
    fail(`configuration: ${e.message}`)
  }
  const all = targets(cfg)
  const t = all[f.target]
  if (!t) fail('--target must be demo or app')
  const guard = () => {
    if (cfg.production && !f.force) fail('APP_ENV (or NODE_ENV) is production: refusing to write demo data. Pass --force only if you are sure.')
  }
  switch (cmd) {
    case 'check': {
      let failed = false
      for (const name of ['app', 'demo']) {
        if (f.target !== 'demo' && name !== f.target) continue // --target app checks only the app
        if (!check(all[name], name === 'app')) failed = true
      }
      if (failed) process.exit(1)
      return
    }
    case 'counts':
      return counts(cfg, t)
    case 'seed':
      guard()
      await seed(cfg, t)
      return counts(cfg, t)
    case 'unseed': {
      guard()
      const s = open(cfg, t)
      const n = s.removeDemo()
      s.close()
      process.stdout.write(`Removed ${n} demo rows from the ${t.name} database. Rows created by the professor were not touched.\n`)
      return
    }
    case 'reset':
      guard()
      if (t.name !== 'demo') fail('reset only recreates the demo databases (DEMO_DATA_PATH); it never deletes the app database')
      reset(t)
      await seed(cfg, t)
      return counts(cfg, t)
    default:
      usage()
  }
}

main()
