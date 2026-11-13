// Speech-to-text evaluation fixtures and WER/CER scoring for the development
// tools. Nothing here is used by the production path.
import fs from 'node:fs'
import path from 'node:path'

export const ManifestName = 'manifest.json'

export function loadManifest(dir) {
  let text
  try {
    text = fs.readFileSync(path.join(dir, ManifestName), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return {version: 1, fixtures: []}
    throw e
  }
  const m = JSON.parse(text)
  m.fixtures ??= []
  return m
}

// saveManifest writes the manifest in a deterministic order.
export function saveManifest(dir, m) {
  const fixtures = [...(m.fixtures ?? [])].sort((a, b) => (a.language !== b.language ? (a.language < b.language ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const tmp = path.join(dir, ManifestName + '.tmp')
  fs.writeFileSync(tmp, JSON.stringify({...m, fixtures}, null, 2) + '\n', {mode: 0o644})
  fs.renameSync(tmp, path.join(dir, ManifestName))
}

export const findFixture = (m, id) => (m.fixtures ?? []).find(f => f.id === id) ?? null

// normalize prepares text for WER/CER: NFC, lower case, punctuation and
// symbols (including the danda) removed, whitespace collapsed. Scripts are
// never transliterated.
export function normalize(text) {
  text = text.toLowerCase().normalize('NFC')
  let b = ''
  for (const r of text) {
    if (r === '-' || r === '–' || r === '—' || r === '/') b += ' '
    else if (/[\p{P}\p{S}]/u.test(r)) continue
    else b += r
  }
  return b.split(/\s+/u).filter(Boolean).join(' ')
}

// alignCounts returns substitutions, deletions and insertions of the minimum
// edit-distance alignment from ref to hyp.
function alignCounts(ref, hyp) {
  const n = ref.length
  const m = hyp.length
  const d = Array.from({length: n + 1}, (_, i) => {
    const row = new Array(m + 1).fill(0)
    row[0] = i
    return row
  })
  for (let j = 0; j <= m; j++) d[0][j] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j - 1] + cost, d[i - 1][j] + 1, d[i][j - 1] + 1)
    }
  }
  let sub = 0
  let del = 0
  let ins = 0
  for (let i = n, j = m; i > 0 || j > 0;) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      i--
      j--
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      sub++
      i--
      j--
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      del++
      i--
    } else {
      ins++
      j--
    }
  }
  return [sub, del, ins]
}

// dominantScript classifies letters: latin, devanagari, arabic, other, mixed
// (no script above 80%) or none.
export function dominantScript(text) {
  const counts = {}
  let total = 0
  for (const r of text) {
    if (!/[\p{L}\p{Mn}\p{Mc}]/u.test(r)) continue
    total++
    const k = /\p{Script=Latin}/u.test(r) ? 'latin' : /\p{Script=Devanagari}/u.test(r) ? 'devanagari' : /\p{Script=Arabic}/u.test(r) ? 'arabic' : 'other'
    counts[k] = (counts[k] ?? 0) + 1
  }
  if (total === 0) return 'none'
  for (const [script, c] of Object.entries(counts)) if (c >= 0.8 * total) return script
  return 'mixed'
}

// compare scores a hypothesis against a reference for the given language.
export function compare(reference, hypothesis, language) {
  const ref = normalize(reference)
  const hyp = normalize(hypothesis)
  const rw = ref.split(' ').filter(Boolean)
  const hw = hyp.split(' ').filter(Boolean)
  const s = {wer: 0, cer: 0, exact: ref === hyp && ref !== '', ref_words: rw.length, substitutions: 0, deletions: 0, insertions: 0, script: '', script_mismatch: false}
  ;[s.substitutions, s.deletions, s.insertions] = alignCounts(rw, hw)
  if (rw.length > 0) s.wer = (s.substitutions + s.deletions + s.insertions) / rw.length
  const rc = [...ref.replaceAll(' ', '')]
  const hc = [...hyp.replaceAll(' ', '')]
  if (rc.length > 0) {
    const [sub, del, ins] = alignCounts(rc, hc)
    s.cer = (sub + del + ins) / rc.length
  }
  s.script = dominantScript(hypothesis)
  if (language === 'en') s.script_mismatch = s.script !== 'latin' && s.script !== 'none'
  else if (language === 'hi') s.script_mismatch = s.script !== 'devanagari' && s.script !== 'none'
  else if (language === 'hinglish') {
    s.script_mismatch = !['devanagari', 'latin', 'mixed', 'none'].includes(s.script)
    const hypLatin = new Set(hw)
    let tw = 0
    let tr = 0
    for (const w of rw) {
      if (dominantScript(w) === 'latin') {
        tw++
        if (hypLatin.has(w)) tr++
      }
    }
    if (tw) s.technical_words = tw
    if (tr) s.technical_recognized = tr
  }
  return s
}

// summarize returns n, mean, median and p95 (linear interpolation).
export function summarize(values) {
  if (!values.length) return {n: 0, mean: 0, median: 0, p95: 0}
  const v = [...values].sort((a, b) => a - b)
  const pct = p => {
    const pos = p * (v.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    return v[lo] + (v[hi] - v[lo]) * (pos - lo)
  }
  return {n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, median: pct(0.5), p95: pct(0.95)}
}
