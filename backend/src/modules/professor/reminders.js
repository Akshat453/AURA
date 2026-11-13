// Persistent reminders. local_time/due_at describe the next occurrence;
// recurring reminders advance after each notification.
import {DateTime} from 'luxon'
import {fields} from '../../utils/gotext.js'
import {goWeekday, localLayout, parseLocalParts, rfc3339, shortDateTime} from '../../utils/time.js'
import {clean, defineJSON, escapeLike, localTime, newID, NotFoundError, nullable} from './common.js'

function validRecurrence(r) {
  r = (r ?? '').trim().toLowerCase()
  if (r === '' || r === 'none' || r === 'once') return 'none'
  if (r === 'daily' || r === 'weekdays' || r === 'weekly') return r
  throw new Error(`recurrence must be none, daily, weekdays or weekly (got ${JSON.stringify(r)})`)
}

const isWeekend = t => goWeekday(t) === 6 || goWeekday(t) === 0

// nextOccurrence is the first occurrence of a recurring reminder strictly
// after `after` (epoch ms or DateTime), keeping the same wall-clock time.
export function nextOccurrence(t, recurrence, after) {
  if (recurrence === 'none') return t
  const limit = typeof after === 'number' ? after : after.toMillis()
  for (let i = 0; !(t.toMillis() > limit) && i < 4000; i++) {
    if (recurrence === 'daily') t = t.plus({days: 1})
    else if (recurrence === 'weekly') t = t.plus({days: 7})
    else if (recurrence === 'weekdays') {
      t = t.plus({days: 1})
      while (isWeekend(t)) t = t.plus({days: 1})
    }
  }
  return t
}

function reminderJSON() {
  const out = {id: this.id, title: this.title}
  if (this.description) out.description = this.description
  Object.assign(out, {local_time: this.local_time, timezone: this.timezone, due_at: rfc3339(this.dueAt), recurrence: this.recurrence, status: this.status,
    delivery: this.delivery, overdue: this.overdue})
  if (this.firedAt > 0) out.fired_at = localTime(this.firedAt)
  if (this.completedAt > 0) out.completed_at = localTime(this.completedAt)
  out.created_at = localTime(this.createdAt)
  out.updated_at = localTime(this.updatedAt)
  return out
}

const reminderColumns = 'id, title, description, local_time, timezone, due_at, recurrence, status, delivery, fired_at, completed_at, created_at, updated_at'

