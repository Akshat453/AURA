// Time zone arithmetic and Go-compatible time formatting (Luxon). The Go
// backend used time.Location wall-clock arithmetic (time.Date normalisation,
// AddDate) and RFC 3339 JSON; these helpers reproduce both.
import {DateTime, IANAZone, Settings} from 'luxon'

Settings.defaultLocale = 'en-GB'

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// validZone reports whether name is an IANA zone Go's time.LoadLocation accepts.
export function validZone(name) {
  if (name === '' || name === 'UTC' || name === 'Local') return true
  return IANAZone.isValidZone(name)
}

export function zoneOf(name) {
  if (name === '' || name === 'UTC') return 'UTC'
  if (name === 'Local') return 'system'
  return name
}

// The process's local zone name, for "time zone %s" texts (Go: Location.String()).
export function systemZoneName() {
  return DateTime.local().zoneName
}

// fromUnix returns seconds since the epoch in zone ('system' = local, as Go's time.Unix).
export function fromUnix(seconds, zone = 'system') {
  return DateTime.fromSeconds(seconds, {zone})
}

export function fromMillis(ms, zone = 'system') {
  return DateTime.fromMillis(ms, {zone})
}

export const unix = dt => Math.floor(dt.toMillis() / 1000)

// goWeekday returns Go's time.Weekday number (Sunday = 0).
export const goWeekday = dt => dt.weekday % 7

// isoWeekday: 1 = Monday … 7 = Sunday.
export const isoWeekday = dt => dt.weekday

export const weekdayName = dt => WEEKDAYS[goWeekday(dt)]

// wallClock builds a time from a date and minutes after midnight in zone,
// normalising like time.Date(y, m, d, 0, minutes, 0, 0, loc).
export function wallClock(year, month, day, minutes, zone) {
  let dt = DateTime.fromObject({year, month, day}, {zone})
  const days = Math.floor(minutes / 1440)
  const rest = minutes - days * 1440
  if (days) dt = dt.plus({days})
  return dt.set({hour: Math.floor(rest / 60), minute: rest % 60, second: 0, millisecond: 0})
}

export function startOfDay(dt) {
  return DateTime.fromObject({year: dt.year, month: dt.month, day: dt.day}, {zone: dt.zone})
}

// addDays is time.AddDate(0, 0, n): same wall clock, n calendar days later.
export const addDays = (dt, n) => dt.plus({days: n})

const pad = (n, w = 2) => String(n).padStart(w, '0')

// offsetText renders a zone offset as Go's "Z07:00" layout element.
function offsetText(minutes) {
  if (minutes === 0) return 'Z'
  const sign = minutes < 0 ? '-' : '+'
  const m = Math.abs(minutes)
  return `${sign}${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}

// rfc3339 formats like Go's time.Time JSON encoding (RFC 3339 with
// nanoseconds trimmed of trailing zeros).
export function rfc3339(dt) {
  if (!dt) return null
  let frac = ''
  if (dt.millisecond) frac = '.' + pad(dt.millisecond, 3).replace(/0+$/, '')
  return `${pad(dt.year, 4)}-${pad(dt.month)}-${pad(dt.day)}T${pad(dt.hour)}:${pad(dt.minute)}:${pad(dt.second)}${frac}${offsetText(dt.offset)}`
}

// rfc3339Seconds is time.RFC3339 (no fractional seconds).
export function rfc3339Seconds(dt) {
  return `${pad(dt.year, 4)}-${pad(dt.month)}-${pad(dt.day)}T${pad(dt.hour)}:${pad(dt.minute)}:${pad(dt.second)}${offsetText(dt.offset)}`
}

export const ymd = dt => `${pad(dt.year, 4)}-${pad(dt.month)}-${pad(dt.day)}`
export const hhmm = dt => `${pad(dt.hour)}:${pad(dt.minute)}`
export const localLayout = dt => `${ymd(dt)}T${hhmm(dt)}` // "2006-01-02T15:04"
export const ymdHM = dt => `${ymd(dt)} ${hhmm(dt)}` // "2006-01-02 15:04"
// "Monday 2 January 2006, 15:04"
export const longDateTime = dt => `${weekdayName(dt)} ${dt.day} ${MONTHS[dt.month]} ${dt.year}, ${hhmm(dt)}`
// "Monday 2 January 2006"
export const longDate = dt => `${weekdayName(dt)} ${dt.day} ${MONTHS[dt.month]} ${dt.year}`
// "Mon 2 Jan 2006 15:04"
export const shortDateTime = dt => `${weekdayName(dt).slice(0, 3)} ${dt.day} ${MONTHS[dt.month].slice(0, 3)} ${dt.year} ${hhmm(dt)}`
// "20060102-150405" (local time, as time.Now().Format)
export const stamp = dt => `${pad(dt.year, 4)}${pad(dt.month)}${pad(dt.day)}-${pad(dt.hour)}${pad(dt.minute)}${pad(dt.second)}`

const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()

// parseDateParts parses "2006-01-02" strictly; null when invalid.
export function parseDateParts(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null
  return {year: y, month: mo, day: d}
}

// parseLocalParts parses "2006-01-02T15:04" (Go's hour field accepts one or
// two digits) and optionally ":05" seconds; null when invalid.
export function parseLocalParts(s, withSeconds = false) {
  const re = withSeconds ? /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2}):(\d{2})$/ : /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})$/
  const m = re.exec(s)
  if (!m) return null
  const date = parseDateParts(`${m[1]}-${m[2]}-${m[3]}`)
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = withSeconds ? Number(m[6]) : 0
  if (!date || hour > 23 || minute > 59 || second > 59) return null
  return {...date, hour, minute, second}
}

export function inZone(parts, zone) {
  return DateTime.fromObject(parts, {zone})
}
