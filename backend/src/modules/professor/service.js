// Professor tools data layer: a weekly timetable, persistent reminders with a
// scheduler, notes, voice memos and email/announcement drafts, stored locally
// in one SQLite file (professor.db). Notes and memo transcripts are also
// indexed in the document index under reserved ids.
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import {DateTime} from 'luxon'
import {migrate} from '../../database/migrations/professor.js'
import {zoneOf} from '../../utils/time.js'
export {NotFoundError, isNotFound, newID, nullable, clean, escapeLike, localTime} from './common.js'
import {Scheduler} from '../../scheduler/scheduler.js'
import * as timetable from './timetable.js'
import * as reminders from './reminders.js'
import * as notes from '../notes/notes.js'
import * as memos from '../memos/memos.js'
import * as drafts from '../email/drafts.js'
import * as seed from './seed.js'

// Tables lists the professor tables, in the order the seed fills them.
export const Tables = ['classes', 'reminders', 'notes', 'memos', 'drafts']

// demoMatch selects demo rows: seed ids look like cls_seed01, note_seed07.
const demoMatch = "(id LIKE '%\\_seed%' ESCAPE '\\')"
export const isDemoID = id => id.includes('_seed')

export class ProfessorService {
  // options: {dir, zone, workdayStart, workdayEnd, memoMaxBytes, memoMaxSeconds, index, now, log}
  constructor(opts) {
    this.opts = {...opts}
    this.opts.zone = opts.zone ?? 'UTC'
    this.opts.zoneName = opts.zoneName ?? opts.zone ?? 'UTC'
    if (!this.opts.now) this.opts.now = () => Date.now()
    if (!(this.opts.workdayEnd > this.opts.workdayStart)) {
      this.opts.workdayStart = 9 * 60
      this.opts.workdayEnd = 17 * 60
    }
    if (!(this.opts.memoMaxSeconds > 0)) this.opts.memoMaxSeconds = 120
    this.opts.memoMaxBytes ??= 0
    this.log = opts.log ?? null
    this.loc = zoneOf(this.opts.zoneName)
    this.locName = this.opts.zoneName === '' ? 'UTC' : this.opts.zoneName
    fs.mkdirSync(path.join(this.opts.dir, 'memos'), {recursive: true, mode: 0o700})
    const file = path.join(this.opts.dir, 'professor.db')
    this.db = new Database(file)
    try {
      this.db.pragma('busy_timeout = 5000')
      this.db.pragma('foreign_keys = 1')
      this.db.pragma('journal_mode = WAL')
      migrate(this.db)
    } catch (e) {
      this.db.close()
      throw new Error(`initialize ${file}: ${e.message}`, {cause: e})
    }
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // best effort, like the Go service
    }
    this.sched = new Scheduler(this)
  }

  static open(opts) {
    return new ProfessorService(opts)
  }

  close() {
    this.sched.stop()
    if (this.db.open) this.db.close()
  }

  // nowMs is the service clock (replaceable in tests).
  nowMs() {
    return this.opts.now()
  }

  // now is the current time in the professor's time zone.
  now() {
    return DateTime.fromMillis(this.nowMs(), {zone: this.loc})
  }

  location() {
    return this.locName
  }

  scheduler() {
    return this.sched
  }

  maxMemoSeconds() {
    return this.opts.memoMaxSeconds
  }

  // raced reports whether err is a concurrent insert for the same action id;
  // the caller then returns the row the other insert created.
  raced(err, table, actionID) {
    if (!err || !actionID || !String(err.message).includes(`UNIQUE constraint failed: ${table}.action_id`)) return null
    return this.existingByAction(table, actionID)
  }

  // existingByAction returns the row id already created by actionID: executing
  // the same confirmed action twice returns the first result (idempotency).
  existingByAction(table, actionID) {
    if (!actionID) return null
    const r = this.db.prepare(`SELECT id FROM ${table} WHERE action_id=?`).get(actionID)
    return r ? r.id : null
  }

  counts() {
    const out = {}
    for (const t of Tables) out[t] = this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
    return out
  }

  // demoCounts returns, per table, demo rows (ids containing "_seed") and the others.
  demoCounts() {
    const demo = {}
    const other = {}
    for (const t of Tables) {
      const r = this.db.prepare(`SELECT COALESCE(SUM(${demoMatch}),0) AS d, COALESCE(SUM(NOT ${demoMatch}),0) AS o FROM ${t}`).get()
      demo[t] = r.d
      other[t] = r.o
    }
    return {demo, other}
  }

  // removeDemo deletes only demo rows (and their document-index entries).
  removeDemo() {
    let total = 0
    for (const t of Tables) {
      if (t === 'notes' || t === 'memos') {
        for (const {id} of this.db.prepare(`SELECT id FROM ${t} WHERE ${demoMatch}`).all()) this.unindex(id)
      }
      total += this.db.prepare(`DELETE FROM ${t} WHERE ${demoMatch}`).run().changes
    }
    return total
  }
}

for (const mod of [timetable, reminders, notes, memos, drafts, seed]) {
  for (const [name, fn] of Object.entries(mod.methods ?? {})) ProfessorService.prototype[name] = fn
}
