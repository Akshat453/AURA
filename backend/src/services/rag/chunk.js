// Text cleanup and chunking for local document retrieval. Output is identical
// to the Go chunker (ChunkerVersion is unchanged), so documents indexed by
// the Go backend are not re-indexed.
import crypto from 'node:crypto'
import {fields, isControl, isSpace, runeLen, trimSpace} from '../../utils/gotext.js'

// ChunkerVersion changes whenever chunking output changes.
export const ChunkerVersion = 'chunk-v1'

const sha256hex = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

// estimateTokens approximates XLM-RoBERTa (multilingual-e5) token counts
// without a tokenizer: about 1.3 tokens per English word, and one token per
// four characters for long words and Devanagari, whichever is larger.
export function estimateTokens(s) {
  const words = fields(s).length
  const byChars = Math.trunc((runeLen(s) + 3) / 4)
  return Math.max(Math.trunc((words * 13 + 9) / 10), byChars)
}

const ASCII_WS = '[\\t\\n\\f\\r ]' // Go RE2 \s
const headingLine = new RegExp(`^#{1,6}${ASCII_WS}+(.+)$`)
const paragraphSplit = new RegExp(`\\n${ASCII_WS}*\\n`)

function blocks(text) {
  const out = []
  for (let para of text.split(paragraphSplit)) {
    para = trimSpace(para)
    if (para === '') continue
    const lines = para.split('\n')
    const m = headingLine.exec(trimSpace(lines[0]))
    if (m) {
      out.push({text: trimSpace(m[1]), heading: true})
      const rest = trimSpace(lines.slice(1).join('\n'))
      if (rest !== '') out.push({text: rest, heading: false})
      continue
    }
    out.push({text: para, heading: false})
  }
  return out
}

// chunk splits sections into chunks of about target tokens with overlap
// tokens carried between consecutive chunks of the same section. Chunks never
// cross a section (page or slide) boundary, so every chunk has one citable page.
export function chunk(sections, target, overlap) {
  if (target < 50) target = 50
  overlap = Math.min(Math.max(overlap, 0), Math.trunc(target / 2))
  const out = []
  let heading = ''
  for (const sec of sections) {
    if (sec.heading) heading = sec.heading
    let current = [] // words of the chunk being built
    let carried = 0 // leading words of current copied from the previous chunk
    let chunkHeading = heading
    const flush = () => {
      if (current.length <= carried) return // nothing new beyond the overlap
      const text = current.join(' ')
      out.push({seq: out.length, page: sec.page ?? 0, heading: chunkHeading, text, tokens: estimateTokens(text), hash: sha256hex(text)})
      // Start the next chunk with the tail of this one.
      let keep = current
      while (keep.length > 0 && estimateTokens(keep.join(' ')) > overlap) keep = keep.slice(1)
      current = [...keep]
      carried = keep.length
      chunkHeading = heading
    }
    for (const b of blocks(sec.text ?? '')) {
      if (b.heading) {
        flush() // a heading starts a new chunk, without overlap from the previous topic
        heading = b.text
        chunkHeading = b.text
        current = []
        carried = 0
      }
      // Pieces leave room for the overlap so a chunk never exceeds target.
      for (const piece of splitLong(b.text, target - overlap)) {
        const words = fields(piece)
        if (current.length > carried && estimateTokens([...current, ...words].join(' ')) > target) flush()
        current.push(...words)
      }
    }
    flush()
  }
  return out
}

const sentenceEnd = new RegExp(`([.!?।])${ASCII_WS}+`, 'g')

// splitLong breaks a paragraph longer than target into sentence groups, and a
// single overlong sentence into word windows.
function splitLong(text, target) {
  if (estimateTokens(text) <= target) return [text]
  const sentences = text.replace(sentenceEnd, '$1\x00')
  const out = []
  let cur = ''
  for (let s of sentences.split('\x00')) {
    s = trimSpace(s)
    if (s === '') continue
    if (estimateTokens(s) > target) {
      if (cur !== '') {
        out.push(cur)
        cur = ''
      }
      let words = fields(s)
      while (words.length > 0) {
        let n = 1
        while (n < words.length && estimateTokens(words.slice(0, n + 1).join(' ')) <= target) n++
        out.push(words.slice(0, n).join(' '))
        words = words.slice(n)
      }
      continue
    }
    if (cur !== '' && estimateTokens(cur + ' ' + s) > target) {
      out.push(cur)
      cur = ''
    }
    cur = trimSpace(cur + ' ' + s)
  }
  if (cur !== '') out.push(cur)
  return out
}

// clean normalizes extracted text: Unicode spaces, Windows line endings,
// control characters, hyphenated line breaks and runs of spaces.
export function clean(text) {
  text = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  text = text.replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
  let b = ''
  for (const ch of text) {
    if (ch === '\n' || ch === '\t') b += ch
    else if (isSpace(ch)) b += ' '
    else if (isControl(ch) || ch === '�') continue
    else b += ch
  }
  const lines = b.split('\n').map(l => fields(l).join(' '))
  return trimSpace(lines.join('\n').replace(/\n{3,}/g, '\n\n'))
}
