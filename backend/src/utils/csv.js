// CSV reading and writing with Go encoding/csv semantics (RFC 4180 quoting,
// blank lines skipped, strict quotes, "\n" line endings when writing).
import {isSpace} from './gotext.js'

export function parseCSV(text, {trimLeadingSpace = false} = {}) {
  const records = []
  let i = 0
  let line = 1
  const n = text.length
  while (i < n) {
    // Skip empty lines.
    if (text[i] === '\n') {
      i++
      line++
      continue
    }
    if (text[i] === '\r' && text[i + 1] === '\n') {
      i += 2
      line++
      continue
    }
    const rec = []
    const recLine = line
    for (;;) {
      if (trimLeadingSpace) while (i < n && text[i] !== '\n' && text[i] !== '\r' && isSpace(text[i])) i++
      let field = ''
      if (text[i] === '"') {
        const col = i
        i++
        for (;;) {
          if (i >= n) throw new Error(`record on line ${recLine}; parse error on line ${line}, column ${col + 1}: extraneous or missing " in quoted-field`)
          const ch = text[i]
          if (ch === '"') {
            if (text[i + 1] === '"') {
              field += '"'
              i += 2
              continue
            }
            i++
            break
          }
          if (ch === '\r' && text[i + 1] === '\n') {
            field += '\n'
            i += 2
            line++
            continue
          }
          if (ch === '\n') line++
          field += ch
          i++
        }
        if (i < n && text[i] !== ',' && text[i] !== '\n' && !(text[i] === '\r' && text[i + 1] === '\n')) {
          throw new Error(`parse error on line ${line}, column ${i + 1}: extraneous or missing " in quoted-field`)
        }
      } else {
        while (i < n && text[i] !== ',' && text[i] !== '\n' && !(text[i] === '\r' && text[i + 1] === '\n')) {
          if (text[i] === '"') throw new Error(`parse error on line ${line}, column ${i + 1}: bare " in non-quoted-field`)
          field += text[i]
          i++
        }
        if (i >= n && field.endsWith('\r')) field = field.slice(0, -1)
      }
      rec.push(field)
      if (i < n && text[i] === ',') {
        i++
        continue
      }
      if (i < n && text[i] === '\r') i += 2
      else if (i < n) i++
      line++
      break
    }
    records.push(rec)
  }
  return records
}

function needsQuotes(field) {
  if (field === '') return false
  if (field === '\\.') return true
  if (/[\n\r",]/.test(field)) return true
  return isSpace(String.fromCodePoint(field.codePointAt(0)))
}

export function writeCSV(rows) {
  let out = ''
  for (const row of rows) {
    out += row.map(f => (needsQuotes(f) ? '"' + f.replaceAll('"', '""') + '"' : f)).join(',') + '\n'
  }
  return out
}
