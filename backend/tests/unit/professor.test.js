// Professor data: timetable, reminders, scheduler, notes, memos, drafts, seed
// (port of the Go professor tests).
import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {DateTime} from 'luxon'
import {Context} from '../../src/utils/context.js'
import {hhmm, rfc3339Seconds} from '../../src/utils/time.js'
import {ProfessorService, Tables} from '../../src/modules/professor/service.js'
import {nextOccurrence} from '../../src/modules/professor/reminders.js'
import {indexID} from '../../src/modules/notes/notes.js'
import {AnyRecipient} from '../../src/modules/email/drafts.js'
import {ambiguousTime} from '../../src/modules/professor/say.js'
import {ProfessorTurn} from '../../src/modules/professor/tools.js'
import {Session as Actions} from '../../src/modules/actions/actions.js'
import {NotePrefix, ScopeNotes, Service as RAGService} from '../../src/services/rag/service.js'
import {HindiWordEmbedder} from '../helpers/fakes.js'
import {Clock, tmpDir} from '../helpers/env.js'

const ist = 'Asia/Kolkata'
const at = (y, mo, d, h, mi = 0, s = 0) => DateTime.fromObject({year: y, month: mo, day: d, hour: h, minute: mi, second: s}, {zone: ist}).toMillis()
const monday0930 = at(2026, 10, 19, 9, 30) // Monday 19 October 2026, 09:30 IST

function open(t, dir, clock, index = null) {
  const s = ProfessorService.open({dir, zoneName: ist, now: clock.now, index, memoMaxBytes: 1 << 20, workdayStart: 540, workdayEnd: 1020})
  t.after(() => s.db.open && s.close())
  return s
}

function newService(t) {
  const clock = new Clock(monday0930)
  return {s: open(t, tmpDir(), clock), clock}
}

const mustClass = (s, c) => s.addClass({...c, active: true})

test('timetable: today, tomorrow, next class, overlaps, free time, weekend', t => {
  const {s, clock} = newService(t)
  const dbms = mustClass(s, {subject: 'Database Management Systems', course_code: 'CS-301', section: 'A', room: 'LH-2', weekday: 1, start: '10:00', end: '11:00'})
  mustClass(s, {subject: 'Computer Networks', course_code: 'CS-305', weekday: 1, start: '09:00', end: '09:50'})
  const lab = mustClass(s, {subject: 'DBMS Lab', course_code: 'CS-391', weekday: 1, start: '10:30', end: '12:30'})
  mustClass(s, {subject: 'Operating Systems', course_code: 'CS-302', weekday: 2, start: '11:00', end: '12:00'})
  const today = s.parseDate('')
  const day = s.onDate(today)
  assert.equal(day.length, 3)
  assert.equal(day[0].status, 'in_progress')
  assert.equal(day[1].status, 'upcoming')
  assert.deepEqual(day[1].overlaps, [lab.id])
  const tue = s.onDate(s.parseDate('2026-10-20'))
  assert.ok(tue.length === 1 && tue[0].course_code === 'CS-302')
  let {current, next} = s.nextClass('')
  assert.ok(current?.course_code === 'CS-305' && next?.id === dbms.id && next.date === '2026-10-19')
  clock.t = at(2026, 10, 19, 10, 45)
  ;({current, next} = s.nextClass(''))
  assert.ok(current?.id === dbms.id && next?.course_code === 'CS-302' && next.date === '2026-10-20')
  assert.equal(s.nextClass('cs-301').next.date, '2026-10-26')
  const {gaps} = s.freeTime(today)
  assert.deepEqual(gaps, [{from: '12:30', to: '17:00', minutes: 270}])
  assert.equal(s.onDate(s.parseDate('2026-10-24')), null)
})

test('timetable: empty, updates, inactive, invalid, effective dates, other time zone', t => {
  const {s} = newService(t)
  assert.deepEqual(s.nextClass(''), {current: null, next: null})
  const c = mustClass(s, {subject: 'DBMS', weekday: 3, start: '14:00', end: '15:00'})
  s.updateClass({...c, start: '15:00', end: '16:00', room: 'LH-9'})
  const n = s.nextClass('').next
  assert.ok(n.start === '15:00' && n.room === 'LH-9')
  s.updateClass({...c, start: '15:00', end: '16:00', active: false})
  assert.equal(s.nextClass('').next, null)
  assert.throws(() => s.addClass({subject: 'X', weekday: 1, start: '11:00', end: '10:00'}))
  mustClass(s, {subject: 'Elective', weekday: 1, start: '16:00', end: '17:00', effective_from: '2026-11-01'})
  assert.equal(s.onDate(s.now()), null)
  mustClass(s, {subject: 'Guest lecture', weekday: 1, start: '08:00', end: '09:00', timezone: 'Europe/London'})
  const d = s.onDate(s.now())
  assert.ok(d.length === 1 && hhmm(d[0].startsAt) === '12:30', 'London 08:00 BST = 12:30 IST')
})

