// Professor tools: dashboard, timetable, reminders, notes, voice memos,
// drafts and the optional Google account. Every change made here is an
// explicit action on the page; deleting always asks first.
import {loadWorklet} from './capture.js'
import {$, el, icon, api, json, button, toast, emptyState, openDialog, confirmDialog, field, registerView, on, emit, state, feature, latest} from './ui.js'

const dayGuard = latest(), weekGuard = latest(), remGuard = latest(), memoGuard = latest(), draftGuard = latest()
import {ymd, longDate, clock12, clockRange, dayLabel, dueLabel, greeting, timeAgo, formatBytes} from './format.js'
import {mailHandoff} from './mailhandoff.js'

const tz = () => state.prof.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
const today = () => ymd(new Date(), tz())
const days = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const go = hash => { location.hash = hash }

// ======================= Dashboard =======================
async function showDashboard() {
  const now = new Date()
  const hour = Number(new Intl.DateTimeFormat('en-GB', {timeZone: tz(), hour: 'numeric', hourCycle: 'h23'}).format(now))
  $('dashGreeting').textContent = `${greeting(hour)}, Professor`
  $('dashDate').textContent = `${longDate(now, tz())}${state.prof.enabled ? '' : ' · Professor tools are disabled on this server'}`
  const jobs = []
  if (feature('timetable')) jobs.push(dashToday(), dashNext())
  if (feature('reminders')) jobs.push(dashReminders())
  if (feature('notes')) jobs.push(dashNotes())
  await Promise.allSettled(jobs)
}

function classRow(o) {
  const status = {in_progress: el('span', {class: 'badge accent', text: 'Now'}), completed: el('span', {class: 'badge', text: 'Done'}), upcoming: null}[o.status]
  return el('li', {class: o.status},
    el('div', {class: 'time-col'}, el('strong', {text: clock12(o.start)}), el('small', {text: `to ${clock12(o.end)}`})),
    el('div', {class: 'grow'}, el('div', {class: 'title', text: o.subject}),
      el('div', {class: 'meta', text: [o.course_code, o.section && `Section ${o.section}`, o.room].filter(Boolean).join(' · ') || 'No room set'})),
    el('div', {class: 'row', style: 'gap:6px'}, o.overlaps?.length ? el('span', {class: 'badge warning', text: 'Overlaps'}) : null, status))
}

async function dashToday() {
  const box = $('dashToday')
  try {
    const [d, all] = await Promise.all([api(`/api/timetable/day?date=${today()}`), api('/api/timetable')])
    box.className = ''
    if (!all.classes.length) {
      box.replaceChildren(emptyState('calendar', 'Your timetable is empty', 'Add your weekly classes once — the assistant then answers “what is my next lecture?” from them.',
        button('Add your first class', () => go('#/timetable/new'), {cls: 'btn primary sm', iconName: 'plus'})))
      return
    }
    box.replaceChildren(d.classes.length ? el('ul', {class: 'list today-list'}, ...d.classes.map(classRow))
      : emptyState('calendar', 'No classes today', `Nothing scheduled on ${d.weekday}.${d.free?.length ? ' Your working hours are free.' : ''}`))
    if (d.classes.length && d.free?.length) box.append(el('p', {class: 'small muted', style: 'margin-top:10px', text: `Free: ${d.free.map(g => `${clock12(g.from)}–${clock12(g.to)}`).join(', ')}`}))
  } catch (e) { box.className = ''; box.replaceChildren(el('p', {class: 'error-text', text: e.message})) }
}

async function dashNext() {
  const box = $('dashNext')
  try {
    const r = await api('/api/timetable/next')
    const o = r.in_progress || r.next
    box.className = ''
    if (!o) { box.replaceChildren(emptyState('clock', 'No upcoming lecture', 'Nothing in the next 14 days.')); return }
    const label = r.in_progress ? 'Now' : dayLabel(o.date, today())
    const mins = Math.round((new Date(o.starts_at) - Date.now()) / 60000)
    box.replaceChildren(el('div', {class: 'next-card'},
      el('div', {class: 'when'}, el('small', {text: label}), el('strong', {text: clock12(o.start)})),
      el('div', {class: 'grow'}, el('div', {class: 'title', style: 'font-weight:600', text: o.subject}),
        el('div', {class: 'small muted', text: [o.course_code, o.section && `Section ${o.section}`, o.room].filter(Boolean).join(' · ')}),
        el('div', {class: 'small', style: 'margin-top:4px;color:var(--accent)', text: r.in_progress ? `Ends at ${clock12(o.end)}` : mins < 120 && mins >= 0 ? `Starts in ${mins} min` : `${clock12(o.start)} – ${clock12(o.end)}`}))))
    if (r.in_progress && r.next) box.append(el('p', {class: 'small muted', style: 'margin-top:12px', text: `Next: ${r.next.subject}, ${dayLabel(r.next.date, today())} at ${clock12(r.next.start)}`}))
  } catch (e) { box.className = ''; box.replaceChildren(el('p', {class: 'error-text', text: e.message})) }
}

async function dashReminders() {
  const box = $('dashReminders')
  try {
    const [up, over] = await Promise.all([api('/api/reminders?scope=upcoming'), api('/api/reminders?scope=overdue')])
    overdueBadge(over.reminders.length)
    box.className = ''
    const list = [...over.reminders, ...up.reminders].slice(0, 5)
    if (!list.length) {
      box.replaceChildren(emptyState('bell', 'No upcoming reminders', 'Say “remind me to submit attendance tomorrow at 10 AM” or add one here.',
        button('Add reminder', () => go('#/reminders/new'), {cls: 'btn sm', iconName: 'plus'})))
      return
    }
    box.replaceChildren(el('ul', {class: 'list'}, ...list.map(r => reminderItem(r, true))))
  } catch (e) { box.className = ''; box.replaceChildren(el('p', {class: 'error-text', text: e.message})) }
}

