// Document ingestion (asynchronous, one background worker) and hybrid
// retrieval for search_local_docs. Queries never wait for ingestion.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {Context, isCanceled} from '../../utils/context.js'
import {isControl, runes, trimSpace} from '../../utils/gotext.js'
import {chunk, ChunkerVersion} from './chunk.js'
import {detectType, ext, extract} from './extract.js'
import {dot, isTextID, NotFoundError, Store} from './store.js'

export {isTextID, NotePrefix, MemoPrefix, ScopeNotes, ScopeUploads} from './store.js'

// DefaultRRFK is the reciprocal rank fusion constant. On a professor's small
// document set k=10 gave Recall@1 74% vs 68% for k=20 and k=60 (docs/RAG.md).
export const DefaultRRFK = 10
const candidates = 20 // per retriever, before fusion

const ms = start => Math.round((performance.now() - start) * 1000) / 1000

// safeName keeps a display name: base name only, no control characters.
export function safeName(name) {
  name = name.replaceAll('\\', '/')
  name = name.replace(/\/+$/, '')
  name = name === '' ? '.' : name.slice(name.lastIndexOf('/') + 1) || '/'
  name = runes(name).filter(r => !isControl(r) && r !== '/').join('')
  const r = runes(trimSpace(name))
  if (r.length > 200) name = r.slice(0, 200).join('')
  if (name === '' || name === '.' || name === '..') return 'document'
  return trimSpace(name)
}

function writePrivate(p, data) {
  const tmp = p + '.part'
  fs.writeFileSync(tmp, data, {mode: 0o600})
  fs.renameSync(tmp, p)
}

const randomID = () => crypto.randomBytes(8).toString('hex')
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')

// embeddingText is the text embedded for a chunk: its heading gives context.
const embeddingText = c => (c.heading && !c.text.startsWith(c.heading) ? `${c.heading}. ${c.text}` : c.text)

export class Service {
  // options: {dir, maxUploadBytes, chunkTokens, chunkOverlap, topK, hybrid, minSimilarity, rrfK}
  constructor(options, embedder, pdf, log) {
    fs.mkdirSync(path.join(options.dir, 'files'), {recursive: true, mode: 0o700})
    this.store = new Store(path.join(options.dir, 'index.db'))
    this.embedder = embedder
    this.pdf = pdf
    this.opts = options
    this.log = log
    this.queue = []
    this.wake = null
    this.closed = false
  }

  close() {
    this.closed = true
    this.wake?.()
    this.store.close()
  }

  indexVersion() {
    return `${ChunkerVersion}/${this.embedder?.model?.() ?? ''}/${this.opts.chunkTokens}-${this.opts.chunkOverlap}`
  }

  // run processes the ingestion queue until ctx ends. Documents left
  // unfinished by a previous run, or indexed with other settings, are queued.
  async run(ctx) {
    try {
      for (const d of this.store.documents()) {
        if (['queued', 'extracting', 'embedding'].includes(d.status) || (d.status === 'ready' && d.index_version !== this.indexVersion())) this.enqueue(d.id)
      }
    } catch {
      // the index may be closing
    }
    while (!ctx.err && !this.closed) {
      if (this.queue.length === 0) {
        await Promise.race([new Promise(r => (this.wake = r)), ctx.done()])
        this.wake = null
        continue
      }
      const id = this.queue.shift()
      const start = performance.now()
      try {
        await this.#index(ctx, id)
        this.log?.info({doc_id: id, ms: Math.round(performance.now() - start)}, 'document indexed')
      } catch (e) {
        if (ctx.err || this.closed) return
        this.log?.warn({doc_id: id, error: e.message}, 'document indexing failed')
        try {
          this.store.setStatus(id, 'error', e.message)
        } catch {
          // closed
        }
      }
    }
  }

  enqueue(id) {
    if (this.queue.length >= 256) {
      this.log?.warn({doc_id: id}, 'indexing queue full; document stays queued until restart')
      return
    }
    this.queue.push(id)
    this.wake?.()
  }

