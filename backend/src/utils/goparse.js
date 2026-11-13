// Parsers that behave like the Go standard library functions the backend
// used, so every existing .env file keeps its meaning.

const units = {ns: 1e-6, us: 1e-3, 'µs': 1e-3, 'μs': 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000}

// parseDuration parses Go duration strings ("300ms", "1m30s", "-2h") into
// milliseconds. It returns null for invalid input, like time.ParseDuration.
export function parseDuration(s) {
  if (typeof s !== 'string' || s === '') return null
  let rest = s
  let sign = 1
  if (rest[0] === '-' || rest[0] === '+') {
    if (rest[0] === '-') sign = -1
    rest = rest.slice(1)
  }
  if (rest === '0') return 0
  if (rest === '') return null
  let total = 0
  const re = /^(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/
  while (rest.length > 0) {
    const m = re.exec(rest)
    if (!m) return null
    total += parseFloat(m[1]) * units[m[2]]
    rest = rest.slice(m[0].length)
  }
  return sign * total
}

// formatDuration renders milliseconds like Go's Duration.String() for the
// values the application prints (whole seconds and minutes).
export function formatDuration(ms) {
  if (ms === 0) return '0s'
  const neg = ms < 0
  let rest = Math.abs(ms)
  if (rest < 1000) return `${neg ? '-' : ''}${trimFloat(rest)}ms`
  const h = Math.floor(rest / 3600000)
  rest -= h * 3600000
  const m = Math.floor(rest / 60000)
  rest -= m * 60000
  const s = rest / 1000
  let out = ''
  if (h) out += `${h}h`
  if (h || m) out += `${m}m`
  out += `${trimFloat(s)}s`
  return (neg ? '-' : '') + out
}

function trimFloat(v) {
  return String(Number(v.toFixed(9)))
}

// parseBool accepts what strconv.ParseBool accepts; null otherwise.
export function parseBool(s) {
  switch (s) {
    case '1': case 't': case 'T': case 'true': case 'TRUE': case 'True':
      return true
    case '0': case 'f': case 'F': case 'false': case 'FALSE': case 'False':
      return false
  }
  return null
}

// atoi parses a base-10 integer like strconv.Atoi; null otherwise.
export function atoi(s) {
  if (typeof s !== 'string' || !/^[+-]?\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : null
}

// parseFloat64 parses like strconv.ParseFloat(s, 64); null otherwise.
export function parseFloat64(s) {
  if (typeof s !== 'string' || s.trim() !== s || s === '') return null
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s[0] === '-' ? -Infinity : Infinity
  if (/^nan$/i.test(s)) return NaN
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s) && !/^[+-]?0[xX][0-9a-fA-F]+(\.[0-9a-fA-F]*)?[pP][+-]?\d+$/.test(s)) return null
  const v = Number(s)
  return Number.isNaN(v) ? null : v
}

// goRound rounds half away from zero, like math.Round (Math.round rounds
// -2.5 to -2; Go rounds it to -3).
export function goRound(x) {
  if (!Number.isFinite(x)) return x
  return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5)
}

// int16 / uint16 / uint32 conversions with Go's wrap-around semantics.
export const toInt16 = v => ((v << 16) >> 16)
export const toUint32 = v => v >>> 0