async function dashNotes() {
  const box = $('dashNotes')
  try {
    const r = await api('/api/notes')
    box.className = ''
    if (!r.notes.length) { box.replaceChildren(emptyState('note', 'No notes yet', 'Say “save a note…” or write one in Notes.', button('Add note', () => go('#/notes/new'), {cls: 'btn sm', iconName: 'plus'}))); return }
    box.replaceChildren(el('ul', {class: 'list'}, ...r.notes.slice(0, 4).map(n => el('li', {},
      el('div', {class: 'grow'}, el('a', {class: 'title', href: `#/notes/${n.id}`, text: n.title}), el('div', {class: 'meta clamp', text: n.body}), el('div', {class: 'meta', text: timeAgo(n.updated_at)}))))))
  } catch (e) { box.className = ''; box.replaceChildren(el('p', {class: 'error-text', text: e.message})) }
}

function overdueBadge(n) {
  const b = $('navOverdue')
  b.hidden = !n; b.textContent = n ? `${n} overdue` : ''
}

// ======================= Timetable =======================
let ttMode = 'today', ttDate = null
async function showTimetable(arg) {
  ttDate ||= today()
  $('ttZone').textContent = `Times in ${tz()}`
  if (arg === 'new') classDialog()
  await (ttMode === 'week' ? loadWeek() : loadDay())
}

