// Reminder scheduler. It sleeps until the next due time (no polling) and is
// woken when reminders change. Each occurrence is claimed with one
// conditional UPDATE, so it is notified exactly once, also across restarts:
// reminders that came due while the assistant was stopped fire once, marked
// overdue, when it starts again.
import {DateTime} from 'luxon'
import {localLayout, rfc3339} from '../utils/time.js'
import {nextOccurrence} from '../modules/professor/reminders.js'
import {defineJSON} from '../modules/professor/common.js'

export class Scheduler {
  constructor(svc) {
    this.svc = svc
    this.subs = new Map()
    this.nextID = 0
    this.wakeResolve = null
    this.wakePending = false
    this.stopped = false
    this.lateAfterMs = 2 * 60000 // a notification more than this late is marked overdue
    this.maxSleepMs = 5 * 60000 // bounds a sleep so wall-clock changes are noticed
  }

  // subscribe registers a notification callback; the returned function removes it.
  subscribe(fn) {
    const id = this.nextID++
    this.subs.set(id, fn)
    return () => this.subs.delete(id)
  }

  // wake makes the scheduler re-read the next due time.
  wake() {
    if (this.wakeResolve) {
      const r = this.wakeResolve
      this.wakeResolve = null
      r()
    } else {
      this.wakePending = true
    }
  }

  stop() {
    this.stopped = true
    this.wake()
  }

  // run fires reminders until ctx ends.
  async run(ctx) {
    while (!ctx.err && !this.stopped) {
      try {
        this.fireDue()
      } catch {
        // database closing
      }
      let wait = this.maxSleepMs
      try {
        const next = this.svc.db.prepare("SELECT COALESCE(MIN(due_at), 0) AS n FROM reminders WHERE status='active' AND fired_due != due_at").get().n
        if (next > 0) wait = Math.min(wait, Math.max(0, next * 1000 - Date.now() + 50))
      } catch {
        return
      }
      if (this.wakePending) {
        this.wakePending = false
        continue
      }
      let timer
      await Promise.race([
        new Promise(r => {
          timer = setTimeout(r, wait)
        }),
        new Promise(r => (this.wakeResolve = r)),
        ctx.done(),
      ])
      clearTimeout(timer)
      this.wakeResolve = null
      this.wakePending = false
    }
  }

  // fireDue notifies every reminder occurrence that is due and not yet fired,
  // and returns the notifications sent.
  fireDue() {
    const s = this.svc
    const now = s.nowMs()
    const nowSec = Math.floor(now / 1000)
    const list = s.db.prepare("SELECT id, due_at FROM reminders WHERE status='active' AND fired_due != due_at AND due_at <= ? ORDER BY due_at").all(nowSec)
    const sent = []
    const claim = s.db.prepare("UPDATE reminders SET fired_due=?, fired_at=?, delivery=?, due_at=?, local_time=?, updated_at=? WHERE id=? AND due_at=? AND fired_due != due_at AND status='active'")
    for (const d of list) {
      let r
      try {
        r = s.reminder(d.id)
      } catch {
        continue
      }
      const dueAt = DateTime.fromSeconds(d.due_at, {zone: s.loc})
      const late = now - dueAt.toMillis() > this.lateAfterMs
      const delivery = late ? 'overdue' : 'notified'
      let nextDue = dueAt
      if (r.recurrence !== 'none') nextDue = nextOccurrence(dueAt, r.recurrence, now) // skip occurrences missed while stopped
      // Claim this occurrence; a concurrent or repeated run affects 0 rows.
      const res = claim.run(d.due_at, nowSec, delivery, Math.floor(nextDue.toMillis() / 1000), localLayout(nextDue.setZone(s.loc)), nowSec, d.id, d.due_at)
      if (res.changes !== 1) continue
      r = s.reminder(d.id)
      const n = defineJSON({reminder: r, due: dueAt, overdue: late}, function () {
        return {reminder: this.reminder, due: rfc3339(this.due), overdue: this.overdue}
      })
      sent.push(n)
      s.log?.info({reminder_id: d.id, overdue: late}, 'reminder due') // the title is private: not logged
      for (const fn of [...this.subs.values()]) fn(n)
    }
    return sent
  }
}
