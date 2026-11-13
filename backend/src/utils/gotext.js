// Text helpers with Go's unicode/strings semantics.

// Go unicode.IsSpace (White_Space property; includes U+0085, excludes U+FEFF).
export const SPACE_CLASS = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const spaceRe = new RegExp(`[${SPACE_CLASS}]`, 'u')
const spacesRe = new RegExp(`[${SPACE_CLASS}]+`, 'u')
const trimRe = new RegExp(`^[${SPACE_CLASS}]+|[${SPACE_CLASS}]+$`, 'gu')

export const isSpace = ch => spaceRe.test(ch)
export const isLetter = ch => /\p{L}/u.test(ch)
export const isDigit = ch => /\p{Nd}/u.test(ch)
export const isMark = ch => /[\p{Mn}\p{Mc}]/u.test(ch)
export const isLower = ch => /\p{Ll}/u.test(ch)
export const isControl = ch => /\p{Cc}/u.test(ch)

// fields splits around runs of white space (strings.Fields).
export const fields = s => (s ?? '').split(spacesRe).filter(x => x !== '')

// trimSpace is strings.TrimSpace.
export const trimSpace = s => (s ?? '').replace(trimRe, '')

// runeLen counts code points (utf8.RuneCountInString).
export const runeLen = s => {
  let n = 0
  for (const _ of s ?? '') n++ // eslint-disable-line no-unused-vars
  return n
}

// runes returns the code points of s.
export const runes = s => Array.from(s ?? '')

// truncateRunes keeps the first n code points.
export const truncateRunes = (s, n) => runes(s).slice(0, n).join('')