function setTTMode(mode) {
  ttMode = mode
  document.querySelectorAll('[data-tt]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tt === mode)))
  $('ttDayPanel').hidden = mode !== 'today'
  $('ttWeekPanel').hidden = mode !== 'week'
  mode === 'week' ? loadWeek() : loadDay()
}

async function loadDay() {
  $('dayDate').value = ttDate
  $('dayTitle').textContent = `${dayLabel(ttDate, today())}${dayLabel(ttDate, today()).length < 10 ? ` · ${new Intl.DateTimeFormat('en-GB', {weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'}).format(new Date(ttDate + 'T12:00Z'))}` : ''}`
  const list = $('dayList'), current = dayGuard()
  try {
    const [d, all] = await Promise.all([api(`/api/timetable/day?date=${ttDate}`), api('/api/timetable')])
    if (!current()) return
    if (!all.classes.length) {
      list.replaceChildren(el('li', {style: 'display:block'}, emptyState('calendar', 'Your timetable is empty', 'Add classes one by one, or import a CSV with columns subject, course_code, section, room, weekday, start, end.',
        el('div', {class: 'row', style: 'justify-content:center'}, button('Add class', () => classDialog(), {cls: 'btn primary sm', iconName: 'plus'}), button('Import CSV', () => $('ttImport').click(), {cls: 'btn sm', iconName: 'upload'})))))
      $('dayFree').textContent = ''
      return
    }
    list.replaceChildren(...(d.classes.length ? d.classes.map(o => { const li = classRow(o); li.append(button('', () => classDialog(o), {cls: 'btn ghost sm icon-only', iconName: 'edit', title: `Edit ${o.subject}`})); return li })
      : [el('li', {style: 'display:block'}, emptyState('calendar', `No classes on ${d.weekday}`, 'Enjoy the free day.'))]))
    $('dayFree').textContent = d.free?.length ? `Free in working hours: ${d.free.map(g => `${clock12(g.from)}–${clock12(g.to)}`).join(', ')}` : d.classes.length ? 'No free period of 15 minutes or more in working hours.' : ''
  } catch (e) { list.replaceChildren(el('li', {class: 'error-text', text: e.message})) }
}

async function loadWeek() {
  const grid = $('weekGrid'), current = weekGuard()
  try {
    const [all, next] = await Promise.all([api('/api/timetable'), api('/api/timetable/next')])
    if (!current()) return
    const todayIso = today()
    const wd = ((new Date(todayIso + 'T12:00Z').getUTCDay() + 6) % 7) + 1
    const nowId = next.in_progress?.date === todayIso ? next.in_progress.id : null
    const nextId = next.next?.id
    if (!all.classes.length) { grid.replaceChildren(el('div', {style: 'grid-column:1/-1'}, emptyState('calendar', 'Your timetable is empty', 'Add a class to see your week here.', button('Add class', () => classDialog(), {cls: 'btn primary sm', iconName: 'plus'})))); return }
    grid.replaceChildren(...[1, 2, 3, 4, 5, 6, 7].map(d => {
      const list = all.classes.filter(c => c.weekday === d)
      const overlaps = new Set()
      list.forEach(a => list.forEach(b => { if (a !== b && a.start < b.end && b.start < a.end) overlaps.add(a.id) }))
      return el('div', {class: `day-col${d === wd ? ' today' : ''}`, 'aria-label': days[d]},
        el('h3', {}, days[d].slice(0, 3), d === wd ? el('span', {text: 'Today'}) : null),
        ...(list.length ? list.map(c => el('button', {class: ['class-card', !c.active && 'inactive', overlaps.has(c.id) && 'overlap', c.id === nowId && 'now', c.id === nextId && 'next'].filter(Boolean).join(' '),
          type: 'button', onclick: () => classDialog(c), 'aria-label': `${c.subject}, ${days[d]} ${clock12(c.start)} to ${clock12(c.end)}. Edit`},
          el('div', {class: 't', text: clockRange(c.start, c.end).replace(/ /g, '\u00a0').replace('–', '–\u200b')}), el('div', {class: 's', text: c.subject}),
          el('div', {class: 'r', text: [c.section && `Sec ${c.section}`, c.room].filter(Boolean).join(' · ')}),
          c.id === nowId ? el('span', {class: 'badge accent', text: 'Now', style: 'margin-top:4px'}) : c.id === nextId ? el('span', {class: 'badge accent', text: 'Next', style: 'margin-top:4px'}) : null,
          overlaps.has(c.id) ? el('span', {class: 'badge warning', text: 'Overlaps', style: 'margin-top:4px'}) : null,
          !c.active ? el('span', {class: 'badge', text: 'Inactive', style: 'margin-top:4px'}) : null))
          : [el('p', {class: 'small muted', text: 'No classes'})]))
    }))
  } catch (e) { grid.replaceChildren(el('p', {class: 'error-text', text: e.message})) }
}

function classDialog(c = null) {
  const v = c || {weekday: ((new Date().getDay() + 6) % 7) + 1, active: true}
  const input = (name, props = {}) => el('input', {name, value: v[name] ?? '', ...props})
  const wd = el('select', {name: 'weekday'}, ...[1, 2, 3, 4, 5, 6, 7].map(d => el('option', {value: String(d), text: days[d], selected: d === v.weekday})))
  const active = el('input', {type: 'checkbox', name: 'active', checked: v.active !== false})
  const body = el('div', {class: 'form-grid'},
    el('div', {class: 'full'}, field('Subject', input('subject', {required: true, maxlength: 120, placeholder: 'Database Management Systems'}))),
    field('Course code', input('course_code', {maxlength: 40, placeholder: 'CS-301'})), field('Section / batch', input('section', {maxlength: 40, placeholder: 'A'})),
    field('Room', input('room', {maxlength: 60, placeholder: 'LH-2'})), field('Day', wd),
    field('Starts', input('start', {type: 'time', required: true})), field('Ends', input('end', {type: 'time', required: true})),
    field('Effective from', input('effective_from', {type: 'date'}), 'Optional'), field('Effective until', input('effective_to', {type: 'date'}), 'Optional'),
    el('label', {class: 'check full'}, active, el('span', {text: 'Active (inactive classes are kept but not used in answers)'})))
  const extra = c ? [button('Delete', async () => {
    if (!await confirmDialog(`Delete ${c.subject} on ${days[c.weekday]} at ${clock12(c.start)}?`, {title: 'Delete class'})) return
    api(`/api/timetable/${c.id}`, {method: 'DELETE'}).then(() => { toast('Class deleted'); refreshTimetable() }).catch(e => toast(e.message, {error: true}))
  }, {cls: 'btn danger', iconName: 'trash'})] : []
  return openDialog({title: c ? 'Edit class' : 'Add class', body, submitLabel: c ? 'Save changes' : 'Add class', extraFoot: extra, onSubmit: async form => {
    const f = Object.fromEntries(new FormData(form))
    if (f.end <= f.start) throw new Error('The end time must be after the start time.')
    const payload = {subject: f.subject, course_code: f.course_code, section: f.section, room: f.room, weekday: Number(f.weekday), start: f.start, end: f.end,
      effective_from: f.effective_from, effective_to: f.effective_to, active: active.checked}
    await api(c ? `/api/timetable/${c.id}` : '/api/timetable', json(c ? 'PUT' : 'POST', payload))
    toast(c ? 'Class updated' : 'Class added'); refreshTimetable()
  }})
}

function refreshTimetable() { if (state.view === 'timetable') (ttMode === 'week' ? loadWeek() : loadDay()); emit('changed', 'timetable') }

async function importCSV(file) {
  const replace = await openDialog({title: 'Import timetable', submitLabel: 'Import', body: el('div', {class: 'stack'},
    el('p', {text: `Import classes from “${file.name}”. One invalid row rejects the whole file, so nothing is half-imported.`}),
    el('label', {class: 'check'}, el('input', {type: 'checkbox', name: 'replace'}), el('span', {text: 'Replace the current timetable (otherwise the classes are added)'}))),
  onSubmit: async form => {
    const fd = new FormData(); fd.append('file', file)
    const r = await api(`/api/timetable/import${form.elements.replace.checked ? '?replace=1' : ''}`, {method: 'POST', body: fd})
    toast(`Imported ${plural(r.imported, 'class')}`); refreshTimetable()
  }})
  return replace
}

// ======================= Reminders =======================
let remScope = 'upcoming'
function reminderItem(r, compact = false) {
  const statusBadge = r.status === 'completed' ? el('span', {class: 'badge', text: 'Completed'})
    : r.overdue ? el('span', {class: 'badge danger', text: 'Overdue'})
      : r.local_time.startsWith(today()) ? el('span', {class: 'badge accent', text: 'Today'}) : null
  const delivery = r.delivery === 'overdue' ? 'Missed while the assistant was not running' : r.delivery === 'notified' && r.fired_at ? `Notified ${timeAgo(r.fired_at)}` : ''
  const meta = [dueLabel(r.local_time, today()), r.recurrence !== 'none' ? `Repeats ${({daily: 'daily', weekdays: 'on weekdays', weekly: 'weekly'})[r.recurrence]}` : '', delivery].filter(Boolean).join(' · ')
  const li = el('li', {},
    el('div', {class: 'grow'}, el('div', {class: 'row', style: 'gap:8px'}, el('span', {class: 'title', text: r.title}), statusBadge, r.recurrence !== 'none' ? el('span', {class: 'badge', text: 'Recurring'}) : null),
      r.description && !compact ? el('div', {class: 'meta', text: r.description}) : null, el('div', {class: 'meta', text: meta})))
  if (!compact) {
    li.append(el('div', {class: 'actions'},
      button('', () => patchReminder(r, {completed: r.status !== 'completed'}), {cls: 'btn ghost sm icon-only', iconName: r.status === 'completed' ? 'refresh' : 'check', title: r.status === 'completed' ? `Mark “${r.title}” as not done` : `Mark “${r.title}” as done`}),
      button('', () => reminderDialog(r), {cls: 'btn ghost sm icon-only', iconName: 'edit', title: `Edit “${r.title}”`}),
      button('', async () => {
        if (!await confirmDialog(`Delete the reminder “${r.title}”?`, {title: 'Delete reminder'})) return
        api(`/api/reminders/${r.id}`, {method: 'DELETE'}).then(() => { toast('Reminder deleted'); refreshReminders() }).catch(e => toast(e.message, {error: true}))
      }, {cls: 'btn ghost sm icon-only danger', iconName: 'trash', title: `Delete “${r.title}”`})))
  }
  return li
}

async function showReminders(arg) {
  if (arg === 'new') reminderDialog()
  const list = $('remList'), current = remGuard()
  try {
    const r = await api(`/api/reminders?scope=${remScope}`)
    if (!current()) return
    if (remScope !== 'overdue') api('/api/reminders?scope=overdue').then(o => overdueBadge(o.reminders.length)).catch(() => {})
    const texts = {upcoming: ['No upcoming reminders', 'Add one, or ask the assistant to remind you.'], today: ['Nothing due today', ''], overdue: ['Nothing overdue', 'You are all caught up.'], completed: ['No completed reminders', ''], all: ['No reminders yet', 'Add one, or ask the assistant to remind you.']}[remScope]
    list.replaceChildren(...(r.reminders.length ? r.reminders.map(x => reminderItem(x))
      : [el('li', {style: 'display:block'}, emptyState('bell', texts[0], texts[1], remScope === 'upcoming' || remScope === 'all' ? button('Add reminder', () => reminderDialog(), {cls: 'btn primary sm', iconName: 'plus'}) : null))]))
  } catch (e) { list.replaceChildren(el('li', {class: 'error-text', text: e.message})) }
}

function refreshReminders() { if (state.view === 'reminders') showReminders(); emit('changed', 'reminders') }

async function patchReminder(r, patch) {
  try { await api(`/api/reminders/${r.id}`, json('PATCH', patch)); toast(patch.completed === true ? 'Marked as done' : patch.completed === false ? 'Reopened' : 'Reminder updated'); refreshReminders() }
  catch (e) { toast(e.message, {error: true}) }
}

function reminderDialog(r = null) {
  const soon = new Date(Date.now() + 3600e3)
  const defaultDue = `${ymd(soon, tz())}T${new Intl.DateTimeFormat('en-GB', {timeZone: tz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(soon)}`
  const due = el('input', {type: 'datetime-local', name: 'due', required: true, value: r?.local_time || defaultDue})
  const rec = el('select', {name: 'recurrence'}, ...[['none', 'Does not repeat'], ['daily', 'Every day'], ['weekdays', 'Every weekday (Mon–Fri)'], ['weekly', 'Every week']].map(([v, t]) => el('option', {value: v, text: t, selected: (r?.recurrence || 'none') === v})))
  const body = el('div', {class: 'form-grid'},
    el('div', {class: 'full'}, field('What to remember', el('input', {name: 'title', required: true, maxlength: 200, value: r?.title || '', placeholder: 'Submit attendance'}))),
    field('When', due, `Time zone: ${tz()}`), field('Repeat', rec),
    el('div', {class: 'full'}, field('Details', el('textarea', {name: 'description', rows: 2, maxlength: 1000, value: r?.description || ''}), 'Optional')))
  return openDialog({title: r ? 'Edit reminder' : 'New reminder', body, submitLabel: r ? 'Save changes' : 'Add reminder', onSubmit: async form => {
    const f = Object.fromEntries(new FormData(form))
    if (r) {
      const patch = {title: f.title, description: f.description, recurrence: f.recurrence}
      if (f.due !== r.local_time) patch.due = f.due // an unchanged (maybe past) time is not re-validated
      await api(`/api/reminders/${r.id}`, json('PATCH', patch))
    } else await api('/api/reminders', json('POST', {title: f.title, due: f.due, recurrence: f.recurrence, description: f.description}))
    toast(r ? 'Reminder updated' : 'Reminder added'); refreshReminders()
  }})
}

// Due reminders pushed by the server while this page is open.
function reminderDue(n) {
  const r = n?.reminder || {}
  const when = new Intl.DateTimeFormat('en-GB', {timeZone: tz(), hour: 'numeric', minute: '2-digit', hour12: true}).format(new Date(n.due))
  $('dueList').append(el('li', {text: `${r.title} — ${when}${n.overdue ? ' (missed while the assistant was not running)' : ''}`}))
  $('reminderBanner').hidden = false
  try { if (Notification.permission === 'granted') new Notification('Reminder', {body: r.title}) } catch {}
  refreshReminders()
}

// ======================= Notes =======================
let notes = [], noteSel = null, noteDirty = false, noteSeq = 0
async function showNotes(arg) {
  await loadNotes()
  if (arg === 'new') openNote(null)
  else if (arg) { const n = notes.find(x => x.id === arg) || await api(`/api/notes/${arg}`).catch(() => null); if (n) openNote(n) }
  else if (!noteSel && !noteDirty) openNote(notes[0] || null)
}

async function loadNotes() {
  const seq = ++noteSeq, q = $('noteQuery').value.trim(), tag = $('noteTag').value.trim()
  const list = $('noteList'), stateLine = $('noteState')
  try {
    if (q) {
      const r = await api(`/api/notes/search?q=${encodeURIComponent(q)}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`)
      if (seq !== noteSeq) return
      stateLine.textContent = `${plural(r.hits.length, 'result')} · searched on this Mac${r.warning ? ` · ${r.warning}` : ''}`
      list.replaceChildren(...(r.hits.length ? r.hits.map(h => noteListItem(h, h.kind === 'memo')) : [el('li', {}, emptyState('search', 'No matching notes', 'Try other words — Hindi questions find English notes too.'))]))
      return
    }
    const r = await api(`/api/notes${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`)
    if (seq !== noteSeq) return
    notes = r.notes
    stateLine.textContent = tag ? `${plural(notes.length, 'note')} tagged #${tag}` : `${plural(notes.length, 'note')}`
    list.replaceChildren(...(notes.length ? notes.map(n => noteListItem(n)) : [el('li', {}, emptyState('note', tag ? 'No notes with this tag' : 'No notes yet', tag ? '' : 'Write your first note, or tell the assistant “save a note…”.'))]))
  } catch (e) { list.replaceChildren(el('li', {class: 'error-text', text: e.message})) }
}

function noteListItem(n, memo = false) {
  const b = el('button', {type: 'button', 'aria-current': String(noteSel?.id === n.id), onclick: async () => {
    if (memo) { go('#/memos'); return }
    if (!await leaveNote()) return
    openNote(notes.find(x => x.id === n.id) || await api(`/api/notes/${n.id}`))
  }},
  el('span', {class: 'title', text: n.title}),
  el('span', {class: 'meta', text: `${memo ? 'Voice memo · ' : ''}${timeAgo(n.updated_at)}${n.tags?.length ? ` · #${n.tags.join(' #')}` : ''}`}),
  el('span', {class: 'snippet clamp', text: n.body ?? n.snippet ?? ''}))
  return el('li', {}, b)
}

async function leaveNote() {
  if (!noteDirty) return true
  const ok = await confirmDialog('You have unsaved changes in this note. Discard them?', {title: 'Discard changes?', confirmLabel: 'Discard'})
  if (ok) noteDirty = false
  return !!ok
}

function openNote(n) {
  noteSel = n; noteDirty = false
  document.querySelectorAll('#noteList button').forEach(b => b.setAttribute('aria-current', 'false'))
  const editor = $('noteEditor')
  if (n === null && !notes.length && state.view === 'notes' && location.hash !== '#/notes/new') {
    editor.replaceChildren(el('div', {class: 'editor intro'}, emptyState('note', 'Your notes live here', 'Notes are stored on this Mac and are searchable by you and, with your permission, by the assistant.',
      button('New note', () => openNote(undefined), {cls: 'btn primary sm', iconName: 'plus'}))))
    return
  }
  const title = el('input', {class: 'title-input', placeholder: 'Title (optional)', maxlength: 200, value: n?.title || '', 'aria-label': 'Title'})
  const tags = el('input', {placeholder: 'Tags, separated by commas', maxlength: 300, value: (n?.tags || []).join(', '), 'aria-label': 'Tags'})
  const body = el('textarea', {class: 'body', placeholder: 'Write your note…', maxlength: 20000, 'aria-label': 'Note text'})
  body.value = n?.body || ''
  for (const x of [title, tags, body]) x.addEventListener('input', () => { noteDirty = true })
  const save = button(n ? 'Save' : 'Save note', async () => {
    if (!body.value.trim()) { toast('Write something first', {error: true}); body.focus(); return }
    save.disabled = true
    try {
      const payload = {title: title.value, body: body.value, tags: tags.value.split(',').map(t => t.trim()).filter(Boolean)}
      const saved = await api(n ? `/api/notes/${n.id}` : '/api/notes', json(n ? 'PATCH' : 'POST', payload))
      noteDirty = false; toast(n ? 'Note saved' : 'Note created'); await loadNotes(); openNote(saved); emit('changed', 'notes')
    } catch (e) { toast(e.message, {error: true}) } finally { save.disabled = false }
  }, {cls: 'btn primary', iconName: 'check'})
  const del = n ? button('Delete', async () => {
    if (!await confirmDialog(`Delete the note “${n.title}”? It is also removed from search.`, {title: 'Delete note'})) return
    try { await api(`/api/notes/${n.id}`, {method: 'DELETE'}); noteDirty = false; noteSel = null; toast('Note deleted'); await loadNotes(); openNote(notes[0] || null); emit('changed', 'notes') }
    catch (e) { toast(e.message, {error: true}) }
  }, {cls: 'btn danger', iconName: 'trash'}) : null
  editor.replaceChildren(el('div', {class: 'editor'}, title, tags, body,
    el('div', {class: 'editor-foot'}, el('span', {class: 'small muted', text: n ? `Updated ${timeAgo(n.updated_at)}${n.source === 'assistant' ? ' · saved by the assistant' : ''}` : 'New note'}), el('span', {class: 'spacer'}), del, save)))
  if (n) document.querySelectorAll('#noteList button').forEach(b => { if (b.querySelector('.title')?.textContent === n.title) b.setAttribute('aria-current', 'true') })
  if (n === undefined || location.hash === '#/notes/new') title.focus()
}

// ======================= Voice memos =======================
let memo = null, transcribed = null, previewURL = null

function wavBlob(pcm, rate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf)
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, pcm.length * 2, true)
  new Int16Array(buf, 44).set(pcm)
  return new Blob([buf], {type: 'audio/wav'})
}

function memoUI(recording) {
  const b = $('memoRecord')
  b.classList.toggle('recording', recording)
  b.setAttribute('aria-label', recording ? 'Stop recording' : 'Start recording')
  b.replaceChildren(icon(recording ? 'stop' : 'mic'))
}

async function startMemo() {
  if (transcribed && !await confirmDialog('Record a new memo and discard the transcript you have not saved?', {title: 'Discard unsaved memo?', confirmLabel: 'Discard'})) return
  transcribed = null; $('memoForm').hidden = true
  try {
    const ctx = new AudioContext()
    await ctx.resume()
    const mic = $('microphone').value
    const stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(mic ? {deviceId: {exact: mic}} : {})}})
    await loadWorklet(ctx)
    const node = new AudioWorkletNode(ctx, 'pcm-processor'), silent = ctx.createGain()
    silent.gain.value = 0
    const chunks = []
    node.port.onmessage = ({data}) => { if (data?.type === 'pcm') chunks.push(data.pcm) }
    ctx.createMediaStreamSource(stream).connect(node); node.connect(silent); silent.connect(ctx.destination)
    const limit = state.prof.memo_max_seconds || 120, started = Date.now()
    memo = {ctx, stream, node, chunks, timer: setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000)
      $('memoTimer').textContent = `Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} / ${Math.floor(limit / 60)}:${String(limit % 60).padStart(2, '0')}`
      if (s >= limit) stopMemo()
    }, 250)}
    memoUI(true)
    $('memoTimer').textContent = 'Recording 0:00'
    $('memoState').textContent = 'The microphone is on. Press stop when you are done.'
  } catch (e) {
    $('memoTimer').textContent = 'Microphone unavailable'
    $('memoState').textContent = e.name === 'NotAllowedError' ? 'Permission was denied. Allow the microphone for this page in the browser’s site settings.' : e.message
  }
}

