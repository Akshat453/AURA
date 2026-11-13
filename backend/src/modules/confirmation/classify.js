// Local yes/no classification of the user's reply to a confirmation
// question. It is deliberately strict and never uses the model: the whole
// reply must consist of known phrases, so "yes, but at 11" or "no, yes" are
// unclear and never approve anything. English, Hinglish (romanized) and Hindi
// (Devanagari as Whisper writes it, including its measured near-miss
// spellings ठीके for ठीक है and नई for नहीं; "हर", Whisper's reading of a
// lone "हाँ", is a real word and is not accepted).
import {fields, runes} from '../../utils/gotext.js'

export const Unclear = 'unclear'
export const Approve = 'approve'
export const Reject = 'reject'

// normalize lower-cases, removes punctuation (including the Devanagari danda
// and apostrophes) and collapses whitespace.
export function normalize(s) {
  s = s.replaceAll("'", '').toLowerCase().replaceAll('’', '')
  let b = ''
  for (const r of s) {
    if (r === '।' || r === '॥') b += ' '
    else if (/[\p{L}\p{Nd}\p{Mn}\p{Mc}]/u.test(r)) b += r
    else b += ' '
  }
  return fields(b).join(' ')
}

function phraseSet(list) {
  const out = new Set()
  for (const line of list.split('\n')) {
    for (const p of line.split('|')) {
      const n = normalize(p)
      if (n !== '') out.add(n)
    }
  }
  return out
}

const approvePhrases = phraseSet(`
yes|yeah|yep|yup|sure|ok|okay|okey|confirm|confirmed|correct|right|thats right|that is right|go ahead|do it|please do|yes please|sounds good|absolutely|of course|alright|all right|fine
save it|create it|delete it|update it|go for it|proceed|affirmative|yes yes
haan|han|haa|haanji|hanji|ha|ji|ji haan|ji han|haan ji|theek hai|thik hai|theek|thik|kar do|kardo|kar dijiye|karo|bilkul|sahi hai|haan kar do|chalega|zaroor|jarur|jaroor
हाँ|हां|हा|हाँजी|हांजी|जी|जी हाँ|जी हां|हाँ जी|हां जी|ठीक है|ठीक|कर दो|कर दीजिए|करो|बिल्कुल|बिलकुल|सही है|ज़रूर|जरूर|चलेगा|ओके|यस|कन्फर्म|हाँ कर दो|हां कर दो
ठीके|हाँ ठीके|हां ठीके
`)

const rejectPhrases = phraseSet(`
no|nope|nah|no thanks|no thank you|cancel|cancel it|cancel that|dont|do not|dont do it|do not do it|stop|never mind|nevermind|not now|wrong|no no|leave it|forget it
nahi|nahin|nai|na|mat karo|mat|rehne do|rahne do|cancel karo|cancel kar do|nahi chahiye|galat|galat hai
नहीं|नही|ना|मत करो|मत|रहने दो|रहने दीजिए|कैंसल|कैंसिल|कैंसल करो|कैंसल कर दो|नहीं चाहिए|गलत|गलत है|नो
नई|नई रहने दो
`)

// covers reports whether words can be split entirely into known phrases.
function covers(words, set) {
  if (words.length === 0) return false
  const ok = new Array(words.length + 1).fill(false)
  ok[0] = true
  for (let i = 0; i < words.length; i++) {
    if (!ok[i]) continue
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      if (set.has(words.slice(i, i + n).join(' '))) ok[i + n] = true
    }
  }
  return ok[words.length]
}

// Whisper sometimes glues a stray consonant to a leading "हाँ" ("हाँद कर
// दो"); that word is read as "हाँ" only when everything after it is already a
// clear approval on its own, so the repair can never turn anything else into a yes.
const strayHaan = /^(हाँ|हां)[दथखकत]$/u

// classify decides whether text is an explicit answer to a confirmation question.
export function classify(text) {
  const n = normalize(text)
  if (n === '' || runes(n).length > 60) return Unclear
  const words = fields(n)
  if (covers(words, approvePhrases)) return Approve
  if (covers(words, rejectPhrases)) return Reject
  if (words.length >= 2 && strayHaan.test(words[0]) && covers(words.slice(1), approvePhrases)) return Approve
  return Unclear
}
