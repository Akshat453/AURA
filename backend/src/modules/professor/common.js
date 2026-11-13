// Helpers shared by the professor modules.
import crypto from 'node:crypto'
import {fromUnix, rfc3339} from '../../utils/time.js'

export class NotFoundError extends Error {
  constructor() {
    super('not found')
    this.name = 'NotFoundError'
  }
}

export const isNotFound = e => e instanceof NotFoundError

export const newID = prefix => prefix + crypto.randomBytes(8).toString('hex')

// nullable stores an empty action id as NULL, so the UNIQUE constraint only
// applies to writes made through a confirmed action.
export const nullable = s => (s ? s : null)

// clean trims, removes control characters and limits length (in code points).
export function clean(s, max) {
  s = (s ?? '').trim()
  let out = ''
  for (const ch of s) {
    const r = ch.codePointAt(0)
    if ((r < 32 && r !== 10 && r !== 9) || r === 0x7f) continue
    out += ch
  }
  const runes = Array.from(out)
  if (runes.length > max) out = runes.slice(0, max).join('').trim()
  return out
}

export const escapeLike = s => s.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')

// localTime renders a Unix timestamp like Go's time.Unix(x, 0) in JSON.
export const localTime = seconds => rfc3339(fromUnix(seconds))

// defineJSON attaches a non-enumerable toJSON so records serialise exactly
// like the Go structs (field order, omitempty) wherever they are sent.
export function defineJSON(obj, fn) {
  Object.defineProperty(obj, 'toJSON', {value: fn, enumerable: false})
  return obj
}