async function stopMemo() {
  const m = memo; memo = null
  if (!m) return
  clearInterval(m.timer); memoUI(false)
  m.node.port.postMessage({type: 'stop'})
  await new Promise(r => setTimeout(r, 150))
  m.stream.getTracks().forEach(t => t.stop())
  const rate = m.ctx.sampleRate
  await m.ctx.close()
  const total = m.chunks.reduce((n, c) => n + c.length, 0)
  const pcm = new Int16Array(total); let off = 0
  m.chunks.forEach(c => { pcm.set(c, off); off += c.length })
  if (previewURL) URL.revokeObjectURL(previewURL)
  previewURL = URL.createObjectURL(wavBlob(pcm, rate)); $('memoPreview').src = previewURL // local preview, never uploaded twice
  $('memoTimer').textContent = 'Transcribing on this Mac…'; $('memoState').textContent = ''
  try {
    const keep = $('memoKeep').checked ? '&keep=1' : ''
    transcribed = await api(`/api/memos/transcribe?rate=${rate}&language=${$('memoLang').value}${keep}`, {method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: pcm.buffer})
    $('mTranscript').value = transcribed.transcript; $('mTitle').value = ''
    $('memoInfo').textContent = `${(transcribed.duration_ms / 1000).toFixed(1)} s transcribed in ${(transcribed.stt_ms / 1000).toFixed(1)} s · ${transcribed.audio_id ? 'the original audio will be kept with the memo' : 'the original audio is not kept'}`
    $('memoForm').hidden = false; $('mTranscript').focus()
    $('memoTimer').textContent = 'Review your memo'
  } catch (e) {
    $('memoTimer').textContent = 'Transcription failed'
    $('memoState').textContent = e.message.includes('no speech') ? 'No speech was detected. Check the microphone and try again.' : e.message
  }
}

