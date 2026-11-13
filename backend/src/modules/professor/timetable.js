// Weekly timetable: classes, their occurrences on a date, the next class,
// free time and CSV import/export.
import {DateTime} from 'luxon'
import {addDays, hhmm, isoWeekday, parseDateParts, rfc3339, startOfDay, validZone, wallClock, WEEKDAYS, weekdayName, ymd, zoneOf} from '../../utils/time.js'
import {clean, defineJSON, localTime, newID, NotFoundError} from './common.js'
import {parseCSV, writeCSV} from '../../utils/csv.js'

const weekdayNames = {mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7}

// parseWeekday accepts 1-7 (Monday = 1) or an English day name.
export function parseWeekday(s) {
  s = String(s).trim().toLowerCase()
  if (/^[+-]?\d+$/.test(s)) {
    const n = Number(s)
    if (n >= 1 && n <= 7) return n
  }
  if (Object.hasOwn(weekdayNames, s)) return weekdayNames[s]
  throw new Error(`invalid weekday ${JSON.stringify(s)} (use 1-7 or Monday-Sunday)`)
}

// weekdayNameOf is the English name of an ISO weekday.
export const weekdayNameOf = n => WEEKDAYS[n % 7]

// parseClock parses HH:MM (24-hour) or h:MM AM/PM into minutes after midnight.
export function parseClock(s) {
  s = String(s).trim().toUpperCase()
  let m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (m && Number(m[1]) <= 23 && Number(m[2]) <= 59) return Number(m[1]) * 60 + Number(m[2])
  m = /^(\d{1,2}):(\d{2}) ?(AM|PM)$/.exec(s) ?? /^(\d{1,2})() ?(AM|PM)$/.exec(s)
  if (m && Number(m[1]) <= 12 && (m[2] === '' || Number(m[2]) <= 59)) {
    let h = Number(m[1])
    if (m[3] === 'PM' && h < 12) h += 12
    if (m[3] === 'AM' && h === 12) h = 0
    return h * 60 + (m[2] === '' ? 0 : Number(m[2]))
  }
  if (s === '24:00') return 1440
  throw new Error(`invalid time ${JSON.stringify(s)} (use HH:MM)`)
}

