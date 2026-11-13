// Professor tools API for the web page. Every route is loopback-only, and
// every state-changing route also requires the same-origin custom header.
// Changes made here are direct, explicit actions by the professor on the page
// (delete asks in the page first); the assistant's own proposals go through
// the confirmation workflow instead.
import fs from 'node:fs'
import {decodeJSON, httpError, localOnly, readBody, sameOrigin, writeJSON} from '../middleware/security.js'
import {isNotFound} from '../modules/professor/common.js'
import {parseWeekday} from '../modules/professor/timetable.js'
import {AnyRecipient} from '../modules/email/drafts.js'
import {isBusy} from '../services/speech/whisper.js'
import * as audio from '../utils/audio.js'
import {hasCode} from '../utils/http.js'
import {trimSpace} from '../utils/gotext.js'
import {localLayout, rfc3339Seconds, weekdayName, ymd} from '../utils/time.js'
import {readMultipartFile} from './docs.js'
import * as S from './schemas.js'

// writeErr maps service errors to HTTP statuses without leaking internals.
function writeErr(res, err) {
  if (isNotFound(err)) httpError(res, 'not found', 404)
  else httpError(res, err.message, 422)
}

const sttLanguage = l => (l === 'en' || l === 'hi' ? l : l === 'hinglish' ? 'hi' : 'auto')