async function loadMemos() {
  const list = $('memoList'), current = memoGuard()
  try {
    const r = await api('/api/memos')
    if (!current()) return
    $('memoListState').textContent = r.audio_limit ? `Kept audio ${formatBytes(r.audio_bytes)} of ${formatBytes(r.audio_limit)}` : ''
    list.replaceChildren(...(r.memos.length ? r.memos.map(m => el('li', {},
      el('div', {class: 'grow'}, el('div', {class: 'title', text: m.title}), el('div', {class: 'meta', text: `${timeAgo(m.created_at)}${m.duration_ms ? ` · ${Math.round(m.duration_ms / 1000)} s` : ''}${m.has_audio ? ' · audio kept' : ''}`}),
        el('p', {class: 'small', text: m.transcript, style: 'margin-top:6px;white-space:pre-wrap;color:var(--text-2)'}),
        m.has_audio ? el('audio', {controls: true, preload: 'none', src: `/api/memos/${m.id}/audio`, style: 'width:100%;margin-top:8px'}) : null),
      el('div', {class: 'actions'},
        button('', () => editMemo(m), {cls: 'btn ghost sm icon-only', iconName: 'edit', title: `Edit “${m.title}”`}),
        button('', async () => {
          if (!await confirmDialog(`Delete the memo “${m.title}”${m.has_audio ? ' and its recording' : ''}?`, {title: 'Delete memo'})) return
          api(`/api/memos/${m.id}`, {method: 'DELETE'}).then(() => { toast('Memo deleted'); loadMemos() }).catch(e => toast(e.message, {error: true}))
        }, {cls: 'btn ghost sm icon-only danger', iconName: 'trash', title: `Delete “${m.title}”`}))))
      : [el('li', {style: 'display:block'}, emptyState('mic', 'No memos yet', 'Record one above, or say “save a voice memo: …” to the assistant.'))]))
  } catch (e) { list.replaceChildren(el('li', {class: 'error-text', text: e.message})) }
}

