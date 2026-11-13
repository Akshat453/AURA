// Device credential registry. Credentials live in a JSON file (0600) that is
// re-read when it changes, so revocation and rotation apply without a server
// restart. The file format is unchanged from the Go backend:
//   [{"id", "name"?, "secret", "previous"?, "previous_expires"?, "revoked"?, "created_at", "rotated_at"?}]
import fs from 'node:fs'
import path from 'node:path'
import {decodeHex, mac as computeMAC, macEqual, newSecret} from '../../security/hmac.js'
import {tooOpen} from '../../security/permissions.js'
import {validDeviceID} from '../../websocket/deviceProtocol.js'

export class UnknownDeviceError extends Error {
  constructor() {
    super('unknown device')
    this.name = 'UnknownDeviceError'
  }
}
export class RevokedError extends Error {
  constructor() {
    super('device credential revoked')
    this.name = 'RevokedError'
  }
}
export class BadMACError extends Error {
  constructor() {
    super('authentication failed')
    this.name = 'BadMACError'
  }
}

// utcStamp formats like Go's time.Time JSON in UTC (fraction trimmed).
export function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/(\.\d*?)0+Z$/, '$1Z').replace(/\.Z$/, 'Z')
}

const FIELD_ORDER = ['id', 'name', 'secret', 'previous', 'previous_expires', 'revoked', 'created_at', 'rotated_at']
const OMIT_EMPTY = new Set(['name', 'previous', 'previous_expires', 'revoked', 'rotated_at'])

function serialize(c) {
  const out = {}
  for (const k of FIELD_ORDER) {
    const v = c[k]
    if (OMIT_EMPTY.has(k) && (v === undefined || v === '' || v === false || v === null)) continue
    out[k] = v ?? (k === 'secret' || k === 'id' ? '' : v)
  }
  return out
}

export class Registry {
  #path
  #mtime = null
  #size = -1
  #devices = new Map()
  now = () => Date.now()

  constructor(file) {
    this.#path = file
  }

  static open(file) {
    const r = new Registry(file)
    r.#reload(true)
    return r
  }

  get path() {
    return this.#path
  }

  #reload(force) {
    let st
    try {
      st = fs.statSync(this.#path, {bigint: true})
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.#devices = new Map()
        return
      }
      throw e
    }
    if (tooOpen({mode: Number(st.mode)})) throw new Error(`${this.#path} is readable by other users; run chmod 600`)
    if (!force && st.mtimeNs === this.#mtime && Number(st.size) === this.#size) return
    const text = fs.readFileSync(this.#path, 'utf8')
    let list
    try {
      list = JSON.parse(text)
    } catch (e) {
      throw new Error(`parse ${this.#path}: ${e.message}`, {cause: e})
    }
    if (list !== null && !Array.isArray(list)) throw new Error(`parse ${this.#path}: expected a JSON array`)
    const devices = new Map()
    for (const c of list ?? []) devices.set(c.id, {...c})
    this.#devices = devices
    this.#mtime = st.mtimeNs
    this.#size = Number(st.size)
  }

  // verify checks a device's response to a challenge. Current and (within its
  // grace period) previous secrets are accepted; comparison is constant time.
  verify(deviceID, nonce, macHex) {
    this.#reload(false)
    const c = this.#devices.get(deviceID)
    if (!c) throw new UnknownDeviceError()
    if (c.revoked) throw new RevokedError()
    const got = decodeHex(macHex)
    if (!got) throw new BadMACError()
    for (const secret of [c.secret, c.previous]) {
      if (!secret) continue
      if (secret === c.previous && !(this.now() < Date.parse(c.previous_expires ?? '0001-01-01T00:00:00Z'))) continue
      let want
      try {
        want = computeMAC(secret, deviceID, nonce)
      } catch {
        continue
      }
      if (macEqual(want, got)) return {...c}
    }
    throw new BadMACError()
  }

  // active reports whether a device may stay connected (not revoked or removed).
  active(deviceID) {
    try {
      this.#reload(false)
    } catch {
      return false
    }
    const c = this.#devices.get(deviceID)
    return !!c && !c.revoked
  }

  // add provisions a device and returns its secret (shown once).
  add(id, name) {
    if (!validDeviceID(id)) throw new Error('device id must be 3-48 lower-case letters, digits or hyphens')
    return this.#update(m => {
      if (m.has(id)) throw new Error(`device ${id} already exists (use rotate)`)
      const secret = newSecret()
      m.set(id, {id, name, secret, created_at: utcStamp(this.now())})
      return secret
    })
  }

  // rotate issues a new secret; the old one keeps working for graceMs (0 revokes it at once).
  rotate(id, graceMs) {
    return this.#update(m => {
      const c = m.get(id)
      if (!c) throw new UnknownDeviceError()
      delete c.previous
      delete c.previous_expires
      if (graceMs > 0) {
        c.previous = c.secret
        c.previous_expires = utcStamp(this.now() + graceMs)
      }
      c.secret = newSecret()
      c.rotated_at = utcStamp(this.now())
      c.revoked = false
      return c.secret
    })
  }

  // revoke disables a device; connected sessions are closed at the next heartbeat.
  revoke(id) {
    this.#update(m => {
      const c = m.get(id)
      if (!c) throw new UnknownDeviceError()
      c.revoked = true
      delete c.previous
      delete c.previous_expires
      return ''
    })
  }

  // list returns devices without their secrets, sorted by id.
  list() {
    this.#reload(false)
    return [...this.#devices.values()].map(c => ({...c, secret: '', previous: ''})).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  #update(fn) {
    this.#reload(true)
    const devices = new Map([...this.#devices].map(([k, v]) => [k, {...v}]))
    const out = fn(devices)
    const list = [...devices.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(serialize)
    fs.mkdirSync(path.dirname(this.#path), {recursive: true, mode: 0o700})
    const tmp = `${this.#path}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', {mode: 0o600})
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, this.#path)
    this.#reload(true)
    return out
  }
}
