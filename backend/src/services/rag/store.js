// Document index: documents, chunks, an FTS5 keyword index and embeddings in
// one SQLite file (the same schema the Go backend created, so existing
// indexes open unchanged). Vector search is an exact cosine scan over an
// in-memory copy of the unit-length float32 embeddings.
import Database from 'better-sqlite3'
import {isDigit, isLetter, isMark, runes} from '../../utils/gotext.js'
import {fromUnix, rfc3339} from '../../utils/time.js'

export const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL UNIQUE, pages INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', index_version TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL DEFAULT 0, file TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, page INTEGER NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL,
  tokens INTEGER NOT NULL, hash TEXT NOT NULL, model TEXT NOT NULL, embedding BLOB
);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, heading, docname);
CREATE TABLE IF NOT EXISTS embedding_cache (
  model TEXT NOT NULL, hash TEXT NOT NULL, embedding BLOB NOT NULL, PRIMARY KEY (model, hash)
);`

export class NotFoundError extends Error {
  constructor(message = 'sql: no rows in result set') {
    super(message)
    this.name = 'NotFoundError'
  }
}

export function encodeVector(v) {
  const b = Buffer.alloc(v.length * 4)
  for (let i = 0; i < v.length; i++) b.writeFloatLE(v[i], i * 4)
  return b
}

export function decodeVector(b) {
  const n = Math.floor(b.length / 4)
  const v = new Float32Array(n)
  for (let i = 0; i < n; i++) v[i] = b.readFloatLE(i * 4)
  return v
}

// dot accumulates in float32, like the Go implementation.
export function dot(a, b) {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s = Math.fround(s + Math.fround(a[i] * b[i]))
  return s
}

// The Document JSON shape (created_at in the server's local zone, like Go's time.Unix).
export function documentJSON(d) {
  const out = {id: d.id, name: d.name, type: d.type, size: d.size, sha256: d.sha256, pages: d.pages, chunks: d.chunks, status: d.status}
  if (d.error) out.error = d.error
  if (d.index_version) out.index_version = d.index_version
  out.created_at = rfc3339(fromUnix(d.created_at))
  if (d.indexed_at > 0) out.indexed_at = rfc3339(fromUnix(d.indexed_at))
  return out
}

const documentColumns = 'id, name, type, size, sha256, pages, chunks, status, error, index_version, created_at, indexed_at, file'

// matchDoc applies a document filter: "" (all), a scope, or one document id.
export const NotePrefix = 'note-'
export const MemoPrefix = 'memo-'
export const ScopeNotes = '@notes' // notes and memos only
export const ScopeUploads = '@uploads' // uploaded documents only
export const isTextID = id => id.startsWith(NotePrefix) || id.startsWith(MemoPrefix)

export function matchDoc(filter, id) {
  if (filter === '') return true
  if (filter === ScopeNotes) return isTextID(id)
  if (filter === ScopeUploads) return !isTextID(id)
  return id === filter
}

// docFilterSQL returns the WHERE fragment for a document filter on c.doc_id.
function docFilterSQL(filter) {
  const text = "(c.doc_id LIKE 'note-%' OR c.doc_id LIKE 'memo-%')"
  if (filter === '') return ['', []]
  if (filter === ScopeNotes) return [' AND ' + text, []]
  if (filter === ScopeUploads) return [' AND NOT ' + text, []]
  return [' AND c.doc_id = ?', [filter]]
}

// keywordText prepares text for FTS5: letter/digit boundaries become word
// boundaries so "CS301", "CS-301" and "CS 301" all index as "cs 301".
export function keywordText(s) {
  let b = ''
  let prev = ''
  let first = true
  for (const r of s) {
    if (!first && ((isLetter(prev) && isDigit(r)) || (isDigit(prev) && isLetter(r)))) b += ' '
    b += r
    prev = r
    first = false
  }
  return b
}

const stopwords = new Set(`a an and are as at be by can do does for from how i in is it me my of on or please tell the this to was what when where which who why with you your about explain find give
		का की के को में है हैं और से पर क्या कैसे कौन यह वह मुझे बताओ बताइए समझाओ कि`.split(/\s+/).filter(Boolean))

// ftsQuery builds a safe FTS5 MATCH expression: each word becomes a quoted
// term (so user input can never inject FTS syntax) and terms are OR-ed.
export function ftsQuery(query) {
  const terms = []
  const seen = new Set()
  const words = []
  let cur = ''
  for (const r of keywordText(query).toLowerCase()) {
    if (isLetter(r) || isDigit(r) || isMark(r)) cur += r
    else if (cur !== '') {
      words.push(cur)
      cur = ''
    }
  }
  if (cur !== '') words.push(cur)
  for (const w of words) {
    const rs = runes(w)
    if (stopwords.has(w) || seen.has(w) || (rs.length < 2 && !isDigit(rs[0]))) continue
    seen.add(w)
    terms.push(`"${w}"`)
    if (terms.length === 24) break
  }
  return terms.join(' OR ')
}

export class Store {
  constructor(path) {
    this.db = new Database(path)
    this.db.pragma('busy_timeout = 5000')
    try {
      this.db.exec(schema)
    } catch (e) {
      this.db.close()
      throw new Error(`initialize ${path}: ${e.message}`, {cause: e})
    }
    this.vectors = new Map() // chunk rowid -> {docID, vec}
    for (const r of this.db.prepare('SELECT rowid, doc_id, embedding FROM chunks WHERE embedding IS NOT NULL').iterate()) {
      this.vectors.set(r.rowid, {docID: r.doc_id, vec: decodeVector(r.embedding)})
    }
    this.q = {
      insertDoc: this.db.prepare('INSERT INTO documents(id, name, type, size, sha256, status, created_at, file) VALUES (?,?,?,?,?,?,?,?)'),
      replaceContent: this.db.prepare("UPDATE documents SET size=?, sha256=?, file=?, status='queued', error='' WHERE id=?"),
      setStatus: this.db.prepare('UPDATE documents SET status=?, error=? WHERE id=?'),
      doc: this.db.prepare(`SELECT ${documentColumns} FROM documents WHERE id=?`),
      docBySha: this.db.prepare(`SELECT ${documentColumns} FROM documents WHERE sha256=? ORDER BY created_at LIMIT 1`),
      docByName: this.db.prepare(`SELECT ${documentColumns} FROM documents WHERE name=? ORDER BY created_at LIMIT 1`),
      docs: this.db.prepare(`SELECT ${documentColumns} FROM documents ORDER BY created_at DESC, name`),
      cached: this.db.prepare('SELECT embedding FROM embedding_cache WHERE model=? AND hash=?'),
      rowIDs: this.db.prepare('SELECT rowid FROM chunks WHERE doc_id=?'),
      delFTS: this.db.prepare('DELETE FROM chunks_fts WHERE rowid=?'),
      delChunks: this.db.prepare('DELETE FROM chunks WHERE doc_id=?'),
      delDoc: this.db.prepare('DELETE FROM documents WHERE id=?'),
      insChunk: this.db.prepare('INSERT INTO chunks(id, doc_id, seq, page, heading, text, tokens, hash, model, embedding) VALUES (?,?,?,?,?,?,?,?,?,?)'),
      insFTS: this.db.prepare('INSERT INTO chunks_fts(rowid, text, heading, docname) VALUES (?,?,?,?)'),
      insCache: this.db.prepare('INSERT OR IGNORE INTO embedding_cache(model, hash, embedding) VALUES (?,?,?)'),
      ready: this.db.prepare("UPDATE documents SET pages=?, chunks=?, status='ready', error='', index_version=?, indexed_at=? WHERE id=?"),
      readyCount: this.db.prepare("SELECT count(*) AS n FROM documents WHERE status='ready'"),
      chunkRow: this.db.prepare('SELECT rowid FROM chunks WHERE id=?'),
      rename: this.db.prepare('UPDATE documents SET name=? WHERE id=?'),
    }
  }

  close() {
    this.db.close()
  }

  insertDocument(d) {
    this.q.insertDoc.run(d.id, d.name, d.type, d.size, d.sha256, d.status, d.created_at, d.file)
  }

  replaceContent(id, size, sha, file) {
    this.q.replaceContent.run(size, sha, file, id)
  }

  setStatus(id, status, message) {
    this.q.setStatus.run(status, message, id)
  }

  rename(id, name) {
    this.q.rename.run(name, id)
  }

  document(id) {
    const d = this.q.doc.get(id)
    if (!d) throw new NotFoundError()
    return d
  }

  documentBy(column, value) {
    if (column !== 'sha256' && column !== 'name') throw new Error('invalid lookup column')
    const d = (column === 'sha256' ? this.q.docBySha : this.q.docByName).get(value)
    if (!d) throw new NotFoundError()
    return d
  }

  documents() {
    return this.q.docs.all()
  }

  // cachedEmbedding returns a previously computed embedding for identical text.
  cachedEmbedding(model, hash) {
    const r = this.q.cached.get(model, hash)
    return r ? decodeVector(r.embedding) : null
  }

  // replaceChunks atomically swaps a document's chunks, FTS rows and vectors.
  replaceChunks(doc, pages, chunks, vectors, model, version) {
    if (chunks.length !== vectors.length) throw new Error('chunk and vector counts differ')
    let old = []
    const added = new Map()
    this.db.transaction(() => {
      old = this.q.rowIDs.all(doc.id).map(r => r.rowid)
      for (const id of old) this.q.delFTS.run(id)
      this.q.delChunks.run(doc.id)
      chunks.forEach((c, i) => {
        const blob = encodeVector(vectors[i])
        const res = this.q.insChunk.run(`${doc.id}:${c.seq}`, doc.id, c.seq, c.page, c.heading, c.text, c.tokens, c.hash, model, blob)
        const rowID = Number(res.lastInsertRowid)
        this.q.insFTS.run(rowID, keywordText(c.text), keywordText(c.heading), keywordText(doc.name))
        this.q.insCache.run(model, c.hash, blob)
        added.set(rowID, {docID: doc.id, vec: Float32Array.from(vectors[i])})
      })
      this.q.ready.run(pages, chunks.length, version, Math.floor(Date.now() / 1000), doc.id)
    })()
    for (const id of old) this.vectors.delete(id)
    for (const [id, v] of added) this.vectors.set(id, v)
  }

  // deleteDocument removes a document with its chunks, FTS rows and vectors.
  deleteDocument(id) {
    let old = []
    this.db.transaction(() => {
      old = this.q.rowIDs.all(id).map(r => r.rowid)
      for (const r of old) this.q.delFTS.run(r)
      this.q.delChunks.run(id)
      this.q.delDoc.run(id)
    })()
    for (const r of old) this.vectors.delete(r)
  }

  // countChunks reports stored chunks, FTS rows and vectors for a document (or all).
  countChunks(docID = '') {
    const chunks = docID ? this.db.prepare('SELECT count(*) AS n FROM chunks WHERE doc_id=?').get(docID).n : this.db.prepare('SELECT count(*) AS n FROM chunks').get().n
    const fts = docID
      ? this.db.prepare('SELECT count(*) AS n FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE doc_id=?)').get(docID).n
      : this.db.prepare('SELECT count(*) AS n FROM chunks_fts').get().n
    let vectors = 0
    for (const v of this.vectors.values()) if (!docID || v.docID === docID) vectors++
    return {chunks, fts, vectors}
  }

  // chunks loads chunks by rowid, preserving the given order.
  chunks(rowIDs) {
    if (rowIDs.length === 0) return []
    const rows = this.db
      .prepare(`SELECT c.rowid AS rowid, c.id AS id, c.doc_id AS doc_id, d.name AS doc_name, c.seq AS seq, c.page AS page, c.heading AS heading, c.text AS text,
        c.tokens AS tokens, c.hash AS hash, c.model AS model, c.embedding IS NOT NULL AS embedded
        FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE c.rowid IN (${rowIDs.map(() => '?').join(',')})`)
      .all(...rowIDs)
    const byID = new Map(rows.map(r => [r.rowid, r]))
    return rowIDs.map(id => byID.get(id)).filter(Boolean)
  }

  // keywordSearch runs an FTS5 BM25 query restricted by the document filter.
  keywordSearch(query, docID, limit) {
    const match = ftsQuery(query)
    if (match === '') return []
    const [where, extra] = docFilterSQL(docID)
    const sql = `SELECT f.rowid AS rowid, bm25(chunks_fts, 1.0, 2.0, 2.0) AS score FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid WHERE chunks_fts MATCH ?${where} ORDER BY bm25(chunks_fts, 1.0, 2.0, 2.0) LIMIT ?`
    return this.db.prepare(sql).all(match, ...extra, limit).map(r => ({rowID: r.rowid, score: -r.score})) // bm25: lower is better
  }

  // vectorSearch returns the most similar chunks by cosine similarity.
  vectorSearch(query, docID, limit) {
    const out = []
    for (const [id, v] of this.vectors) {
      if (!matchDoc(docID, v.docID)) continue
      out.push({rowID: id, score: dot(query, v.vec)})
    }
    out.sort((a, b) => (b.score - a.score) || (a.rowID - b.rowID))
    return out.slice(0, limit)
  }

  hasReadyDocuments() {
    return this.q.readyCount.get().n > 0
  }

  chunkRowID(chunkID) {
    const r = this.q.chunkRow.get(chunkID)
    if (!r) throw new NotFoundError()
    return r.rowid
  }
}