function editMemo(m) {
  const t = el('input', {name: 'title', maxlength: 200, value: m.title})
  const tr = el('textarea', {name: 'transcript', rows: 8, maxlength: 20000, required: true}); tr.value = m.transcript
  return openDialog({title: 'Edit memo', body: el('div', {class: 'stack'}, field('Title', t), field('Transcript', tr)), onSubmit: async () => {
    await api(`/api/memos/${m.id}`, json('PATCH', {title: t.value, transcript: tr.value})); toast('Memo saved'); loadMemos()
  }})
}

// ======================= Drafts =======================
let draftKind = '', drafts = [], draftSel = null, draftDirty = false
const list = v => v.split(/[,;]/).map(s => s.trim()).filter(Boolean)
async function showDrafts(arg) {
  await loadDrafts()
  if (arg === 'new') openDraft(undefined)
  else if (!draftSel && !draftDirty) openDraft(drafts[0] || null)
}
async function loadDrafts() {
  const box = $('draftList'), current = draftGuard()
  try {
    const r = await api(`/api/drafts${draftKind ? `?kind=${draftKind}` : ''}`)
    if (!current()) return
    drafts = r.drafts
    box.replaceChildren(...(drafts.length ? drafts.map(d => el('li', {}, el('button', {type: 'button', 'aria-current': String(draftSel?.id === d.id), onclick: async () => { if (await leaveDraft()) openDraft(d) }},
      el('span', {class: 'title', text: d.subject}),
      el('span', {class: 'meta', text: `${d.kind === 'email' ? 'Email' : 'Announcement'} · ${timeAgo(d.updated_at)}${d.gmail_draft_id ? ' · in Gmail drafts' : ''}`}),
      el('span', {class: 'snippet clamp', text: d.body})))) : [el('li', {}, emptyState('mail', 'No drafts yet', 'Ask “draft an email to …” or write one here.'))]))
  } catch (e) { box.replaceChildren(el('li', {class: 'error-text', text: e.message})) }
}
async function leaveDraft() {
  if (!draftDirty) return true
  const ok = await confirmDialog('You have unsaved changes in this draft. Discard them?', {title: 'Discard changes?', confirmLabel: 'Discard'})
  if (ok) draftDirty = false
  return !!ok
}
function openDraft(d) {
  draftSel = d || null; draftDirty = false
  const editor = $('draftEditor')
  if (d === null) {
    editor.replaceChildren(el('div', {class: 'editor intro'}, emptyState('mail', 'Write a professional draft', 'Emails and announcements are saved here. Open one in Gmail, Outlook or your mail app to review and send it yourself — this program never sends email.', button('New draft', () => openDraft(undefined), {cls: 'btn primary sm', iconName: 'plus'}))))
    return
  }
  const kind = el('select', {'aria-label': 'Type', disabled: !!d}, el('option', {value: 'email', text: 'Email', selected: d?.kind !== 'announcement'}), el('option', {value: 'announcement', text: 'Announcement', selected: d?.kind === 'announcement'}))
  const subject = el('input', {class: 'title-input', placeholder: 'Subject', maxlength: 300, value: d?.subject || '', 'aria-label': 'Subject'})
  const to = el('input', {placeholder: 'name@college.edu', value: (d?.recipients?.to || []).join(', ')})
  const cc = el('input', {value: (d?.recipients?.cc || []).join(', ')})
  const bcc = el('input', {value: (d?.recipients?.bcc || []).join(', ')})
  const audience = el('input', {placeholder: 'e.g. CS-301 section A students', maxlength: 200, value: d?.audience || ''})
  const body = el('textarea', {class: 'body', placeholder: 'Write the draft…', maxlength: 20000, 'aria-label': 'Draft text'}); body.value = d?.body || ''
  const emailFields = el('div', {class: 'form-grid'}, el('div', {class: 'full'}, field('To', to)), field('Cc', cc), field('Bcc', bcc))
  const annFields = el('div', {}, field('Audience', audience))
  const sync = () => { emailFields.hidden = kind.value !== 'email'; annFields.hidden = kind.value === 'email' }
  kind.onchange = sync; sync()
  for (const x of [subject, to, cc, bcc, audience, body]) x.addEventListener('input', () => { draftDirty = true })
  const save = button('Save draft', async () => {
    if (!subject.value.trim() || !body.value.trim()) { toast('A subject and text are required', {error: true}); return }
    save.disabled = true
    try {
      const payload = {kind: kind.value, subject: subject.value, body: body.value, audience: audience.value, to: list(to.value), cc: list(cc.value), bcc: list(bcc.value)}
      const saved = await api(d ? `/api/drafts/${d.id}` : '/api/drafts', json(d ? 'PUT' : 'POST', payload))
      draftDirty = false; toast('Draft saved on this Mac — not sent'); await loadDrafts(); openDraft(saved)
    } catch (e) { toast(e.message, {error: true}) } finally { save.disabled = false }
  }, {cls: 'btn primary', iconName: 'check'})
  const copy = button('Copy', () => navigator.clipboard?.writeText(`${subject.value}\n\n${body.value}`).then(() => toast('Copied to the clipboard')).catch(() => toast('Copy failed', {error: true})), {cls: 'btn', iconName: 'copy'})
  const isEmail = () => kind.value === 'email'
  const handoff = mailHandoff(() => ({to: isEmail() ? to.value : '', cc: isEmail() ? cc.value : '', bcc: isEmail() ? bcc.value : '', subject: subject.value, body: body.value}))
  const g = state.prof.google || {}
  const gmail = d && d.kind === 'email' && g.connected && g.gmail ? button(d.gmail_draft_id ? 'In Gmail drafts' : 'Create Gmail draft', async () => {
    if (!await confirmDialog('Create this as a draft in your Gmail account? It will not be sent.', {title: 'Create Gmail draft', confirmLabel: 'Create draft', danger: false})) return
    try { const r = await api(`/api/drafts/${d.id}/gmail`, {method: 'POST'}); toast(`Gmail draft created (not sent)`); await loadDrafts(); openDraft({...d, gmail_draft_id: r.gmail_draft_id}) } catch (e) { toast(e.message, {error: true}) }
  }, {cls: 'btn', iconName: 'mail', disabled: !!d.gmail_draft_id}) : null
  const del = d ? button('Delete', async () => {
    if (!await confirmDialog(`Delete the draft “${d.subject}”?`, {title: 'Delete draft'})) return
    try { await api(`/api/drafts/${d.id}`, {method: 'DELETE'}); draftDirty = false; toast('Draft deleted'); await loadDrafts(); openDraft(drafts[0] || null) } catch (e) { toast(e.message, {error: true}) }
  }, {cls: 'btn danger', iconName: 'trash'}) : null
  editor.replaceChildren(el('div', {class: 'editor'}, el('div', {class: 'row'}, field('Type', kind), el('span', {class: 'spacer'}), el('span', {class: 'badge', text: 'Not sent'})), subject, emailFields, annFields, body, handoff,
    el('div', {class: 'editor-foot'}, el('span', {class: 'small muted', text: d ? `Updated ${timeAgo(d.updated_at)}` : 'New draft'}), el('span', {class: 'spacer'}), del, gmail, copy, save)))
  document.querySelectorAll('#draftList button').forEach(b => b.setAttribute('aria-current', String(!!d && b.querySelector('.title')?.textContent === d.subject)))
  if (d === undefined) subject.focus()
}

