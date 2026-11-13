// Database compatibility: the Node backend opens databases created by the Go
// backend unchanged. Uses COPIES of the real data/ databases when present
// (the originals are never opened), and a Go-schema fixture otherwise.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import Database from 'better-sqlite3'
import {Context} from '../../src/utils/context.js'
import {ProfessorService} from '../../src/modules/professor/service.js'
import {migrations} from '../../src/database/migrations/professor.js'
import {schema as ragSchema} from '../../src/services/rag/store.js'
import {Service as RAGService} from '../../src/services/rag/service.js'
import {ChunkerVersion} from '../../src/services/rag/chunk.js'
import {HashEmbedder} from '../helpers/fakes.js'
import {tmpDir} from '../helpers/env.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const realProf = path.join(root, 'data', 'professor', 'professor.db')
const realRag = path.join(root, 'data', 'rag', 'index.db')

// copyDB copies a SQLite database consistently (online backup, read-only source).
async function copyDB(src, dst) {
  const db = new Database(src, {readonly: true, fileMustExist: true})
  try {
    await db.backup(dst)
  } finally {
    db.close()
  }
}

const schemaOf = file => {
  const db = new Database(file, {readonly: true})
  try {
    return {version: db.pragma('user_version', {simple: true}), sql: db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()}
  } finally {
    db.close()
  }
}

test('the Node professor schema is byte-identical to the Go migration', () => {
  const dir = tmpDir()
  const s = ProfessorService.open({dir, zoneName: 'Asia/Kolkata'})
  s.close()
  const go = new Database(':memory:')
  go.exec(migrations[0])
  const want = go.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
  const got = schemaOf(path.join(dir, 'professor.db'))
  assert.equal(got.version, 1)
  assert.deepEqual(got.sql, want)
})

test('real professor.db (copy): read, write and read back without migration', {skip: !fs.existsSync(realProf) && 'no data/professor/professor.db'}, async () => {
  const dir = tmpDir()
  await copyDB(realProf, path.join(dir, 'professor.db'))
  const before = schemaOf(path.join(dir, 'professor.db'))
  const raw = new Database(path.join(dir, 'professor.db'), {readonly: true})
  const rawCounts = Object.fromEntries(['classes', 'reminders', 'notes', 'memos', 'drafts'].map(t => [t, raw.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]))
  const rawClass = raw.prepare('SELECT * FROM classes ORDER BY weekday, start_min, subject LIMIT 1').get()
  raw.close()
  const s = ProfessorService.open({dir, zoneName: 'Asia/Kolkata'})
  assert.deepEqual(s.counts(), rawCounts)
  const classes = s.classes()
  assert.equal(classes.length, rawCounts.classes)
  if (rawClass) {
    assert.equal(classes[0].id, rawClass.id)
    assert.equal(classes[0].start, `${String(Math.trunc(rawClass.start_min / 60)).padStart(2, '0')}:${String(rawClass.start_min % 60).padStart(2, '0')}`)
  }
  for (const d of s.drafts('', 500)) JSON.stringify(d) // every stored draft parses (recipients JSON)
  const n = s.createNote({title: 'migration check', body: 'written by the Node backend'}, 'typed', '')
  const r = s.createReminder({title: 'migration check', due: s.now().plus({days: 1}).toFormat("yyyy-MM-dd'T'HH:mm")}, '')
  s.close()
  const s2 = ProfessorService.open({dir, zoneName: 'Asia/Kolkata'})
  assert.equal(s2.note(n.id).body, 'written by the Node backend')
  assert.equal(s2.reminder(r.id).title, 'migration check')
  assert.equal(s2.counts().classes, rawCounts.classes)
  s2.close()
  assert.deepEqual(schemaOf(path.join(dir, 'professor.db')), before, 'schema and user_version unchanged')
})

test('the Node RAG schema matches the Go DDL', () => {
  const dir = tmpDir()
  const svc = new RAGService({dir, maxUploadBytes: 1 << 20, chunkTokens: 350, chunkOverlap: 50, topK: 5, hybrid: true, minSimilarity: 0.78}, new HashEmbedder(), null, null)
  svc.close()
  const go = new Database(':memory:')
  go.exec(ragSchema.replace('PRAGMA journal_mode = WAL;', ''))
  const want = go.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
  assert.deepEqual(schemaOf(path.join(dir, 'index.db')).sql, want)
})

test('real index.db (copy): documents, FTS5, float32 vectors and hybrid search work; nothing re-indexed', {skip: !fs.existsSync(realRag) && 'no data/rag/index.db'}, async t => {
  const dir = tmpDir()
  await copyDB(realRag, path.join(dir, 'index.db'))
  fs.mkdirSync(path.join(dir, 'files'))
  const raw = new Database(path.join(dir, 'index.db'), {readonly: true})
  const docs = raw.prepare('SELECT id, status, index_version FROM documents').all()
  const chunks = raw.prepare('SELECT count(*) AS n FROM chunks').get().n
  const dims = raw.prepare('SELECT length(embedding) AS b FROM chunks WHERE embedding IS NOT NULL LIMIT 1').get()?.b
  const sample = raw.prepare('SELECT text FROM chunks LIMIT 1').get()?.text ?? ''
  raw.close()
  // An embedder with the production model name and dimension: the stored
  // index versions must still match, so nothing is queued for re-indexing.
  const model = docs[0]?.index_version.split('/').slice(1, -1).join('/') || 'intfloat/multilingual-e5-small'
  const emb = {model: () => model, embed: async (_c, texts) => texts.map(() => new Float32Array((dims ?? 1536) / 4).fill(0.01))}
  const svc = new RAGService({dir, maxUploadBytes: 25 << 20, chunkTokens: 350, chunkOverlap: 50, topK: 5, hybrid: true, minSimilarity: 0}, emb, null, null)
  t.after(() => svc.close())
  assert.equal(svc.store.countChunks('').chunks, chunks)
  assert.equal(svc.store.vectors.size, chunks, 'every stored embedding decodes')
  for (const d of docs.filter(x => x.status === 'ready')) assert.equal(d.index_version, svc.indexVersion(), 'chunker/model/settings unchanged: no re-index')
  assert.ok(svc.indexVersion().startsWith(ChunkerVersion + '/'))
  const word = sample.split(/\s+/).find(w => w.length > 5) ?? 'unit'
  const res = await svc.search(Context.background(), word, '', 5)
  assert.ok(res.hits?.length > 0, `keyword+vector search finds "${word}"`)
  assert.equal(res.method, 'hybrid')
})
