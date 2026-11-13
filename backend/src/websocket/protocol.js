// VAP1 binary framing and the browser WebSocket event (docs/PROTOCOL.md).
//
// Header (16 bytes, all integers big-endian):
//   0..3  ASCII "VAP1"   4 version (1)   5 kind   6..7 flags
//   8..11 turn id        12..15 sequence number
// followed by the payload (PCM16LE input, WAV output, or device PCM).
import {decodeObject, encodeObject, parseJSON} from '../utils/gojson.js'

export const Version = 1
export const HeaderSize = 16

export const AudioInputPCM = 1
export const AudioOutputWAV = 2
export const AudioDebugInputWAV = 3
export const AudioDebugWhisperWAV = 4
export const AudioOutputPCM = 5 // device downlink: 16 kHz s16le mono PCM frames

const MAGIC = Buffer.from('VAP1', 'ascii')

export class FrameError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FrameError'
  }
}

export function encodeAudio({kind, flags = 0, turnId = 0, sequence = 0}, payload) {
  const p = payload ?? Buffer.alloc(0)
  const b = Buffer.allocUnsafe(HeaderSize + p.length)
  MAGIC.copy(b, 0)
  b[4] = Version
  b[5] = kind & 0xff
  b.writeUInt16BE(flags & 0xffff, 6)
  b.writeUInt32BE(turnId >>> 0, 8)
  b.writeUInt32BE(sequence >>> 0, 12)
  if (p.length) Buffer.from(p.buffer, p.byteOffset, p.length).copy(b, HeaderSize)
  return b
}

// decodeAudio returns {header, payload}; payload is a view into b.
export function decodeAudio(b) {
  if (!b || b.length < HeaderSize || b[0] !== 0x56 || b[1] !== 0x41 || b[2] !== 0x50 || b[3] !== 0x31 || b[4] !== Version) {
    throw new FrameError('invalid audio frame header')
  }
  const header = {kind: b[5], flags: b.readUInt16BE(6), turnId: b.readUInt32BE(8), sequence: b.readUInt32BE(12)}
  return {header, payload: b.subarray(HeaderSize)}
}

// Browser event fields, in the Go struct order (all but type are omitempty).
export const EventSchema = [
  ['type', 'string', false],
  ['version', 'int', true],
  ['turn_id', 'uint32', true],
  ['sequence', 'uint32', true],
  ['language', 'string', true],
  ['sample_rate', 'int', true],
  ['capture_sample_rate', 'int', true],
  ['debug', 'bool', true],
  ['text', 'string', true],
  ['code', 'string', true],
  ['message', 'string', true],
  ['metrics', 'any', true],
  ['audio', 'any', true],
  ['mode', 'string', true],
  ['allow_doc_context', 'bool', true],
  ['allow_note_context', 'bool', true],
  ['document_id', 'string', true],
  ['sources', 'any', true],
  ['plan', 'any', true],
  ['capabilities', 'any', true],
  ['stt_only', 'bool', true],
  ['fixture', 'string', true],
  ['eval', 'any', true],
  ['action_id', 'string', true],
  ['decision', 'string', true],
  ['edits', 'strmap', true],
  ['action', 'any', true],
  ['reminder', 'any', true],
  ['notes', 'any', true],
]

export function encodeEvent(e) {
  return JSON.stringify(encodeObject(EventSchema, e))
}

export function decodeEvent(data) {
  return decodeObject(EventSchema, parseJSON(data), 'Event')
}