test('timetable CSV: import, all-or-nothing, export, round trip, formula injection', t => {
  const {s} = newService(t)
  assert.equal(s.importCSV('﻿subject,course_code,section,room,weekday,start,end\nDBMS,CS-301,A,LH-2,Monday,10:00,11:00\nNetworks,CS-305,B,LH-4,wed,2:00 PM,3:00 PM\n', false), 2)
  const classes = s.classes()
  assert.ok(classes.length === 2 && classes[1].start === '14:00' && classes[1].weekday === 3)
  assert.throws(() => s.importCSV('subject,weekday,start,end\nA,Monday,10:00,11:00\nB,Funday,10:00,11:00\n', false), /row 3/)
  assert.equal(s.classes().length, 2)
  const csv = s.exportCSV()
  assert.ok(csv.includes('Networks,CS-305,B,LH-4,Wednesday,14:00,15:00'), csv)
  assert.equal(s.importCSV(csv, true), 2)
  assert.equal(s.classes().length, 2)
  mustClass(s, {subject: '=HYPERLINK("http://x")', weekday: 2, start: '09:00', end: '10:00'})
  assert.ok(!s.exportCSV().includes('\n=HYPERLINK'))
})

test('reminders: validation, idempotent action ids, recurrence, overdue, query, delete', t => {
  const {s, clock} = newService(t)
  assert.throws(() => s.createReminder({title: 'past', due: '2026-10-19T08:00'}), /in the past/)
  assert.throws(() => s.createReminder({title: 'bad', due: 'tomorrow 10am'}))
  let r = s.createReminder({title: 'Submit attendance', due: '2026-10-21T10:00'}, 'act_1')
  assert.equal(rfc3339Seconds(r.dueAt), '2026-10-21T10:00:00+05:30')
  assert.equal(r.recurrence, 'none')
  const again = s.createReminder({title: 'Submit attendance', due: '2026-10-21T10:00'}, 'act_1')
  assert.equal(again.id, r.id)
  assert.equal(s.reminders({}).length, 1)
  r = s.updateReminder(r.id, {due: '2026-10-21T11:30'})
  assert.equal(r.local_time, '2026-10-21T11:30')
  const w = s.createReminder({title: 'Check mail', due: '2026-10-24T09:00', recurrence: 'weekdays'})
  assert.equal(w.local_time, '2026-10-26T09:00')
  const fri = DateTime.fromObject({year: 2026, month: 10, day: 23, hour: 9}, {zone: ist})
  assert.equal(nextOccurrence(fri, 'weekdays', fri).weekday, 1)
  clock.t = at(2026, 10, 22, 9)
  let over = s.reminders({scope: 'overdue'})
  assert.ok(over.length === 1 && over[0].overdue)
  s.updateReminder(r.id, {completed: true})
  assert.equal(s.reminders({scope: 'overdue'}).length, 0)
  assert.equal(s.reminders({query: 'MAIL'}).length, 1)
  s.deleteReminder(w.id)
  assert.throws(() => s.deleteReminder(w.id), /not found/)
})

test('scheduler fires once and recovers missed reminders after a restart', t => {
  const dir = tmpDir()
  const clock = new Clock(monday0930)
  const s = open(t, dir, clock)
  const once = s.createReminder({title: 'Check assignments', due: '2026-10-20T17:00'})
  const daily = s.createReminder({title: 'Attendance', due: '2026-10-20T10:00', recurrence: 'daily'})
  let got = []
  s.scheduler().subscribe(n => got.push(n))
  assert.equal(s.scheduler().fireDue().length, 0)
  clock.t = at(2026, 10, 20, 10, 0, 30)
  s.scheduler().fireDue()
  s.scheduler().fireDue()
  assert.ok(got.length === 1 && got[0].reminder.id === daily.id && !got[0].overdue)
  assert.equal(s.reminder(daily.id).local_time, '2026-10-21T10:00')
  s.close()
  clock.t = at(2026, 10, 23, 8)
  const s2 = open(t, dir, clock)
  got = []
  s2.scheduler().subscribe(n => got.push(n))
  s2.scheduler().fireDue()
  assert.equal(got.length, 2)
  assert.ok(got.every(n => n.overdue))
  assert.equal(s2.reminder(daily.id).local_time, '2026-10-23T10:00', 'missed occurrences are skipped, not replayed')
  const o = s2.reminder(once.id)
  assert.ok(o.delivery === 'overdue' && o.overdue)
  got = []
  s2.scheduler().fireDue()
  assert.equal(got.length, 0)
})