  // upload validates and stores a document, then queues it for indexing.
  async upload(ctx, name, data) {
    name = safeName(name)
    if (data.length > this.opts.maxUploadBytes) throw new Error(`file is larger than ${Math.floor(this.opts.maxUploadBytes / 2 ** 20)} MB`)
    if (data.length === 0) throw new Error('file is empty')
    const kind = detectType(name, data)
    const sha = sha256(data)
    try {
      return {document: this.store.documentBy('sha256', sha), duplicate: true, replaced: false}
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e
    }
    const extension = ext(name).toLowerCase()
    let existing = null
    try {
      existing = this.store.documentBy('name', name)
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e
    }
    if (existing && existing.type === kind && !isTextID(existing.id)) {
      // New version of a known file: keep its id, replace content, re-index.
      const file = `${existing.id}-${sha.slice(0, 8)}${extension}`
      writePrivate(path.join(this.opts.dir, 'files', file), data)
      this.store.replaceContent(existing.id, data.length, sha, file)
      if (existing.file !== file) fs.rmSync(path.join(this.opts.dir, 'files', existing.file), {force: true})
      this.enqueue(existing.id)
      return {document: this.store.document(existing.id), duplicate: false, replaced: true}
    }
    const id = randomID()
    const d = {id, name, type: kind, size: data.length, sha256: sha, pages: 0, chunks: 0, status: 'queued', error: '', index_version: '',
      created_at: Math.floor(Date.now() / 1000), indexed_at: 0, file: id + extension}
    writePrivate(path.join(this.opts.dir, 'files', d.file), data)
    try {
      this.store.insertDocument(d)
    } catch (e) {
      fs.rmSync(path.join(this.opts.dir, 'files', d.file), {force: true})
      throw e
    }
    this.enqueue(id)
    return {document: d, duplicate: false, replaced: false}
  }

  documents() {
    return this.store.documents()
  }

  // uploads lists uploaded documents only (not notes or memos).
  uploads() {
    return this.store.documents().filter(d => !isTextID(d.id))
  }

  delete(_ctx, id) {
    let d
    try {
      d = this.store.document(id)
    } catch {
      throw new Error('unknown document')
    }
    this.store.deleteDocument(id)
    fs.rmSync(path.join(this.opts.dir, 'files', d.file))
  }

  reindex(id) {
    try {
      this.store.document(id)
    } catch {
      throw new Error('unknown document')
    }
    this.store.setStatus(id, 'queued', '')
    this.enqueue(id)
  }