export const methods = {
  // parseLocal parses a wall-clock date and time in the professor's zone.
  // Seconds and a trailing zone are rejected: the model must send local time.
  parseLocal(v) {
    v = String(v ?? '').trim().replace(' ', 'T')
    let p = parseLocalParts(v)
    if (!p) {
      const s = parseLocalParts(v, true)
      if (s && s.second === 0) p = s
    }
    if (!p) throw new Error(`invalid date and time ${JSON.stringify(v)}: use YYYY-MM-DDTHH:MM in ${this.locName}`)
    return DateTime.fromObject(p, {zone: this.loc})
  },

  // validateDue checks that a reminder time is in the future and within two years.
  validateDue(t) {
    const now = this.nowMs()
    if (t.toMillis() < now - 60000) {
      throw new Error(`${shortDateTime(t.setZone(this.loc))} is in the past (it is now ${shortDateTime(this.now())}); ask the user for a future time`)
    }
    if (t.toMillis() > DateTime.fromMillis(now, {zone: this.loc}).plus({years: 2}).toMillis()) throw new Error('reminders can be at most two years ahead')
  },

  // prepareReminder validates input without storing it (before asking the
  // user to confirm, and again right before executing). Returns {input, due}.
  prepareReminder(input) {
    const inp = {...input}
    inp.title = clean(inp.title, 200)
    inp.description = clean(inp.description, 1000)
    if (inp.title === '') throw new Error('title is required')
    let due = this.parseLocal(inp.due)
    this.validateDue(due)
    inp.recurrence = validRecurrence(inp.recurrence)
    if (inp.recurrence === 'weekdays' && isWeekend(due)) due = nextOccurrence(due, 'weekdays', due)
    inp.due = localLayout(due)
    return {input: inp, due}
  },

  scanReminder(r) {
    const dueAt = DateTime.fromSeconds(r.due_at, {zone: this.loc})
    const rem = {
      id: r.id, title: r.title, description: r.description, local_time: r.local_time, timezone: r.timezone, dueAt, recurrence: r.recurrence,
      status: r.status, delivery: r.delivery, firedAt: r.fired_at, completedAt: r.completed_at, createdAt: r.created_at, updatedAt: r.updated_at,
    }
    rem.overdue = rem.status === 'active' && rem.recurrence === 'none' && !(dueAt.toMillis() > this.nowMs())
    return defineJSON(rem, reminderJSON)
  },

  // createReminder stores a reminder. With an action id it is idempotent: a
  // second call for the same confirmed action returns the first reminder.
  createReminder(input, actionID = '') {
    const existing = this.existingByAction('reminders', actionID)
    if (existing) return this.reminder(existing)
    const {input: inp, due} = this.prepareReminder(input)
    const now = Math.floor(this.nowMs() / 1000)
    const id = newID('rem_')
    try {
      this.db.prepare('INSERT INTO reminders(id, title, description, local_time, timezone, due_at, recurrence, action_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, inp.title, inp.description, inp.due, this.locName, Math.floor(due.toMillis() / 1000), inp.recurrence, nullable(actionID), now, now)
    } catch (e) {
      const first = this.raced(e, 'reminders', actionID)
      if (first) return this.reminder(first)
      throw e
    }
    this.sched.wake()
    return this.reminder(id)
  },

  reminder(id) {
    const r = this.db.prepare(`SELECT ${reminderColumns} FROM reminders WHERE id=?`).get(id)
    if (!r) throw new NotFoundError()
    return this.scanReminder(r)
  },

  // prepareReminderPatch validates a patch against the stored reminder.
  // patch fields are undefined when unchanged. Returns {reminder, patch}.
  prepareReminderPatch(id, patch) {
    const r = this.reminder(id)
    const p = {...patch}
    if (p.title !== undefined && p.title !== null) {
      p.title = clean(p.title, 200)
      if (p.title === '') throw new Error('title cannot be empty')
    }
    if (p.description !== undefined && p.description !== null) p.description = clean(p.description, 1000)
    if (p.recurrence !== undefined && p.recurrence !== null) p.recurrence = validRecurrence(p.recurrence)
    if (p.due !== undefined && p.due !== null) {
      const due = this.parseLocal(p.due)
      this.validateDue(due)
      p.due = localLayout(due)
    }
    const set = k => p[k] !== undefined && p[k] !== null
    if (!set('title') && !set('description') && !set('recurrence') && !set('due') && !set('completed')) throw new Error('nothing to change')
    return {reminder: r, patch: p}
  },

  // updateReminder applies a patch. Changing the time re-arms the notification.
  updateReminder(id, patch) {
    const {reminder: r, patch: p} = this.prepareReminderPatch(id, patch)
    const set = k => p[k] !== undefined && p[k] !== null
    if (set('title')) r.title = p.title
    if (set('description')) r.description = p.description
    if (set('recurrence')) r.recurrence = p.recurrence
    let due = r.dueAt
    let rearm = false
    if (set('due')) {
      due = this.parseLocal(p.due)
      rearm = true
    }
    let status = r.status
    let completed = r.completedAt
    if (set('completed')) {
      if (p.completed) {
        status = 'completed'
        completed = Math.floor(this.nowMs() / 1000)
      } else {
        status = 'active'
        completed = 0
        rearm = true
      }
    }
    if (rearm && r.recurrence !== 'none') due = nextOccurrence(due, r.recurrence, this.nowMs() - 60000)
    let q = 'UPDATE reminders SET title=?, description=?, recurrence=?, local_time=?, due_at=?, status=?, completed_at=?, updated_at=?'
    if (rearm) q += ", delivery='pending', fired_due=0"
    q += ' WHERE id=?'
    this.db.prepare(q).run(r.title, r.description, r.recurrence, localLayout(due.setZone(this.loc)), Math.floor(due.toMillis() / 1000), status, completed, Math.floor(this.nowMs() / 1000), id)
    this.sched.wake()
    return this.reminder(id)
  },

  deleteReminder(id) {
    if (this.db.prepare('DELETE FROM reminders WHERE id=?').run(id).changes === 0) throw new NotFoundError()
    this.sched.wake()
  },

  // reminders selects by scope (all, today, upcoming, overdue, completed) and
  // words in the title or description.
  reminders({scope = '', query = '', limit = 0} = {}) {
    let q = `SELECT ${reminderColumns} FROM reminders WHERE 1=1`
    const args = []
    const now = Math.floor(this.nowMs() / 1000)
    const today = this.parseDate('')
    switch (scope) {
      case '':
      case 'all':
        break
      case 'today':
        q += " AND status='active' AND due_at >= ? AND due_at < ?"
        args.push(Math.floor(today.toMillis() / 1000), Math.floor(today.plus({days: 1}).toMillis() / 1000))
        break
      case 'upcoming':
        q += " AND status='active' AND due_at > ?"
        args.push(now)
        break
      case 'overdue':
        q += " AND status='active' AND recurrence='none' AND due_at <= ?"
        args.push(now)
        break
      case 'completed':
        q += " AND status='completed'"
        break
      default:
        throw new Error('scope must be all, today, upcoming, overdue or completed')
    }
    const words = fields((query ?? '').toLowerCase()).slice(0, 6)
    for (const w of words) {
      q += " AND (lower(title) LIKE ? ESCAPE '\\' OR lower(description) LIKE ? ESCAPE '\\')"
      const like = '%' + escapeLike(w) + '%'
      args.push(like, like)
    }
    q += ' ORDER BY status, due_at'
    if (limit <= 0 || limit > 200) limit = 200
    q += ` LIMIT ${limit}`
    return this.db.prepare(q).all(...args).map(r => this.scanReminder(r))
  },
}