// ======================= Accounts =======================
async function showAccounts() {
  try { state.prof = await api('/api/professor') } catch {}
  const g = state.prof.google || {}
  const st = $('googleStatus')
  st.className = `status ${g.connected ? 'online' : ''}`
  st.querySelector('.label').textContent = !g.configured ? 'Not configured' : g.connected ? 'Connected' : 'Not connected'
  $('googleConnect').hidden = !g.configured || g.connected
  $('googleDisconnect').hidden = !g.connected
  $('googleState').textContent = !g.configured
    ? 'Optional. To use it, create a Google OAuth client of type “Desktop app”, then set GOOGLE_CALENDAR_ENABLED and/or GMAIL_DRAFTS_ENABLED and GOOGLE_OAUTH_CLIENT_ID in .env and restart the assistant.'
    : g.connected ? `Calendar: ${g.calendar ? 'read-only access' : 'off'} · Gmail: ${g.gmail ? 'creates drafts only' : 'off'}` : `Ready to connect.${g.error ? ` ${g.error}` : ''} After connecting in the new tab, return here.`
  const ev = $('googleEvents')
  ev.replaceChildren()
  if (g.connected && g.calendar) {
    try {
      const r = await api('/api/google/events?days=3')
      ev.replaceChildren(...(r.events.length ? r.events.map(e => el('li', {}, el('div', {class: 'grow'}, el('div', {class: 'title', text: e.title}), el('div', {class: 'meta', text: `${e.all_day ? e.start : new Date(e.start).toLocaleString('en-GB', {weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true})}${e.location ? ` · ${e.location}` : ''}`}))))
        : [el('li', {class: 'muted', text: 'No calendar events in the next three days.'})]))
    } catch (e) { ev.replaceChildren(el('li', {class: 'error-text', text: e.message})) }
  }
}

