// Voice memos: the (editable) transcript and, only when the professor
// explicitly chose to keep it, the original recording (0600 file).
import fs from 'node:fs'
import path from 'node:path'
import {fields} from '../../utils/gotext.js'
import {clean, defineJSON, escapeLike, localTime, newID, NotFoundError, nullable} from '../professor/common.js'
import {indexID, maxNoteRunes, titleFrom} from '../notes/notes.js'

// prepareMemo validates a memo request.
export function prepareMemo(input) {
  const inp = {...input}
  inp.transcript = clean(inp.transcript, maxNoteRunes)
  if (inp.transcript === '') throw new Error('the memo transcript is empty')
  inp.title = clean(inp.title, 200)
  if (inp.title === '') inp.title = titleFrom(inp.transcript)
  if (!['', 'en', 'hi', 'hinglish', 'auto'].includes(inp.language ?? '')) inp.language = ''
  inp.language ??= ''
  inp.duration_ms ??= 0
  return inp
}

function memoJSON() {
  const out = {id: this.id, title: this.title, transcript: this.transcript}
  if (this.language) out.language = this.language
  if (this.duration_ms) out.duration_ms = this.duration_ms
  out.has_audio = this.hasAudio
  if (this.audio_bytes) out.audio_bytes = this.audio_bytes
  out.created_at = localTime(this.createdAt)
  out.updated_at = localTime(this.updatedAt)
  return out
}

const scanMemo = r => defineJSON({id: r.id, title: r.title, transcript: r.transcript, language: r.language, duration_ms: r.duration_ms, audioFile: r.audio_file,
  audio_bytes: r.audio_bytes, hasAudio: r.audio_file !== '', createdAt: r.created_at, updatedAt: r.updated_at}, memoJSON)

const memoColumns = 'id, title, transcript, language, duration_ms, audio_file, audio_bytes, created_at, updated_at'

export const methods = {
  // createMemo stores a memo. wav is stored only when given, which callers do
  // solely when the professor explicitly asked to keep the recording.
  createMemo(input, wav, actionID = '') {
    const existing = this.existingByAction('memos', actionID)
    if (existing) return this.memo(existing)
    const inp = prepareMemo(input)
    const id = newID('memo_')
    let file = ''
    const size = wav?.length ?? 0
    if (size > 0) {
      const used = this.db.prepare('SELECT COALESCE(SUM(audio_bytes),0) AS n FROM memos').get().n
      if (this.opts.memoMaxBytes > 0 && used + size > this.opts.memoMaxBytes) {
        throw new Error(`memo audio storage is full (${Math.floor(this.opts.memoMaxBytes / 2 ** 20)} MB limit); delete old recordings or save the transcript only`)
      }
      file = id + '.wav'
      const tmp = path.join(this.opts.dir, 'memos', file + '.part')
      fs.writeFileSync(tmp, wav, {mode: 0o600})
      fs.renameSync(tmp, path.join(this.opts.dir, 'memos', file))
    }
    const now = Math.floor(this.nowMs() / 1000)
    try {
      this.db.prepare('INSERT INTO memos(id, title, transcript, language, duration_ms, audio_file, audio_bytes, action_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, inp.title, inp.transcript, inp.language, Math.trunc(inp.duration_ms), file, size, nullable(actionID), now, now)
    } catch (e) {
      if (file) fs.rmSync(path.join(this.opts.dir, 'memos', file), {force: true})
      const first = this.raced(e, 'memos', actionID)
      if (first) return this.memo(first)
      throw e
    }
    const m = this.memo(id)
    this.indexMemo(m)
    return m
  },

  memo(id) {
    const r = this.db.prepare(`SELECT ${memoColumns} FROM memos WHERE id=?`).get(id)
    if (!r) throw new NotFoundError()
    return scanMemo(r)
  },

  // memoAudioPath returns the stored recording of a memo, if it was kept.
  memoAudioPath(id) {
    const m = this.memo(id)
    if (m.audioFile === '') throw new Error('the original audio of this memo was not kept')
    return path.join(this.opts.dir, 'memos', path.basename(m.audioFile))
  },

  // updateMemo edits the title or transcript and re-indexes the memo.
  updateMemo(id, title, transcript) {
    const m = this.memo(id)
    let inp = {title: m.title, transcript: m.transcript, language: m.language}
    if (title !== undefined && title !== null) inp.title = title
    if (transcript !== undefined && transcript !== null) inp.transcript = transcript
    inp = prepareMemo(inp)
    this.db.prepare('UPDATE memos SET title=?, transcript=?, updated_at=? WHERE id=?').run(inp.title, inp.transcript, Math.floor(this.nowMs() / 1000), id)
    const out = this.memo(id)
    this.indexMemo(out)
    return out
  },

  // deleteMemo removes the memo, its recording and its index entry.
  deleteMemo(id) {
    const m = this.memo(id)
    this.db.prepare('DELETE FROM memos WHERE id=?').run(id)
    if (m.audioFile) fs.rmSync(path.join(this.opts.dir, 'memos', path.basename(m.audioFile)), {force: true})
    this.unindex(id)
  },

  // memos lists memos, newest first, optionally matching words in the title or transcript.
  memos(query = '', limit = 0) {
    let q = `SELECT ${memoColumns} FROM memos WHERE 1=1`
    const args = []
    for (const w of fields((query ?? '').toLowerCase()).slice(0, 6)) {
      q += " AND (lower(title) LIKE ? ESCAPE '\\' OR lower(transcript) LIKE ? ESCAPE '\\')"
      const like = '%' + escapeLike(w) + '%'
      args.push(like, like)
    }
    if (limit <= 0) limit = 50
    q += ` ORDER BY created_at DESC LIMIT ${Math.min(limit, 10000)}`
    return this.db.prepare(q).all(...args).map(scanMemo)
  },

  // memoStorage reports stored memo audio bytes and the limit.
  memoStorage() {
    let used = 0
    try {
      used = this.db.prepare('SELECT COALESCE(SUM(audio_bytes),0) AS n FROM memos').get().n
    } catch {
      // closed
    }
    return {used, limit: this.opts.memoMaxBytes}
  },

  indexMemo(m) {
    if (!this.opts.index) return
    try {
      this.opts.index.putText(null, indexID(m.id), 'Voice memo: ' + m.title, '# ' + m.title + '\n\n' + m.transcript)
    } catch (e) {
      this.log?.warn({memo_id: m.id, error: e.message}, 'memo indexing failed')
    }
  },
}