test('scheduler run loop wakes without polling', async t => {
  const clock = new Clock(Date.now())
  const s = open(t, tmpDir(), clock)
  const [ctx, cancel] = Context.background().withCancel()
  t.after(cancel)
  const fired = new Promise(r => s.scheduler().subscribe(r))
  s.scheduler().run(ctx)
  const due = Math.ceil((Date.now() + 1500) / 60000) * 60000
  clock.t = due - 1000
  s.createReminder({title: 'soon', due: DateTime.fromMillis(due, {zone: ist}).toFormat("yyyy-MM-dd'T'HH:mm")})
  clock.t = due
  s.scheduler().wake()
  const n = await Promise.race([fired, new Promise((_, rej) => setTimeout(() => rej(new Error('scheduler did not fire')), 5000))])
  assert.equal(n.reminder.title, 'soon')
})

function ragService(t) {
  const docs = new RAGService({dir: path.join(tmpDir(), 'rag'), maxUploadBytes: 1 << 20, chunkTokens: 120, chunkOverlap: 10, topK: 5, hybrid: true, minSimilarity: 0.1}, new HindiWordEmbedder(), null, null)
  const [ctx, cancel] = Context.background().withCancel()
  docs.run(ctx)
  t.after(() => {
    cancel()
    docs.close()
  })
  return docs
}

async function waitIndexed(docs, id, want) {
  for (let i = 0; i < 300; i++) {
    let ready = false
    let exists = true
    try {
      ready = docs.store.document(id).status === 'ready'
    } catch {
      exists = false
    }
    if (ready === want && (want || !exists)) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`index state of ${id} never became ${want}`)
}

test('notes: CRUD, Hindi semantic search, index kept in sync', async t => {
  const docs = ragService(t)
  const s = open(t, tmpDir(), new Clock(monday0930), docs)
  const n = s.createNote({body: "I need to revise normalization before Friday's DBMS class.", tags: ['#DBMS', 'revision, dbms']}, 'assistant', 'act_n1')
  assert.ok(n.title && n.tags.length === 2)
  const other = s.createNote({title: 'Networks lab', body: 'Check router configs for the TCP lab.'}, 'typed', '')
  await waitIndexed(docs, indexID(n.id), true)
  await waitIndexed(docs, indexID(other.id), true)
  assert.equal(docs.uploads().length, 0)
  const res = await s.searchNotes(Context.background(), 'नॉर्मलाइजेशन दोहराना', '', 3)
  assert.ok(res.hits.length && res.hits[0].id === n.id && res.hits[0].match === 'semantic', JSON.stringify(res))
  const all = await docs.search(Context.background(), 'revise normalization', '', 3)
  assert.ok(all.hits[0].document.startsWith('Note: '))
  assert.equal(s.notes({tag: 'dbms'}).length, 1)
  assert.equal(s.notes({date: '2026-10-19'}).length, 2)
  s.updateNote(n.id, {body: 'Indexing: B+ trees and hash indexes for the midterm.'})
  for (let i = 0; ; i++) {
    const r = await docs.search(Context.background(), 'B+ trees hash indexes', ScopeNotes, 1)
    if (r.hits?.length && r.hits[0].text.includes('B+ trees')) break
    if (i === 300) assert.fail('updated note never indexed')
    await new Promise(r2 => setTimeout(r2, 10))
  }
  const counts = docs.store.countChunks(indexID(n.id))
  assert.ok(counts.chunks === 1 && counts.vectors === 1)
  s.deleteNote(n.id)
  await waitIndexed(docs, indexID(n.id), false)
  assert.deepEqual(docs.store.countChunks(indexID(n.id)), {chunks: 0, fts: 0, vectors: 0})
  assert.throws(() => s.note(n.id), /not found/)
})

test('reconcile repairs the index after a crash between the two writes', async t => {
  const docs = ragService(t)
  const dir = tmpDir()
  const clock = new Clock(monday0930)
  let s = open(t, dir, clock)
  const n = s.createNote({body: 'Exam blueprint review'}, 'typed', '')
  s.close()
  docs.putText(null, NotePrefix + 'deadbeefdeadbeef', 'Note: orphan', 'orphan text')
  s = open(t, dir, clock, docs)
  s.reconcile()
  await waitIndexed(docs, indexID(n.id), true)
  await waitIndexed(docs, NotePrefix + 'deadbeefdeadbeef', false)
})

