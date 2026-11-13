// Pure formatting helpers (no DOM), unit-tested in webtest/format.test.mjs.

// ymd returns YYYY-MM-DD for a Date in the given IANA time zone.
export function ymd(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(date).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}

// dayDiff is the number of calendar days from a to b (YYYY-MM-DD strings).
export function dayDiff(a, b) {
  return Math.round((Date.UTC(...b.split('-').map((v, i) => i === 1 ? v - 1 : +v)) - Date.UTC(...a.split('-').map((v, i) => i === 1 ? v - 1 : +v))) / 86400000)
}

export function longDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'}).format(date)
}

// clock12 turns "14:05" into "2:05 PM".
export function clock12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return `${(h + 11) % 12 + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

// clockRange: "10:00–11:00 AM", or "11:15 AM–12:15 PM" across noon.
export function clockRange(start, end) {
  const a = clock12(start), b = clock12(end)
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`
}

// dayLabel names a date relative to today: Today, Tomorrow, Yesterday, or "Fri 24 Oct".
export function dayLabel(dateYMD, todayYMD) {
  const d = dayDiff(todayYMD, dateYMD)
  if (d === 0) return 'Today'
  if (d === 1) return 'Tomorrow'
  if (d === -1) return 'Yesterday'
  const [y, m, day] = dateYMD.split('-').map(Number)
  const opts = {weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'}
  if (Math.abs(d) > 300) opts.year = 'numeric'
  return new Intl.DateTimeFormat('en-GB', opts).format(new Date(Date.UTC(y, m - 1, day)))
}

// dueLabel formats a reminder's local time ("YYYY-MM-DDTHH:MM") relative to now.
export function dueLabel(localTime, todayYMD) {
  const [date, time] = localTime.split('T')
  return `${dayLabel(date, todayYMD)}, ${clock12(time)}`
}

// greeting by hour of the day.
export function greeting(hour) {
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${Math.round(n / 1024)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

export function timeAgo(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`
  return new Date(iso).toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'})
}

export function seconds(ms) { return ms >= 10000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s` }

// splitCitations cuts an answer into text and citation groups such as
// [D1] or [W2, W3]; the ids are returned for linking and checking.
export function splitCitations(text) {
  const out = []
  let last = 0
  for (const m of text.matchAll(/\[([DW]\d+(?:\s*,\s*[DW]\d+)*)\]/g)) {
    if (m.index > last) out.push({text: text.slice(last, m.index)})
    out.push({cite: m[1].split(',').map(s => s.trim())})
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({text: text.slice(last)})
  return out
}

// friendlyError turns a server error event into a sentence for the professor;
// raw technical messages are only shown for codes without a known meaning.
const unreachable = /connection refused|dial tcp|no such host|network is unreachable|i\/o timeout|deadline exceeded/i
export function friendlyError(m = {}) {
  const msg = m.message || ''
  switch (m.code) {
    case 'stt_busy': return 'Speech recognition is busy. Please try again in a moment.'
    case 'stt_failed':
      if (msg.includes('no speech')) return 'I did not catch any speech. Hold the button while you speak.'
      if (unreachable.test(msg)) return 'Speech recognition is not running on this Mac. Start it with ./scripts/start-local.sh, or type your question instead.'
      return 'Speech could not be transcribed. Please try again.'
    case 'bad_request': return msg.includes('too short') ? 'That recording was too short. Hold the button while you speak.' : (msg.includes('no speech') ? 'No speech detected. Check the microphone and speak a little louder.' : msg || 'The request could not be processed.')
    case 'llm_failed':
      if (msg.includes('request limit')) return 'Gemini’s request limit was reached. Please try again in about a minute.'
      if (/API key|API_KEY|PERMISSION_DENIED|UNAUTHENTICATED/.test(msg)) return 'Gemini rejected the API key. Check GEMINI_API_KEY in .env and restart the assistant.'
      if (unreachable.test(msg)) return 'Gemini could not be reached. Check the internet connection and try again.'
      return 'The answer could not be generated. Please try again.'
    case 'tts_failed': return 'The reply could not be spoken (the local voice service did not answer). The text is shown above.'
    default: return msg || 'Something went wrong.'
  }
}

// Friendly names for tool calls shown under an answer.
const toolNames = {
  get_today_timetable: 'Checked timetable', get_next_class: 'Checked timetable', get_upcoming_events: 'Checked schedule', get_free_time: 'Checked free time',
  list_reminders: 'Checked reminders', search_notes: 'Searched notes', get_note: 'Read a note', list_drafts: 'Checked drafts',
  create_reminder: 'Prepared a reminder', update_reminder: 'Prepared a change', delete_reminder: 'Prepared a deletion', save_note: 'Prepared a note',
  update_note: 'Prepared a note change', delete_note: 'Prepared a deletion', save_voice_memo: 'Prepared a memo', save_email_draft: 'Wrote a draft',
  save_announcement_draft: 'Wrote an announcement', web_search: 'Searched the web', search_local_docs: 'Searched documents', get_calendar_events: 'Checked calendar',
}
export function toolLabel(name) { return toolNames[name] || name.replaceAll('_', ' ') }

// toolFailedLabel names a failed tool call ("Web search failed", not "Searched the web failed").
const toolFailures = {web_search: 'Web search', search_local_docs: 'Document search', get_calendar_events: 'Calendar check', search_notes: 'Note search'}
export function toolFailedLabel(name) {
  if (toolFailures[name]) return `${toolFailures[name]} failed`
  return name?.startsWith('get_') || name?.startsWith('list_') ? 'A lookup failed' : 'An action could not be prepared'
}
export function toolLabels(names = []) { return [...new Set(names.map(toolLabel))] }

// ---- Compose links (hand a draft to the professor's own mail client) ----
// Nothing is sent by this program: these only open a pre-filled compose
// window, and the professor presses Send there (or does not).

// Longest link we hand to a browser or mail app; some mailto handlers fail
// beyond about 2000 characters.
export const MAX_COMPOSE_URL = 1900

const addressRe = /^[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/

// cleanAddresses accepts a "a@x.edu, b@y.edu" string or an array and keeps
// only well-formed addresses (no spaces, quotes, angle brackets, CR/LF),
// de-duplicated case-insensitively.
export function cleanAddresses(value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : [value ?? ''])
    .flatMap(v => String(v ?? '').split(/[,;]/))
    .map(s => s.trim())
    .filter(s => s.length <= 254 && addressRe.test(s) && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
}

// composeLinks builds Gmail, Outlook (Microsoft 365) and mailto links. The
// subject loses CR/LF so it cannot add headers. If the longest link would
// exceed MAX_COMPOSE_URL, the body is left out (bodyInUrl=false) and the
// caller copies it to the clipboard instead.
export function composeLinks({to, cc, bcc, subject, body} = {}) {
  const enc = encodeURIComponent
  const r = {to: cleanAddresses(to), cc: cleanAddresses(cc), bcc: cleanAddresses(bcc)}
  const su = enc(String(subject ?? '').replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim())
  const text = String(body ?? '').replace(/\r\n?/g, '\n')
  const list = (k, sep) => r[k].map(x => enc(x).replace(/%40/g, '@')).join(sep) // a literal @ is required in mailto:
  const build = withBody => ({
    gmail: `https://mail.google.com/mail/?view=cm&fs=1&to=${list('to', ',')}&cc=${list('cc', ',')}&bcc=${list('bcc', ',')}&su=${su}&body=${withBody ? enc(text) : ''}`,
    outlook: `https://outlook.office.com/mail/deeplink/compose?to=${list('to', ';')}&cc=${list('cc', ';')}&bcc=${list('bcc', ';')}&subject=${su}&body=${withBody ? enc(text) : ''}`,
    mailto: `mailto:${list('to', ',')}?cc=${list('cc', ',')}&bcc=${list('bcc', ',')}&subject=${su}&body=${withBody ? enc(text.replace(/\n/g, '\r\n')) : ''}`,
  })
  const full = build(true)
  if (Math.max(...Object.values(full).map(u => u.length)) <= MAX_COMPOSE_URL) return {...full, bodyInUrl: true}
  return {...build(false), bodyInUrl: false}
}