export const formatClock = min => `${String(Math.trunc(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

function validDate(s) {
  if (s === '') return
  if (!parseDateParts(s)) throw new Error(`invalid date ${JSON.stringify(s)} (use YYYY-MM-DD)`)
}

function classJSON() {
  const out = {id: this.id, subject: this.subject}
  if (this.course_code) out.course_code = this.course_code
  if (this.section) out.section = this.section
  if (this.room) out.room = this.room
  Object.assign(out, {weekday: this.weekday, start: this.start, end: this.end, timezone: this.timezone})
  if (this.effective_from) out.effective_from = this.effective_from
  if (this.effective_to) out.effective_to = this.effective_to
  Object.assign(out, {active: this.active, created_at: localTime(this.createdAt), updated_at: localTime(this.updatedAt)})
  return out
}

function occurrenceJSON() {
  const out = classJSON.call(this)
  Object.assign(out, {date: this.date, starts_at: rfc3339(this.startsAt), ends_at: rfc3339(this.endsAt), status: this.status})
  if (this.overlaps?.length) out.overlaps = this.overlaps
  return out
}

function scanClass(r) {
  return defineJSON({
    id: r.id, subject: r.subject, course_code: r.course_code, section: r.section, room: r.room, weekday: r.weekday,
    start: formatClock(r.start_min), end: formatClock(r.end_min), timezone: r.timezone, effective_from: r.effective_from, effective_to: r.effective_to,
    active: r.active === 1, createdAt: r.created_at, updatedAt: r.updated_at,
  }, classJSON)
}

// matches reports whether a class matches a subject/course filter.
export function classMatches(c, filter) {
  const f = (filter ?? '').trim().toLowerCase()
  if (f === '') return true
  const cc = (c.course_code ?? '').toLowerCase()
  return c.subject.toLowerCase().includes(f) || cc === f || cc.includes(f) || (c.section ?? '').toLowerCase() === f
}

const classColumns = 'id, subject, course_code, section, room, weekday, start_min, end_min, timezone, effective_from, effective_to, active, created_at, updated_at'

export const methods = {
  // normalizeClass validates and normalizes c in place; returns [startMin, endMin].
  normalizeClass(c) {
    c.subject = clean(c.subject, 120)
    c.course_code = clean(c.course_code, 40)
    c.section = clean(c.section, 40)
    c.room = clean(c.room, 60)
    if (c.subject === '') throw new Error('subject is required')
    if (!(c.weekday >= 1 && c.weekday <= 7)) throw new Error('weekday must be 1 (Monday) to 7 (Sunday)')
    const start = parseClock(c.start ?? '')
    const end = parseClock(c.end ?? '')
    if (end <= start) throw new Error('end time must be after start time')
    if (!c.timezone) c.timezone = this.locName
    if (!validZone(c.timezone)) throw new Error(`unknown time zone ${JSON.stringify(c.timezone)}`)
    c.effective_from ??= ''
    c.effective_to ??= ''
    validDate(c.effective_from)
    validDate(c.effective_to)
    if (c.effective_from !== '' && c.effective_to !== '' && c.effective_to < c.effective_from) throw new Error('effective_to is before effective_from')
    c.start = formatClock(start)
    c.end = formatClock(end)
    return [start, end]
  },

  // addClass stores a new class.
  addClass(input) {
    const c = {...input}
    const [start, end] = this.normalizeClass(c)
    const now = Math.floor(this.nowMs() / 1000)
    c.id = newID('cls_')
    this.db.prepare(`INSERT INTO classes(${classColumns}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(c.id, c.subject, c.course_code, c.section, c.room, c.weekday, start, end, c.timezone, c.effective_from, c.effective_to, c.active ? 1 : 0, now, now)
    return this.class(c.id)
  },

  // updateClass replaces a class's fields.
  updateClass(input) {
    const c = {...input}
    const [start, end] = this.normalizeClass(c)
    const res = this.db.prepare('UPDATE classes SET subject=?, course_code=?, section=?, room=?, weekday=?, start_min=?, end_min=?, timezone=?, effective_from=?, effective_to=?, active=?, updated_at=? WHERE id=?')
      .run(c.subject, c.course_code, c.section, c.room, c.weekday, start, end, c.timezone, c.effective_from, c.effective_to, c.active ? 1 : 0, Math.floor(this.nowMs() / 1000), c.id)
    if (res.changes === 0) throw new NotFoundError()
    return this.class(c.id)
  },

  deleteClass(id) {
    if (this.db.prepare('DELETE FROM classes WHERE id=?').run(id).changes === 0) throw new NotFoundError()
  },

  class(id) {
    const r = this.db.prepare(`SELECT ${classColumns} FROM classes WHERE id=?`).get(id)
    if (!r) throw new NotFoundError()
    return scanClass(r)
  },

  // classes lists the weekly timetable ordered by weekday and start time.
  classes() {
    return this.db.prepare(`SELECT ${classColumns} FROM classes ORDER BY weekday, start_min, subject`).all().map(scanClass)
  },

  // parseDate parses YYYY-MM-DD in the professor's time zone; empty means today.
  parseDate(date) {
    if ((date ?? '').trim() === '') return startOfDay(this.now())
    const p = parseDateParts(date.trim())
    if (!p) throw new Error(`invalid date ${JSON.stringify(date)} (use YYYY-MM-DD)`)
    return DateTime.fromObject(p, {zone: this.loc})
  },

  // onDate returns the classes held on date (a day in the professor's zone),
  // with their status relative to now and any overlaps.
  onDate(date) {
    const now = this.nowMs()
    const local = date.setZone(this.loc)
    const day = ymd(local)
    const out = []
    for (const c of this.classes()) {
      if (!c.active || (c.effective_from !== '' && day < c.effective_from) || (c.effective_to !== '' && day > c.effective_to)) continue
      if (!validZone(c.timezone)) continue
      const zone = zoneOf(c.timezone)
      // The class's own wall-clock date and times, for a class defined in another zone.
      if (isoWeekday(DateTime.fromObject({year: local.year, month: local.month, day: local.day, hour: 12}, {zone})) !== c.weekday) continue
      const startsAt = wallClock(local.year, local.month, local.day, parseClock(c.start), zone).setZone(this.loc)
      const endsAt = wallClock(local.year, local.month, local.day, parseClock(c.end), zone).setZone(this.loc)
      let status = 'upcoming'
      if (!(now < endsAt.toMillis())) status = 'completed'
      else if (!(now < startsAt.toMillis())) status = 'in_progress'
      const o = defineJSON({...c, date: day, startsAt, endsAt, status, overlaps: null}, occurrenceJSON)
      out.push(o)
    }
    out.sort((a, b) => a.startsAt.toMillis() - b.startsAt.toMillis())
    for (let i = 0; i < out.length; i++) {
      for (let j = 0; j < out.length; j++) {
        if (i !== j && out[i].startsAt < out[j].endsAt && out[j].startsAt < out[i].endsAt) (out[i].overlaps ??= []).push(out[j].id)
      }
    }
    return out.length ? out : null
  },

  // nextClass returns the class in progress now (if any) and the next class
  // to start, optionally filtered by subject or course code, within 14 days.
  nextClass(filter) {
    const today = this.parseDate('')
    let current = null
    let next = null
    for (let i = 0; i < 15 && !next; i++) {
      for (const o of this.onDate(addDays(today, i)) ?? []) {
        if (!classMatches(o, filter)) continue
        if (o.status === 'in_progress' && !current) current = o
        else if (o.status === 'upcoming' && !next) next = o
      }
    }
    return {current, next}
  },

  // upcoming returns classes starting from now within the next days.
  upcoming(days) {
    if (days < 1) days = 1
    const today = this.parseDate('')
    const out = []
    for (let i = 0; i < days; i++) for (const o of this.onDate(addDays(today, i)) ?? []) if (o.status !== 'completed') out.push(o)
    return out.length ? out : null
  },

  // freeTime returns gaps of at least 15 minutes between classes on date
  // within the configured working hours (only the remaining part of today).
  freeTime(date) {
    const day = this.onDate(date)
    const local = date.setZone(this.loc)
    let cursor = wallClock(local.year, local.month, local.day, this.opts.workdayStart, this.loc)
    const end = wallClock(local.year, local.month, local.day, this.opts.workdayEnd, this.loc)
    const now = this.now()
    if (now > cursor) cursor = DateTime.fromMillis(Math.floor(now.toMillis() / 60000) * 60000, {zone: this.loc})
    let gaps = null
    const add = (from, to) => {
      if (to.toMillis() - from.toMillis() >= 15 * 60000) (gaps ??= []).push({from: hhmm(from), to: hhmm(to), minutes: Math.trunc((to.toMillis() - from.toMillis()) / 60000)})
    }
    for (const o of day ?? []) { // sorted by start; overlaps merge naturally
      if (o.startsAt > cursor) add(cursor, o.startsAt < end ? o.startsAt : end)
      if (o.endsAt > cursor) cursor = o.endsAt
    }
    if (cursor < end) add(cursor, end)
    return {gaps, classes: day}
  },

  // exportCSV writes the timetable as CSV (formula injection neutralised).
  exportCSV() {
    const rows = [csvHeader]
    for (const c of this.classes()) {
      rows.push([csvSafe(c.subject), csvSafe(c.course_code), csvSafe(c.section), csvSafe(c.room), weekdayNameOf(c.weekday), c.start, c.end, c.timezone, c.effective_from, c.effective_to, String(c.active)])
    }
    return writeCSV(rows)
  },

  // importCSV adds (or, with replace, replaces the timetable with) the classes
  // in a CSV file. It is all-or-nothing: any invalid row rejects the import.
  importCSV(text, replace) {
    let records
    try {
      records = parseCSV(text.slice(0, 1 << 20), {trimLeadingSpace: true})
    } catch (e) {
      throw new Error(`invalid CSV: ${e.message}`, {cause: e})
    }
    if (records.length < 2) throw new Error('the CSV has no rows (first line must be a header)')
    const col = new Map()
    records[0].forEach((h, i) => col.set(h.replace(/^\ufeff/, '').trim().toLowerCase(), i))
    for (const required of ['subject', 'weekday', 'start', 'end']) {
      if (!col.has(required)) throw new Error(`CSV header must include ${required} (columns: ${csvHeader.join(',')})`)
    }
    const get = (rec, name) => {
      const i = col.get(name)
      return i !== undefined && i < rec.length ? rec[i].trim().replace(/^'/, '') : ''
    }
    if (records.length > 501) throw new Error('at most 500 classes can be imported at once')
    const classes = []
    records.slice(1).forEach((rec, n) => {
      if (rec.length === 1 && rec[0].trim() === '') return
      let wd
      try {
        wd = parseWeekday(get(rec, 'weekday'))
      } catch (e) {
        throw new Error(`row ${n + 2}: ${e.message}`, {cause: e})
      }
      const c = {subject: get(rec, 'subject'), course_code: get(rec, 'course_code'), section: get(rec, 'section'), room: get(rec, 'room'), weekday: wd,
        start: get(rec, 'start'), end: get(rec, 'end'), timezone: get(rec, 'timezone'), effective_from: get(rec, 'effective_from'), effective_to: get(rec, 'effective_to'), active: true}
      const a = get(rec, 'active')
      if (a !== '') {
        const b = {1: true, t: true, T: true, true: true, TRUE: true, True: true, 0: false, f: false, F: false, false: false, FALSE: false, False: false}[a]
        if (b === undefined) throw new Error(`row ${n + 2}: active must be true or false`)
        c.active = b
      }
      try {
        this.normalizeClass(c)
      } catch (e) {
        throw new Error(`row ${n + 2}: ${e.message}`, {cause: e})
      }
      classes.push(c)
    })
    const now = Math.floor(this.nowMs() / 1000)
    const insert = this.db.prepare(`INSERT INTO classes(${classColumns}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    this.db.transaction(() => {
      if (replace) this.db.prepare('DELETE FROM classes').run()
      for (const c of classes) {
        insert.run(newID('cls_'), c.subject, c.course_code, c.section, c.room, c.weekday, parseClock(c.start), parseClock(c.end), c.timezone, c.effective_from, c.effective_to, c.active ? 1 : 0, now, now)
      }
    })()
    return classes.length
  },
}

// CSV columns for import and export.
export const csvHeader = ['subject', 'course_code', 'section', 'room', 'weekday', 'start', 'end', 'timezone', 'effective_from', 'effective_to', 'active']

// csvSafe prevents spreadsheet formula injection when the export is opened in Excel.
const csvSafe = v => (v !== '' && '=+-@\t\r'.includes(v[0]) ? "'" + v : v)

export {weekdayName}