  // #index extracts, chunks and embeds one document. Unchanged chunk text
  // reuses cached embeddings, so reindexing an edit only embeds new text.
  async #index(ctx, id) {
    const d = this.store.document(id)
    const data = fs.readFileSync(path.join(this.opts.dir, 'files', d.file))
    this.store.setStatus(id, 'extracting', '')
    const sections = await extract(ctx, d.type, data, this.pdf)
    const chunks = chunk(sections, this.opts.chunkTokens, this.opts.chunkOverlap)
    if (chunks.length === 0) throw new Error('no text chunks produced')
    this.store.setStatus(id, 'embedding', '')
    const model = this.embedder.model()
    const vectors = new Array(chunks.length)
    const missing = []
    chunks.forEach((c, i) => {
      const v = this.store.cachedEmbedding(model, c.hash)
      if (v) vectors[i] = v
      else missing.push(i)
    })
    if (missing.length > 0) {
      const embedded = await this.embedder.embed(ctx, missing.map(i => embeddingText(chunks[i])), 'passage')
      missing.forEach((i, j) => (vectors[i] = embedded[j]))
    }
    if (this.closed) return
    const pages = sections.reduce((m, s) => Math.max(m, s.page ?? 0), 0)
    this.store.replaceChunks(d, pages, chunks, vectors, model, this.indexVersion())
  }

  // search runs hybrid retrieval (or vector-only when hybrid is off).
  search(ctx, query, docID, k) {
    return this.searchWith(ctx, query, docID ?? '', k, this.opts.hybrid ? 'hybrid' : 'vector')
  }

  // searchWith runs one retrieval method: hybrid, vector or keyword. FTS5 BM25
  // and cosine similarity each return candidates, fused with Reciprocal Rank
  // Fusion (score = Σ 1/(k + rank)). Vector-only hits below minSimilarity are
  // dropped as irrelevant.
  async searchWith(ctx, query, docID, k, method) {
    const start = performance.now()
    query = trimSpace(query ?? '')
    if (query === '') throw new Error('empty query')
    if (runes(query).length > 1000) query = runes(query).slice(0, 1000).join('')
    if (!(k > 0)) k = this.opts.topK
    k = Math.min(k, 20)
    if (!['hybrid', 'vector', 'keyword'].includes(method)) throw new Error(`unknown retrieval method ${JSON.stringify(method)}`)
    const res = {hits: null, method, embed_ms: 0, keyword_ms: 0, vector_ms: 0, total_ms: 0}
    const rrfK = this.opts.rrfK > 0 ? this.opts.rrfK : DefaultRRFK
    const fused = new Map()
    const get = id => {
      if (!fused.has(id)) fused.set(id, {score: 0, krank: 0, vrank: 0, similarity: 0, similarityPresent: false})
      return fused.get(id)
    }
    let qv = null
    let embedErr = null
    if (method === 'keyword') {
      embedErr = new Error('keyword-only search')
    } else {
      const t = performance.now()
      try {
        qv = (await this.embedder.embed(ctx ?? Context.background(), [query], 'query'))[0]
      } catch (e) {
        embedErr = e
      }
      res.embed_ms = ms(t)
    }
    if (!embedErr) {
      const t = performance.now()
      this.store.vectorSearch(qv, docID, candidates).forEach((r, i) => {
        const a = get(r.rowID)
        a.vrank = i + 1
        a.similarity = r.score
        a.similarityPresent = true
        a.score += 1 / (rrfK + i + 1)
      })
      res.vector_ms = ms(t)
    } else if (method !== 'keyword') {
      if (ctx?.err || isCanceled(embedErr)) throw ctx?.err ?? embedErr
      res.method = 'keyword'
      res.warning = `semantic search unavailable (${embedErr.message}); keyword results only`
    }
    if (method !== 'vector' || embedErr) {
      const t = performance.now()
      this.store.keywordSearch(query, docID, candidates).forEach((r, i) => {
        const a = get(r.rowID)
        a.krank = i + 1
        a.score += 1 / (rrfK + i + 1)
      })
      res.keyword_ms = ms(t)
    }
    const ids = [...fused.entries()].filter(([, a]) => !(a.krank === 0 && a.similarityPresent && a.similarity < this.opts.minSimilarity)).map(([id]) => id)
    ids.sort((x, y) => {
      const a = fused.get(x)
      const b = fused.get(y)
      if (a.score !== b.score) return b.score - a.score
      return x - y
    })
    const seen = new Set()
    for (const c of this.store.chunks(ids)) {
      if (res.hits?.length === k) break
      if (seen.has(c.hash)) continue // identical text indexed twice (e.g. a repeated slide)
      seen.add(c.hash)
      const a = fused.get(c.rowid)
      let similarity = a.similarity
      if (!a.similarityPresent && !embedErr) similarity = dot(qv, this.store.vectors.get(c.rowid)?.vec ?? new Float32Array(0))
      const h = {chunk_id: c.id, doc_id: c.doc_id, document: c.doc_name}
      if (c.page) h.page = c.page
      if (c.heading) h.heading = c.heading
      h.text = c.text
      h.score = a.score
      if (a.krank) h.keyword_rank = a.krank
      if (a.vrank) h.vector_rank = a.vrank
      h.similarity = similarity
      ;(res.hits ??= []).push(h)
    }
    res.total_ms = ms(start)
    const out = {hits: res.hits, method: res.method, embed_ms: res.embed_ms, keyword_ms: res.keyword_ms, vector_ms: res.vector_ms, total_ms: res.total_ms}
    if (res.warning) out.warning = res.warning
    return out
  }

  hasReadyDocuments() {
    try {
      return this.store.hasReadyDocuments()
    } catch {
      return false
    }
  }

  // embedderReady checks the embedding sidecar when it supports a health check.
  async embedderReady(ctx) {
    if (typeof this.embedder?.ready === 'function') await this.embedder.ready(ctx)
  }

  maxUploadBytes() {
    return this.opts.maxUploadBytes
  }

  // chunk returns one indexed chunk (never reads files, only the index).
  chunk(chunkID) {
    const rowID = this.store.chunkRowID(chunkID)
    const c = this.store.chunks([rowID])
    if (c.length === 0) throw new Error('unknown chunk')
    return c[0]
  }

  // putText indexes (or re-indexes) text under a reserved id (notes, memos).
  // Unchanged text is a no-op; changed text replaces the old chunks when
  // indexing completes, reusing cached embeddings for unchanged chunks.
  putText(_ctx, id, name, text) {
    if (!isTextID(id) || /[/\\.]/.test(id)) throw new Error(`invalid text document id ${JSON.stringify(id)}`)
    text = trimSpace(text)
    if (text === '') throw new Error('empty text')
    if (Buffer.byteLength(text) > this.opts.maxUploadBytes) throw new Error(`text is larger than ${Math.floor(this.opts.maxUploadBytes / 2 ** 20)} MB`)
    name = safeName(name)
    // The hash includes the id: two notes with identical text are still two documents.
    const sha = sha256(id + '\x00' + text)
    const file = id + '.md'
    let existing = null
    try {
      existing = this.store.document(id)
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e
    }
    if (existing) {
      if (existing.sha256 === sha && existing.name === name && existing.status !== 'error') return
      writePrivate(path.join(this.opts.dir, 'files', file), text)
      this.store.rename(id, name)
      this.store.replaceContent(id, Buffer.byteLength(text), sha, file)
    } else {
      writePrivate(path.join(this.opts.dir, 'files', file), text)
      this.store.insertDocument({id, name, type: 'markdown', size: Buffer.byteLength(text), sha256: sha, status: 'queued', created_at: Math.floor(Date.now() / 1000), file})
    }
    this.enqueue(id)
  }
}
