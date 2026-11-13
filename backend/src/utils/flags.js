// Command-line flags with Go flag-package syntax (-name value, --name value,
// -name=value, boolean -name / -name=false, repeatable flags), so documented
// command lines keep working. Parsing stops at the first non-flag argument.
import {parseBool, parseDuration} from './goparse.js'

// spec: {name: {type: 'string'|'int'|'bool'|'duration'|'list', default, usage}}
export function parseFlags(argv, spec, prog = 'command') {
  const values = {}
  for (const [k, s] of Object.entries(spec)) values[k] = s.type === 'list' ? [...(s.default ?? [])] : s.default
  const rest = []
  let i = 0
  const usage = msg => {
    process.stderr.write(`${msg}\nUsage of ${prog}:\n` + Object.entries(spec).map(([k, s]) => `  -${k} ${s.type === 'bool' ? '' : s.type}\n    \t${s.usage ?? ''}`).join('\n') + '\n')
    process.exit(2)
  }
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      i++
      break
    }
    if (!a.startsWith('-') || a === '-') break
    let name = a.replace(/^--?/, '')
    let value
    const eq = name.indexOf('=')
    if (eq >= 0) {
      value = name.slice(eq + 1)
      name = name.slice(0, eq)
    }
    const s = spec[name]
    if (!s) usage(`flag provided but not defined: -${name}`)
    if (s.type === 'bool') {
      if (value === undefined) values[name] = true
      else {
        const b = parseBool(value)
        if (b === null) usage(`invalid boolean value ${JSON.stringify(value)} for -${name}`)
        values[name] = b
      }
      continue
    }
    if (value === undefined) {
      if (i + 1 >= argv.length) usage(`flag needs an argument: -${name}`)
      value = argv[++i]
    }
    switch (s.type) {
      case 'int': {
        if (!/^[+-]?\d+$/.test(value)) usage(`invalid value ${JSON.stringify(value)} for flag -${name}: parse error`)
        values[name] = Number(value)
        break
      }
      case 'duration': {
        const d = parseDuration(value)
        if (d === null) usage(`invalid value ${JSON.stringify(value)} for flag -${name}: parse error`)
        values[name] = d
        break
      }
      case 'list':
        values[name].push(value)
        break
      default:
        values[name] = value
    }
  }
  return {values, args: argv.slice(i).concat(rest)}
}
