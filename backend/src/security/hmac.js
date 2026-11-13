// HMAC-SHA256 challenge-response for ESP32 devices.
//
//   mac = hex(HMAC-SHA256(key = hex-decode(secret), "VAP1-AUTH\n" + device_id + "\n" + nonce_hex))
//
// The device secret never crosses the network: the server sends a fresh
// 256-bit nonce per connection and checks the device's MAC in constant time.
import crypto from 'node:crypto'
import {AuthContext} from '../websocket/deviceProtocol.js'

const HEX = /^(?:[0-9a-fA-F]{2})*$/

// decodeHex mirrors Go's hex.DecodeString: null for odd length or invalid digits
// (Buffer.from(s, 'hex') would silently stop at the first invalid character).
export function decodeHex(s) {
  if (typeof s !== 'string' || !HEX.test(s)) return null
  return Buffer.from(s, 'hex')
}

export class SecretError extends Error {}

// mac computes what a device sends for a challenge.
export function mac(secretHex, deviceID, nonce) {
  const key = decodeHex(secretHex)
  if (!key || key.length < 32) throw new SecretError('device secret must be at least 32 bytes of hex')
  return crypto.createHmac('sha256', key).update(`${AuthContext}\n${deviceID}\n${nonce}`, 'utf8').digest('hex')
}

// newNonce returns a fresh random 32-byte challenge, hex encoded.
export const newNonce = () => crypto.randomBytes(32).toString('hex')

// newSecret returns a random 32-byte device secret, hex encoded.
export const newSecret = () => crypto.randomBytes(32).toString('hex')

// macEqual compares two hex MACs in constant time.
export function macEqual(wantHex, gotBytes) {
  const want = decodeHex(wantHex)
  if (!want || !gotBytes || want.length !== gotBytes.length) return false
  return crypto.timingSafeEqual(want, gotBytes)
}
