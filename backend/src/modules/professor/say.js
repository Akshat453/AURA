// Spoken wording generated on the server (not by the model) for confirmation
// questions and results, so what the user approves is exactly what runs.
// Hindi output is Devanagari only: the Hindi voice cannot read Latin script.
import {DateTime} from 'luxon'
import {fields, runes} from '../../utils/gotext.js'
import {goWeekday, MONTHS, WEEKDAYS} from '../../utils/time.js'

const hiWeekdays = ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार']
const hiMonths = ['', 'जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर']

export const hindi = language => language === 'hi' || language === 'hinglish'

const clock12 = t => `${((t.hour + 11) % 12) + 1}:${String(t.minute).padStart(2, '0')}`

function hiPeriod(t) {
  const h = t.hour
  if (h >= 4 && h < 12) return 'सुबह'
  if (h >= 12 && h < 16) return 'दोपहर'
  if (h >= 16 && h < 19) return 'शाम'
  return 'रात'
}

// when describes t relative to now: "tomorrow, Thursday 22 October, at 10:00 AM".
export function when(t, now, language) {
  now = now.setZone(t.zone)
  const days = Math.trunc((Date.UTC(t.year, t.month - 1, t.day) - Date.UTC(now.year, now.month - 1, now.day)) / 86400000)
  if (hindi(language)) {
    let date = `${hiWeekdays[goWeekday(t)]}, ${t.day} ${hiMonths[t.month]}`
    if (t.year !== now.year) date += ` ${t.year}`
    const at = `${hiPeriod(t)} ${clock12(t)} बजे`
    if (days === 0) return 'आज ' + at
    if (days === 1) return 'कल, ' + date + ', ' + at
    if (days === 2) return 'परसों, ' + date + ', ' + at
    return date + ' को ' + at
  }
  let date = `${WEEKDAYS[goWeekday(t)]} ${t.day} ${MONTHS[t.month]}`
  if (t.year !== now.year) date += ` ${t.year}`
  const at = 'at ' + clock12(t) + ' ' + (t.hour < 12 ? 'AM' : 'PM')
  if (days === 0) return 'today ' + at
  if (days === 1) return 'tomorrow, ' + date + ', ' + at
  return 'on ' + date + ', ' + at
}

export function recurrenceText(r, language) {
  if (hindi(language)) return {daily: 'हर दिन', weekdays: 'हर कार्यदिवस, सोमवार से शुक्रवार', weekly: 'हर हफ़्ते'}[r] ?? ''
  return {daily: 'every day', weekdays: 'every weekday', weekly: 'every week'}[r] ?? ''
}

// askSuffix closes a confirmation question. Devices have no screen, so their
// wording never mentions buttons or anything displayed.
export function askSuffix(language, device) {
  if (hindi(language)) return ' कृपया हाँ या नहीं कहें।'
  if (device) return ' Please say yes or no.'
  return ' Say yes or no, or use the buttons.'
}

// excerpt shortens s to max code points at a word or sentence boundary. Like
// the Go version, the boundary position is compared in bytes.
export function excerpt(s, max) {
  s = fields(s).join(' ')
  const r = runes(s)
  if (r.length <= max) return s
  let cut = r.slice(0, max).join('')
  const bytes = Buffer.from(cut, 'utf8')
  let last = -1
  for (const sep of [' ', '।', '.', ',']) last = Math.max(last, bytes.lastIndexOf(Buffer.from(sep, 'utf8')))
  if (last > Math.trunc(max / 2)) cut = bytes.subarray(0, last).toString('utf8')
  return cut.trim() + '…'
}

export const pick = (language, en, hi) => (hindi(language) ? hi : en)

// A bare clock hour ("at 5", "5 baje", "5 बजे") without morning/evening
// context is ambiguous: the reminder tools then make the model ask instead
// of guessing. Leading-zero (09:30) and 13-23 hours are read as 24-hour times.
// The Devanagari periods include Whisper's measured misspellings (सुभा).
const bareAt = /\bat\s+(1[0-2]|[1-9])((?::|\.)[0-5]\d)?(\s*o'?\s*clock)?\b/i
const bareBaje = /(?:^|\s)(1[0-2]|[1-9])((?::|\.)[0-5]\d)?\s*(baje|बजे)/i
const dayPeriod = /\d\s*[ap]\.?\s?m\b|\b(morning|evening|afternoon|night|tonight|noon|midnight|subah|subha|sham|shaam|dopahar|dopehar|raat|savere|sawere)\b|सुबह|सुभा|सुबा|शाम|साम|दोपहर|दुपहर|दोपहार|रात|सवेरे|प्रातः|सायं/i

// ambiguousTime returns the ambiguous time phrase in the user's words, or null.
export function ambiguousTime(prompt) {
  if (dayPeriod.test(prompt)) return null
  for (const re of [bareAt, bareBaje]) {
    const m = re.exec(prompt)
    if (m && m[0] !== '') return m[0].trim()
  }
  return null
}

export {DateTime}