export function registerProfessor(srv, route) {
  const get = (p, h) => route('GET', p, localOnly, h)
  const change = (method, p, h) => route(method, p, localOnly, sameOrigin, h)
  // feature guards a route by its feature flag.
  const feature = (res, on, name) => {
    if (!srv.prof || !on) {
      httpError(res, name + ' is disabled', 404)
      return false
    }
    return true
  }
  // guarded runs fn and maps thrown service errors.
  const guarded = fn => async (req, res) => {
    try {
      await fn(req, res)
    } catch (e) {
      writeErr(res, e)
    }
  }
  const q = (req, k) => (typeof req.query[k] === 'string' ? req.query[k] : '')
  const f = () => srv.features

  get('/api/professor', (req, res) => {
    if (!srv.prof) {
      writeJSON(res, {enabled: false})
      return
    }
    const {used, limit} = srv.prof.memoStorage()
    const ft = f()
    writeJSON(res, {
      enabled: true, timezone: srv.prof.location(), now: rfc3339Seconds(srv.prof.now()),
      features: {timetable: ft.timetable, reminders: ft.reminders, notes: ft.notes, voice_memos: ft.memos, email_drafts: ft.drafts},
      confirmation_timeout_s: Math.trunc(srv.cfg.actionConfirmationTimeout / 1000), memo_max_seconds: srv.prof.maxMemoSeconds(),
      memo_audio_bytes: used, memo_audio_limit: limit, notes_send_allowed: srv.cfg.notesToGemini,
      google: srv.googleStatus(),
    })
  })

  // ---- Timetable ----
  const classFrom = b => {
    const wd = parseWeekday(b.weekday === undefined || b.weekday === null ? '<nil>' : typeof b.weekday === 'number' ? goNumber(b.weekday) : String(b.weekday))
    return {subject: b.subject, course_code: b.course_code, section: b.section, room: b.room, weekday: wd, start: b.start, end: b.end,
      timezone: b.timezone, effective_from: b.effective_from, effective_to: b.effective_to, active: b.active === undefined || b.active}
  }

  get('/api/timetable', guarded((req, res) => {
    if (!feature(res, f().timetable, 'the timetable')) return
    writeJSON(res, {classes: srv.prof.classes(), timezone: srv.prof.location()})
  }))
  get('/api/timetable/day', guarded((req, res) => {
    if (!feature(res, f().timetable, 'the timetable')) return
    const start = performance.now()
    const d = srv.prof.parseDate(q(req, 'date'))
    const {gaps, classes} = srv.prof.freeTime(d)
    writeJSON(res, {date: ymd(d), weekday: weekdayName(d), classes: classes ?? [], free: gaps, query_ms: Math.round((performance.now() - start) * 1000) / 1000})
  }))
  get('/api/timetable/next', guarded((req, res) => {
    if (!feature(res, f().timetable, 'the timetable')) return
    const {current, next} = srv.prof.nextClass(q(req, 'subject'))
    writeJSON(res, {in_progress: current, next})
  }))
  get('/api/timetable/export', guarded((req, res) => {
    if (!feature(res, f().timetable, 'the timetable')) return
    res.set('Content-Type', 'text/csv; charset=utf-8')
    res.set('Content-Disposition', 'attachment; filename="timetable.csv"')
    res.send(srv.prof.exportCSV())
  }))
  change('POST', '/api/timetable', guarded(async (req, res) => {
    if (!feature(res, f().timetable, 'the timetable')) return
    const b = await decodeJSON(req, res, S.ClassBody, 'classBody')
    if (!b) return
    writeJSON(res, srv.prof.addClass(classFrom(b)))
  }))
  change('POST', '/api/timetable/import', guarded(async (req, res) => {
    if (!feature(res, f().timetable, 'the timetable')) return
    let text
    if ((req.get('Content-Type') ?? '').startsWith('multipart/')) {
      try {
        text = (await readMultipartFile(req, 'file', 1 << 20, 1 << 20)).data.toString('utf8')
      } catch {
        httpError(res, "expected a CSV file in the 'file' field", 400)
        return
      }
    } else {
      try {
        text = (await readBody(req, 1 << 20)).toString('utf8')
      } catch (e) {
        writeErr(res, new Error(`invalid CSV: ${e.message}`))
        return
      }
    }
    writeJSON(res, {imported: srv.prof.importCSV(text, q(req, 'replace') === '1')})
  }))
  change('PUT', '/api/timetable/:id', guarded(async (req, res) => {
    if (!feature(res, f().timetable, 'the timetable')) return
    const b = await decodeJSON(req, res, S.ClassBody, 'classBody')
    if (!b) return
    writeJSON(res, srv.prof.updateClass({...classFrom(b), id: req.params.id}))
  }))
  change('DELETE', '/api/timetable/:id', guarded((req, res) => {
    if (!feature(res, f().timetable, 'the timetable')) return
    srv.prof.deleteClass(req.params.id)
    writeJSON(res, {status: 'deleted'})
  }))

  // ---- Reminders ----
  get('/api/reminders', guarded((req, res) => {
    if (!feature(res, f().reminders, 'reminders')) return
    const list = srv.prof.reminders({scope: q(req, 'scope'), query: q(req, 'q')})
    writeJSON(res, {reminders: list, timezone: srv.prof.location(), now: localLayout(srv.prof.now())})
  }))
  change('POST', '/api/reminders', guarded(async (req, res) => {
    if (!feature(res, f().reminders, 'reminders')) return
    const inp = await decodeJSON(req, res, S.ReminderInput, 'ReminderInput')
    if (!inp) return
    writeJSON(res, srv.prof.createReminder(inp, ''))
  }))
  change('PATCH', '/api/reminders/:id', guarded(async (req, res) => {
    if (!feature(res, f().reminders, 'reminders')) return
    const p = await decodeJSON(req, res, S.ReminderPatch, 'ReminderPatch')
    if (!p) return
    writeJSON(res, srv.prof.updateReminder(req.params.id, p))
  }))
  change('DELETE', '/api/reminders/:id', guarded((req, res) => {
    if (!feature(res, f().reminders, 'reminders')) return
    srv.prof.deleteReminder(req.params.id)
    writeJSON(res, {status: 'deleted'})
  }))

  // ---- Notes ----
  get('/api/notes', guarded((req, res) => {
    if (!feature(res, f().notes, 'notes')) return
    writeJSON(res, {notes: srv.prof.notes({tag: q(req, 'tag'), query: q(req, 'q'), date: q(req, 'date'), limit: 100})})
  }))
  get('/api/notes/search', guarded(async (req, res) => {
    if (!feature(res, f().notes || f().memos, 'notes')) return
    const query = trimSpace(q(req, 'q'))
    if (query === '' || [...query].length > 500) {
      httpError(res, 'q must be 1-500 characters', 400)
      return
    }
    writeJSON(res, await srv.prof.searchNotes(srv.baseCtx, query, q(req, 'tag'), 10))
  }))
  get('/api/notes/:id', guarded((req, res) => {
    if (!feature(res, f().notes, 'notes')) return
    writeJSON(res, srv.prof.note(req.params.id))
  }))
  change('POST', '/api/notes', guarded(async (req, res) => {
    if (!feature(res, f().notes, 'notes')) return
    const inp = await decodeJSON(req, res, S.NoteInput, 'NoteInput')
    if (!inp) return
    writeJSON(res, srv.prof.createNote(inp, 'typed', ''))
  }))
  change('PATCH', '/api/notes/:id', guarded(async (req, res) => {
    if (!feature(res, f().notes, 'notes')) return
    const p = await decodeJSON(req, res, S.NotePatch, 'NotePatch')
    if (!p) return
    writeJSON(res, srv.prof.updateNote(req.params.id, p))
  }))
  change('DELETE', '/api/notes/:id', guarded((req, res) => {
    if (!feature(res, f().notes, 'notes')) return
    srv.prof.deleteNote(req.params.id)
    writeJSON(res, {status: 'deleted'})
  }))

  // ---- Voice memos ----
  get('/api/memos', guarded((req, res) => {
    if (!feature(res, f().memos, 'voice memos')) return
    const list = srv.prof.memos(q(req, 'q'), 100)
    const {used, limit} = srv.prof.memoStorage()
    writeJSON(res, {memos: list, audio_bytes: used, audio_limit: limit})
  }))
  get('/api/memos/:id/audio', guarded((req, res) => {
    if (!feature(res, f().memos, 'voice memos')) return
    const p = srv.prof.memoAudioPath(req.params.id)
    let data
    try {
      data = fs.readFileSync(p)
    } catch {
      httpError(res, 'recording not found', 404)
      return
    }
    res.set('Content-Type', 'audio/wav')
    res.send(data)
  }))
  // transcribeMemo receives raw PCM16 mono audio (?rate=, ?language=) recorded
  // on the Memos panel, transcribes it with the local Whisper servers and
  // returns the transcript for review. The audio is discarded unless keep=1.
  change('POST', '/api/memos/transcribe', async (req, res) => {
    if (!feature(res, f().memos, 'voice memos')) return
    const rate = /^[+-]?\d+$/.test(q(req, 'rate')) ? Number(q(req, 'rate')) : 0
    if (rate < 8000 || rate > 192000) {
      httpError(res, 'rate must be the recording sample rate (8000-192000)', 400)
      return
    }
    const maxSec = srv.prof.maxMemoSeconds()
    let pcm
    try {
      pcm = await readBody(req, rate * 2 * (maxSec + 1))
    } catch {
      httpError(res, `recording is longer than ${maxSec} seconds`, 413)
      return
    }
    let whisperPCM
    try {
      audio.validatePCM16(pcm, rate, maxSec)
      whisperPCM = audio.prepareWhisper(pcm, rate, maxSec)
    } catch (e) {
      httpError(res, e.message, 422)
      return
    }
    const [ctx, cancel] = srv.baseCtx.withTimeout(Math.max(srv.cfg.sttTimeout, maxSec * 1000))
    req.on('close', () => {
      if (!res.writableFinished) cancel()
    })
    const start = performance.now()
    let result
    try {
      result = await srv.stt.transcribe(ctx, whisperPCM, sttLanguage(q(req, 'language')))
    } catch (e) {
      // The page shows this text; the technical cause goes to the log.
      srv.log.warn({error: e.message}, 'memo transcription failed')
      if (isBusy(e)) httpError(res, 'Speech recognition is busy. Please try again in a moment.', 503)
      else if (hasCode(e, 'ECONNREFUSED')) httpError(res, 'Speech recognition is not running on this Mac. Start it with ./scripts/start-local.sh and try again.', 502)
      else httpError(res, 'Transcription failed. Please try again.', 502)
      return
    } finally {
      cancel()
    }
    const out = {transcript: trimSpace(result.text), language: result.language, duration_ms: Math.trunc((whisperPCM.length * 1000) / (audio.WhisperSampleRate * 2)),
      stt_ms: Math.trunc(performance.now() - start)}
    if (q(req, 'keep') === '1') out.audio_id = srv.holdAudio(audio.wav(whisperPCM, audio.WhisperSampleRate)) // explicit choice on the page
    writeJSON(res, out)
  })
  change('POST', '/api/memos', guarded(async (req, res) => {
    if (!feature(res, f().memos, 'voice memos')) return
    const b = await decodeJSON(req, res, S.MemoBody, 'memoBody')
    if (!b) return
    let wavData = null
    if (b.audio_id !== '') {
      wavData = srv.takeAudio(b.audio_id)
      if (!wavData) {
        httpError(res, 'the kept recording expired; record again or save the transcript without audio', 410)
        return
      }
    }
    writeJSON(res, srv.prof.createMemo({title: b.title, transcript: b.transcript, language: b.language, duration_ms: b.duration_ms}, wavData, ''))
  }))
  change('PATCH', '/api/memos/:id', guarded(async (req, res) => {
    if (!feature(res, f().memos, 'voice memos')) return
    const b = await decodeJSON(req, res, S.MemoPatch, 'memoPatch')
    if (!b) return
    writeJSON(res, srv.prof.updateMemo(req.params.id, b.title, b.transcript))
  }))
  change('DELETE', '/api/memos/:id', guarded((req, res) => {
    if (!feature(res, f().memos, 'voice memos')) return
    srv.prof.deleteMemo(req.params.id)
    writeJSON(res, {status: 'deleted'})
  }))

  // ---- Drafts ----
  get('/api/drafts', guarded((req, res) => {
    if (!feature(res, f().drafts, 'drafts')) return
    writeJSON(res, {drafts: srv.prof.drafts(q(req, 'kind'), 100)})
  }))
  change('POST', '/api/drafts', guarded(async (req, res) => {
    if (!feature(res, f().drafts, 'drafts')) return
    const inp = await decodeJSON(req, res, S.DraftInput, 'DraftInput')
    if (!inp) return
    writeJSON(res, srv.prof.createDraft(inp, AnyRecipient, '')) // typed by the professor
  }))
  change('PUT', '/api/drafts/:id', guarded(async (req, res) => {
    if (!feature(res, f().drafts, 'drafts')) return
    const inp = await decodeJSON(req, res, S.DraftInput, 'DraftInput')
    if (!inp) return
    writeJSON(res, srv.prof.updateDraft(req.params.id, inp))
  }))
  change('DELETE', '/api/drafts/:id', guarded((req, res) => {
    if (!feature(res, f().drafts, 'drafts')) return
    srv.prof.deleteDraft(req.params.id)
    writeJSON(res, {status: 'deleted'})
  }))
}

// goNumber formats a JSON number like Go's fmt.Sprint(float64).
function goNumber(n) {
  return Number.isInteger(n) ? String(n) : String(n)
}