// ======================= Wiring =======================
export function init() {
  registerView('dashboard', {title: 'Dashboard', show: showDashboard})
  registerView('timetable', {title: 'Timetable', show: showTimetable, actions: () => [
    button('Import', () => $('ttImport').click(), {cls: 'btn sm hide-sm', iconName: 'upload'}),
    el('a', {class: 'btn sm hide-sm', href: '/api/timetable/export', download: 'timetable.csv'}, icon('download'), 'Export'),
    button('Add class', () => classDialog(), {cls: 'btn primary sm', iconName: 'plus'})]})
  registerView('reminders', {title: 'Reminders', show: showReminders, actions: () => [button('New reminder', () => reminderDialog(), {cls: 'btn primary sm', iconName: 'plus'})]})
  registerView('notes', {title: 'Notes', show: showNotes, actions: () => [button('New note', async () => { if (await leaveNote()) openNote(undefined) }, {cls: 'btn primary sm', iconName: 'plus'})]})
  registerView('memos', {title: 'Voice Memos', show: loadMemos})
  registerView('drafts', {title: 'Email Drafts', show: showDrafts, actions: () => [button('New draft', async () => { if (await leaveDraft()) openDraft(undefined) }, {cls: 'btn primary sm', iconName: 'plus'})]})
  registerView('accounts', {title: 'Connected Accounts', show: showAccounts})

  document.querySelectorAll('[data-tt]').forEach(b => { b.onclick = () => setTTMode(b.dataset.tt) })
  const shift = n => { const d = new Date(ttDate + 'T12:00Z'); d.setUTCDate(d.getUTCDate() + n); ttDate = d.toISOString().slice(0, 10); loadDay() }
  $('dayPrev').onclick = () => shift(-1); $('dayNext').onclick = () => shift(1)
  $('dayToday').onclick = () => { ttDate = today(); loadDay() }
  $('dayDate').onchange = () => { if ($('dayDate').value) { ttDate = $('dayDate').value; loadDay() } }
  $('ttImport').onchange = () => { const f = $('ttImport').files[0]; $('ttImport').value = ''; if (f) importCSV(f) }

  document.querySelectorAll('#remScope button').forEach(b => { b.onclick = () => {
    remScope = b.dataset.scope
    document.querySelectorAll('#remScope button').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
    showReminders()
  } })

  let searchTimer
  $('noteSearch').onsubmit = e => { e.preventDefault(); loadNotes() }
  $('noteQuery').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadNotes, 300) })
  $('noteTag').addEventListener('change', loadNotes)
  $('noteRecent').onclick = () => { $('noteQuery').value = ''; $('noteTag').value = ''; loadNotes() }

  $('memoRecord').onclick = () => memo ? stopMemo() : startMemo()
  $('memoDiscard').onclick = async () => { if (await confirmDialog('Discard this memo without saving?', {title: 'Discard memo', confirmLabel: 'Discard'})) { transcribed = null; $('memoForm').hidden = true; $('memoTimer').textContent = 'Ready to record' } }
  $('memoForm').onsubmit = async e => {
    e.preventDefault()
    const submit = e.submitter; if (submit) submit.disabled = true
    try {
      await api('/api/memos', json('POST', {title: $('mTitle').value, transcript: $('mTranscript').value, language: transcribed?.language || '', duration_ms: transcribed?.duration_ms || 0, audio_id: transcribed?.audio_id || ''}))
      transcribed = null; $('memoForm').hidden = true; $('memoTimer').textContent = 'Memo saved'; toast('Memo saved'); loadMemos()
    } catch (err) { toast(err.message, {error: true}) } finally { if (submit) submit.disabled = false }
  }

  document.querySelectorAll('#draftKind button').forEach(b => { b.onclick = () => {
    draftKind = b.dataset.kind
    document.querySelectorAll('#draftKind button').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
    loadDrafts()
  } })
  $('googleDisconnect').onclick = async () => {
    if (!await confirmDialog('Disconnect your Google account? Access is revoked at Google and the stored token is deleted.', {title: 'Disconnect Google', confirmLabel: 'Disconnect'})) return
    api('/api/google/disconnect', {method: 'POST'}).then(showAccounts).catch(e => toast(e.message, {error: true}))
  }
  $('dismissDue').onclick = () => { $('reminderBanner').hidden = true; $('dueList').replaceChildren() }

  on('reminder', reminderDue)
  on('changed', kind => {
    if (state.view === 'dashboard') showDashboard()
    if (state.view === 'reminders' && kind !== 'reminders') showReminders()
    if (state.view === 'notes' && kind !== 'notes' && !noteDirty) loadNotes()
    if (state.view === 'drafts' && !draftDirty) loadDrafts()
    if (state.view === 'memos') loadMemos()
  })
  // Keep the dashboard's "next lecture" fresh while it is visible (one light request a minute).
  setInterval(() => { if (state.view === 'dashboard' && feature('timetable') && document.visibilityState === 'visible') dashNext() }, 60000)
  if (feature('reminders')) api('/api/reminders?scope=overdue').then(o => overdueBadge(o.reminders.length)).catch(() => {})
}
