// JSON encoding and decoding with Go encoding/json semantics for the wire
// messages: fields are written in declaration order, zero values of
// `omitempty` fields are left out, keys match struct fields
// case-insensitively, unknown keys are ignored (or rejected), and type
// mismatches are errors. Device firmware parses these messages with a small
// fixed buffer, so the exact shape matters.

export class JSONTypeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'JSONTypeError'
  }
}

const goType = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v)

function typeError(value, struct, field, want) {
  const got = goType(value) === 'boolean' ? 'bool' : goType(value)
  return new JSONTypeError(`json: cannot unmarshal ${got} into Go struct field ${struct}.${field} of type ${want}`)
}

function isEmpty(kind, v) {
  if (v === undefined || v === null) return true
  switch (kind) {
    case 'string': return v === ''
    case 'int': case 'uint32': case 'float': return v === 0
    case 'bool': return v === false
    case 'array': case 'codecs': return v.length === 0
    case 'strmap': return Object.keys(v).length === 0
    case 'any': return false
    case 'object': return false
  }
  return false
}

// encode writes obj by schema [[jsonName, kind, omitempty, (sub-schema)], …].
export function encodeObject(schema, obj) {
  const out = {}
  for (const [name, kind, omit, sub] of schema) {
    let v = obj[name]
    if (omit && isEmpty(kind, v)) continue
    if (v === undefined) v = zeroOf(kind)
    if (kind === 'object' && v && sub) v = encodeObject(sub.fields, v)
    if (kind === 'codecs' && v && sub) v = v.map(x => encodeObject(sub.fields, x))
    out[name] = v
  }
  return out
}

export function zeroOf(kind) {
  switch (kind) {
    case 'string': return ''
    case 'int': case 'uint32': case 'float': return 0
    case 'bool': return false
  }
  return null
}

function decodeValue(kind, v, struct, field, sub) {
  if (v === null) return zeroOf(kind) // null leaves the Go zero value
  switch (kind) {
    case 'string':
      if (typeof v !== 'string') throw typeError(v, struct, field, 'string')
      return v
    case 'bool':
      if (typeof v !== 'boolean') throw typeError(v, struct, field, 'bool')
      return v
    case 'int':
      if (typeof v !== 'number') throw typeError(v, struct, field, 'int')
      if (!Number.isInteger(v)) throw new JSONTypeError(`json: cannot unmarshal number ${v} into Go struct field ${struct}.${field} of type int`)
      return v
    case 'uint32':
      if (typeof v !== 'number') throw typeError(v, struct, field, 'uint32')
      if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new JSONTypeError(`json: cannot unmarshal number ${v} into Go struct field ${struct}.${field} of type uint32`)
      return v
    case 'float':
      if (typeof v !== 'number') throw typeError(v, struct, field, 'float64')
      return v
    case 'strmap': {
      if (goType(v) !== 'object') throw typeError(v, struct, field, 'map[string]string')
      const out = {}
      for (const [k, x] of Object.entries(v)) {
        if (x === null) {
          out[k] = ''
          continue
        }
        if (typeof x !== 'string') throw typeError(x, struct, `${field}`, 'string')
        out[k] = x
      }
      return out
    }
    case 'object':
      if (goType(v) !== 'object') throw typeError(v, struct, field, sub.name)
      return decodeObject(sub.fields, v, sub.name)
    case 'codecs':
      if (!Array.isArray(v)) throw typeError(v, struct, field, `[]${sub.name}`)
      return v.map(x => (x === null ? decodeObject(sub.fields, {}, sub.name) : goType(x) === 'object' ? decodeObject(sub.fields, x, sub.name) : (() => { throw typeError(x, struct, field, sub.name) })()))
    case 'any':
      return v
  }
  return v
}

// decodeObject maps a parsed JSON object onto schema with Go's rules.
export function decodeObject(schema, raw, structName, {disallowUnknown = false} = {}) {
  if (goType(raw) !== 'object') throw new JSONTypeError(`json: cannot unmarshal ${goType(raw)} into Go value of type ${structName}`)
  const out = {}
  const byExact = new Map()
  const byFold = new Map()
  for (const f of schema) {
    out[f[0]] = f[1] === 'object' ? null : zeroOf(f[1])
    byExact.set(f[0], f)
    const k = f[0].toLowerCase()
    if (!byFold.has(k)) byFold.set(k, f)
  }
  for (const [key, value] of Object.entries(raw)) {
    const f = byExact.get(key) ?? byFold.get(key.toLowerCase())
    if (!f) {
      if (disallowUnknown) throw new JSONTypeError(`json: unknown field "${key}"`)
      continue
    }
    const [name, kind, , sub] = f
    out[name] = decodeValue(kind, value, structName, name, sub)
  }
  return out
}

// parseJSON parses text like json.Unmarshal: the whole input must be one value.
export function parseJSON(text) {
  try {
    return JSON.parse(typeof text === 'string' ? text : Buffer.from(text).toString('utf8'))
  } catch (e) {
    throw new JSONTypeError(e.message.replace(/^Unexpected/, 'invalid character: unexpected'))
  }
}