test('memos keep audio only when asked and respect storage limits', t => {
  const {s} = newService(t)
  let m = s.createMemo({transcript: 'Ask the lab assistant to reset the switches.', language: 'en', duration_ms: 4000}, null, '')
  assert.equal(m.hasAudio, false)
  assert.throws(() => s.memoAudioPath(m.id))
  const wavData = Buffer.alloc(600 << 10)
  const a = s.createMemo({transcript: 'kept', duration_ms: 1000}, wavData, '')
  assert.ok(a.hasAudio)
  assert.throws(() => s.createMemo({transcript: 'too much'}, wavData, ''), /storage is full/)
  const p = s.memoAudioPath(a.id)
  assert.equal(fs.statSync(p).mode & 0o777, 0o600)
  s.deleteMemo(a.id)
  assert.throws(() => s.memoAudioPath(a.id), /not found/)
  assert.ok(!fs.existsSync(p))
  m = s.updateMemo(m.id, null, 'Ask the lab assistant to reset the core switches.')
  assert.equal(m.transcript, 'Ask the lab assistant to reset the core switches.')
})

test('drafts never invent recipients; announcements have no recipients', t => {
  const {s} = newService(t)
  const said = 'Draft an email to coordinator@college.edu about the timetable change'
  assert.throws(() => s.createDraft({kind: 'email', subject: 'Timetable', body: 'Dear coordinator', to: ['dean@college.edu']}, said, ''), /never invent/)
  assert.throws(() => s.createDraft({kind: 'email', subject: 'x', body: 'y', to: ['not-an-address']}, AnyRecipient, ''))
  let d = s.createDraft({kind: 'email', subject: 'Timetable change', body: 'Dear coordinator,\n…', to: ['Coordinator@College.edu']}, said, 'act_d')
  assert.equal(d.recipients.to.length, 1)
  assert.equal(s.createDraft({kind: 'email', subject: 'Timetable change', body: 'x', to: ['coordinator@college.edu']}, said, 'act_d').id, d.id)
  d = s.updateDraft(d.id, {subject: 'Timetable change (revised)', body: 'Edited', to: ['anyone@college.edu']})
  assert.ok(d.kind === 'email' && d.body === 'Edited')
  assert.throws(() => s.createDraft({kind: 'announcement', subject: 'Quiz', body: 'Quiz on Friday', to: ['a@b.co']}, AnyRecipient, ''))
  assert.equal(s.drafts('email', 0).length, 1)
})

test('ambiguous clock times are detected in English, Hinglish and Hindi', () => {
  const cases = {
    'Remind me to call the lab assistant at 5.': true, 'remind me at 10:30 to print': true, 'kal 5 baje meeting yaad dilana': true, 'कल 5 बजे मीटिंग याद दिलाना': true,
    'I am free, remind me at 5': true, "at 5 o'clock": true,
    'remind me at 5 PM': false, 'at 10 a.m. tomorrow': false, 'at 5 in the evening': false, 'kal subah 10 baje': false, 'कल शाम 5 बजे': false, 'कल सुभा 11 बजे लैब मिटिंग याद दलाना': false,
    'at 17:00': false, 'at 09:30': false, 'in 5 minutes': false, '30 minutes before my next DBMS lecture': false, 'tomorrow at 15:45': false, 'at 5pm': false,
  }
  for (const [input, want] of Object.entries(cases)) assert.equal(ambiguousTime(input) !== null, want, input)
})

test('list_reminders widens the scope when a query matches nothing', async t => {
  const {s} = newService(t)
  s.createReminder({title: 'Submit attendance', due: '2026-10-20T10:00'})
  const [tool] = new ProfessorTurn({svc: s, actions: new Actions(60000)}).tools(['list_reminders'])
  const res = await tool.run(Context.background(), {scope: 'today', query: 'attendance'})
  assert.ok(res.count === 1 && res.scope === 'all' && res.note)
})

test('seed is idempotent and keeps the professor\'s own rows', t => {
  const {s} = newService(t)
  const mine = mustClass(s, {subject: 'My own class', weekday: 7, start: '08:00', end: '08:30'})
  const first = s.seed()
  s.seed()
  const counts = s.counts()
  for (const table of Tables) assert.equal(counts[table], first[table] + (table === 'classes' ? 1 : 0), table)
  assert.ok(s.class(mine.id))
  for (let d = 0; d < 7; d++) for (const o of s.onDate(s.now().plus({days: d})) ?? []) assert.ok(!(o.overlaps?.length && o.id.includes('seed')))
  assert.ok(s.reminders({scope: 'all', limit: 100}).length >= 20)
  assert.ok(s.drafts('', 100).length >= 10)
  assert.ok(s.notes({query: 'normalization', limit: 5}).length > 0)
  assert.equal(s.removeDemo(), first.classes + first.reminders + first.notes + first.memos + first.drafts)
  assert.ok(s.class(mine.id))
})
