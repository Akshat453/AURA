// Sentence splitting of streamed LLM text for incremental TTS, and the text
// cleanup applied before speaking.

const TERMINATORS = '.!?।\n'
const isSpace = ch => /\s/u.test(ch)

export class Splitter {
  #pending = ''

  // push adds a delta and returns completed sentences. A terminator only ends
  // a sentence when whitespace follows it, so "3.5" or "v1.2" are never split;
  // a terminator at the very end waits for the next delta or flush.
  push(delta) {
    this.#pending += delta
    const out = []
    const s = this.#pending
    let start = 0
    let i = 0
    for (const ch of s) {
      const end = i + ch.length
      if (TERMINATORS.includes(ch)) {
        let ends = true
        if (ch !== '\n') {
          const next = s.slice(end).codePointAt(0)
          ends = end < s.length && isSpace(String.fromCodePoint(next))
        }
        if (ends) {
          const t = s.slice(start, end).trim()
          if (t !== '') out.push(t)
          start = end
        }
      }
      i = end
    }
    this.#pending = s.slice(start)
    return out
  }

  flush() {
    const v = this.#pending.trim()
    this.#pending = ''
    return v
  }
}

const citationMarker = /\s*\[(?:[DW]\d+(?:\s*,\s*)?)+\]/g
const url = /https?:\/\/\S+/g
// Internal record ids of the professor tools (note_…, rem_…) are never spoken.
const internalID = /\s*[[(]?\b(?:note|memo|rem|draft|cls|act)_[0-9a-f]{8,}\b[\])]?/g
const markdown = /[*_#`>]+/g

// speakable removes what is shown but not read aloud: citation markers such
// as [D1] or [W2, W3], URLs, internal ids and Markdown emphasis characters.
export function speakable(sentence) {
  let s = sentence.replace(citationMarker, '')
  s = s.replace(url, '')
  s = s.replace(internalID, '')
  s = s.replace(markdown, '')
  return s.split(/\s+/u).filter(Boolean).join(' ')
}

// fields splits like Go's strings.Fields (Unicode white space).
export const fields = s => s.split(/\s+/u).filter(Boolean)
