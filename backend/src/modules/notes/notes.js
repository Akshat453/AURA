// Notes: CRUD, search (semantic through the document index plus keyword
// fallback) and index maintenance. Indexed under reserved ids (note-…,
// memo-…), so notes stay distinguishable from uploaded documents.
import {fields, runeLen, runes} from '../../utils/gotext.js'
import {ymdHM} from '../../utils/time.js'
import {MemoPrefix, NotePrefix, ScopeNotes} from '../../services/rag/store.js'
import {clean, defineJSON, escapeLike, localTime, newID, NotFoundError, nullable} from '../professor/common.js'

export const maxNoteRunes = 20000

export function normalizeTags(tags) {
  const seen = new Set()
  const out = []
  for (const t of tags ?? []) {
    for (const part of String(t).split(',')) {
      const p = clean(part.trim().replace(/^#/, ''), 30).toLowerCase()
      if (p !== '' && !seen.has(p) && out.length < 10) {
        seen.add(p)
        out.push(p)
      }
    }
  }
  return out
}

// titleFrom derives a short title from the body.
export const titleFrom = body => fields(body).slice(0, 8).join(' ').replace(/[.,;:!?]+$/, '')

// prepareNote validates a note request.
export function prepareNote(input) {
  const inp = {...input}
  inp.body = clean(inp.body, maxNoteRunes + 1)
  if (inp.body === '') throw new Error('note text is required')
  if (runeLen(inp.body) > maxNoteRunes) throw new Error(`notes are limited to ${maxNoteRunes} characters`)
  inp.title = clean(inp.title, 200)
  if (inp.title === '') inp.title = titleFrom(inp.body)
  inp.tags = normalizeTags(inp.tags)
  return inp
}

function noteJSON() {
  return {id: this.id, title: this.title, body: this.body, tags: this.tags, source: this.source, created_at: localTime(this.createdAt), updated_at: localTime(this.updatedAt)}
}

function hitJSON() {
  const out = {id: this.id, kind: this.kind, title: this.title, snippet: this.snippet}
  if (this.tags?.length) out.tags = this.tags
  out.updated_at = localTime(this.updatedAt)
  if (this.similarity) out.similarity = this.similarity
  out.match = this.match
  return out
}

export const noteHit = h => defineJSON(h, hitJSON)

const scanNote = r => defineJSON({id: r.id, title: r.title, body: r.body, tags: normalizeTags([r.tags]), source: r.source, createdAt: r.created_at, updatedAt: r.updated_at}, noteJSON)

export function snippet(s, max) {
  s = fields(s).join(' ')
  const r = runes(s)
  return r.length > max ? r.slice(0, max).join('') + '…' : s
}

function hasTag(tags, tag) {
  tag = tag.trim().replace(/^#/, '').toLowerCase()
  return tags.includes(tag)
}

// indexID maps a note or memo id to its document-index id.
export function indexID(id) {
  if (id.startsWith('note_')) return NotePrefix + id.slice(5)
  if (id.startsWith('memo_')) return MemoPrefix + id.slice(5)
  return ''
}

// fromIndexID maps a document-index id back to a note or memo id.
export function fromIndexID(doc) {
  if (doc.startsWith(NotePrefix)) return 'note_' + doc.slice(NotePrefix.length)
  if (doc.startsWith(MemoPrefix)) return 'memo_' + doc.slice(MemoPrefix.length)
  return ''
}

function noteText(n) {
  let text = '# ' + n.title + '\n\n' + n.body
  if (n.tags.length) text += '\n\nTags: ' + n.tags.join(', ')
  return text
}

const noteColumns = 'id, title, body, tags, source, created_at, updated_at'

export const methods = {
  // createNote stores a note and queues it for indexing.
  createNote(input, source, actionID = '') {
    const existing = this.existingByAction('notes', actionID)
    if (existing) return this.note(existing)
    const inp = prepareNote(input)
    const now = Math.floor(this.nowMs() / 1000)
    const id = newID('note_')
    try {
      this.db.prepare('INSERT INTO notes(id, title, body, tags, source, action_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, inp.title, inp.body, inp.tags.join(','), source, nullable(actionID), now, now)
    } catch (e) {
      const first = this.raced(e, 'notes', actionID)
      if (first) return this.note(first)
      throw e
    }
    const n = this.note(id)
    this.indexNote(n)
    return n
  },

  note(id) {
    const r = this.db.prepare(`SELECT ${noteColumns} FROM notes WHERE id=?`).get(id)
    if (!r) throw new NotFoundError()
    return scanNote(r)
  },

  // applyNotePatch returns the note as it would be after the patch
  // ({title, body, append, tags}; undefined/null fields are unchanged).
  applyNotePatch(id, p) {
    const n = this.note(id)
    const set = k => p[k] !== undefined && p[k] !== null
    if (!set('title') && !set('body') && !set('append') && !set('tags')) throw new Error('nothing to change')
    if (set('title')) n.title = clean(p.title, 200)
    if (set('body')) n.body = p.body
    if (set('append') && p.append.trim() !== '') n.body = n.body.trim() + '\n\n' + p.append.trim()
    if (set('tags')) n.tags = p.tags
    const inp = prepareNote({title: n.title, body: n.body, tags: n.tags})
    n.title = inp.title
    n.body = inp.body
    n.tags = inp.tags
    return n
  },

  // updateNote applies a patch and re-indexes the note.
  updateNote(id, p) {
    const n = this.applyNotePatch(id, p)
    this.db.prepare('UPDATE notes SET title=?, body=?, tags=?, updated_at=? WHERE id=?').run(n.title, n.body, n.tags.join(','), Math.floor(this.nowMs() / 1000), id)
    const out = this.note(id)
    this.indexNote(out)
    return out
  },

  // deleteNote removes a note and its indexed chunks.
  deleteNote(id) {
    if (this.db.prepare('DELETE FROM notes WHERE id=?').run(id).changes === 0) throw new NotFoundError()
    this.unindex(id)
  },

  // notes lists notes by tag, words in title/body/tags, and creation date.
  notes({tag = '', query = '', date = '', limit = 0} = {}) {
    let q = `SELECT ${noteColumns} FROM notes WHERE 1=1`
    const args = []
    const t = tag.trim().replace(/^#/, '').toLowerCase()
    if (t !== '') {
      q += " AND (',' || tags || ',') LIKE ? ESCAPE '\\'"
      args.push('%,' + escapeLike(t) + ',%')
    }
    for (const w of fields(query.toLowerCase()).slice(0, 6)) {
      q += " AND (lower(title) LIKE ? ESCAPE '\\' OR lower(body) LIKE ? ESCAPE '\\' OR lower(tags) LIKE ? ESCAPE '\\')"
      const like = '%' + escapeLike(w) + '%'
      args.push(like, like, like)
    }
    if (date !== '') {
      const d = this.parseDate(date)
      q += ' AND created_at >= ? AND created_at < ?'
      args.push(Math.floor(d.toMillis() / 1000), Math.floor(d.plus({days: 1}).toMillis() / 1000))
    }
    if (limit <= 0) limit = 50
    q += ` ORDER BY updated_at DESC LIMIT ${Math.min(limit, 10000)}`
    return this.db.prepare(q).all(...args).map(scanNote)
  },

  // searchNotes finds notes and memos. Semantic search through the document
  // index lets a Hindi question find an English note; keyword matching covers
  // notes not indexed yet or a disabled index.
  async searchNotes(ctx, query, tag, k) {
    const start = performance.now()
    query = (query ?? '').trim()
    tag = tag ?? ''
    if (!(k > 0) || k > 10) k = 5
    const res = {hits: [], method: 'keyword', total_ms: 0}
    const seen = new Set()
    if (this.opts.index && query !== '') {
      try {
        const r = await this.opts.index.search(ctx, query, ScopeNotes, k * 3)
        res.method = 'semantic+keyword'
        if (r.warning) res.warning = r.warning
        for (const h of r.hits ?? []) {
          const id = fromIndexID(h.doc_id)
          if (id === '' || seen.has(id)) continue
          const hit = this.hitFor(id)
          if (!hit || (tag !== '' && !hasTag(hit.tags ?? [], tag))) continue
          seen.add(id)
          hit.snippet = snippet(h.text, 400)
          hit.similarity = h.similarity
          hit.match = 'semantic'
          res.hits.push(hit)
        }
      } catch (e) {
        if (ctx?.err) throw e
        res.warning = 'semantic note search unavailable: ' + e.message
      }
    }
    if (res.hits.length < k) {
      for (const n of this.notes({tag, query, limit: k})) {
        if (seen.has(n.id)) continue
        seen.add(n.id)
        res.hits.push(noteHit({id: n.id, kind: 'note', title: n.title, snippet: snippet(n.body, 400), tags: n.tags, updatedAt: n.updatedAt, match: 'keyword'}))
      }
      if (tag === '') {
        try {
          for (const m of this.memos(query, k)) {
            if (seen.has(m.id)) continue
            seen.add(m.id)
            res.hits.push(noteHit({id: m.id, kind: 'memo', title: m.title, snippet: snippet(m.transcript, 400), updatedAt: m.updatedAt, match: 'keyword'}))
          }
        } catch {
          // memos unavailable: notes only
        }
      }
    }
    res.hits = [...res.hits.filter(h => h.match === 'semantic'), ...res.hits.filter(h => h.match !== 'semantic')]
    if (res.hits.length > k) res.hits = res.hits.slice(0, k)
    res.total_ms = Math.round((performance.now() - start) * 1000) / 1000
    const out = {hits: res.hits, method: res.method, total_ms: res.total_ms}
    if (res.warning) out.warning = res.warning
    return out
  },

  // hitFor describes a note or memo for search results (null when unknown).
  hitFor(id) {
    try {
      if (id.startsWith('memo_')) {
        const m = this.memo(id)
        return noteHit({id: m.id, kind: 'memo', title: m.title, tags: null, updatedAt: m.updatedAt})
      }
      const n = this.note(id)
      return noteHit({id: n.id, kind: 'note', title: n.title, tags: n.tags, updatedAt: n.updatedAt})
    } catch {
      return null
    }
  },

  // indexNote queues a note for (re)indexing; a failure is logged and
  // repaired by reconcile at the next start.
  indexNote(n) {
    if (!this.opts.index) return
    try {
      this.opts.index.putText(null, indexID(n.id), 'Note: ' + n.title, noteText(n))
    } catch (e) {
      this.log?.warn({note_id: n.id, error: e.message}, 'note indexing failed')
    }
  },

  unindex(id) {
    if (!this.opts.index) return
    try {
      this.opts.index.delete(null, indexID(id))
    } catch (e) {
      if (!e.message.includes('unknown document')) this.log?.warn({id, error: e.message}, 'removing note from the index failed')
    }
  },

  // reconcile makes the document index match the notes and memos: it indexes
  // anything missing or changed and removes entries whose note or memo no
  // longer exists (for example after a crash between the two writes).
  reconcile() {
    if (!this.opts.index) return
    for (const d of this.opts.index.documents()) {
      const id = fromIndexID(d.id)
      if (id === '') continue
      try {
        if (id.startsWith('memo_')) this.memo(id)
        else this.note(id)
      } catch (e) {
        if (e instanceof NotFoundError) {
          try {
            this.opts.index.delete(null, d.id)
          } catch {
            // already gone
          }
        }
      }
    }
    for (const n of this.notes({limit: 10000})) this.indexNote(n) // putText is a no-op when unchanged
    for (const m of this.memos('', 10000)) this.indexMemo(m)
  },
}

export {ymdHM}
