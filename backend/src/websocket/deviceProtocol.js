// ESP32 device protocol v1 (docs/DEVICE_PROTOCOL.md): JSON control messages
// and VAP1 binary audio frames. Field names, order and the omission of zero
// values match the Go implementation the firmware was written against.
import {decodeObject, encodeObject, parseJSON} from '../utils/gojson.js'

export const ProtocolVersion = 1
export const AuthContext = 'VAP1-AUTH' // HMAC domain separation string

export const FormatPCM16LE = 'pcm_s16le'
export const SampleRate = 16000
export const Channels = 1
export const BytesPerSecond = SampleRate * Channels * 2
export const BytesPerMS = BytesPerSecond / 1000 // 32: 320 bytes = 10 ms, 640 bytes = 20 ms
export const MaxControlBytes = 4096 // largest accepted JSON control message
export const MaxFrameBytes = 8192 // largest uplink audio payload (256 ms)

export const Supported = Object.freeze({format: FormatPCM16LE, sample_rate: SampleRate, channels: Channels})

export const codecEqual = (a, b) => !!a && !!b && a.format === b.format && a.sample_rate === b.sample_rate && a.channels === b.channels

const CodecFields = [['format', 'string', false], ['sample_rate', 'int', false], ['channels', 'int', false]]
const Codec = {name: 'Codec', fields: CodecFields}

export const MessageSchema = [
  ['type', 'string', false],
  ['v', 'int', true],
  ['turn_id', 'uint32', true],
  ['nonce', 'string', true], // challenge
  ['device_id', 'string', true], // hello
  ['firmware', 'string', true],
  ['mac', 'string', true],
  ['codecs', 'codecs', true, Codec],
  ['playback_buffer_ms', 'int', true],
  ['session_id', 'string', true], // ready
  ['codec', 'object', true, Codec],
  ['frame_ms', 'int', true],
  ['lead_ms', 'int', true],
  ['max_utterance_ms', 'int', true],
  ['max_frame_bytes', 'int', true],
  ['heartbeat_ms', 'int', true],
  ['language', 'string', true], // utterance_start
  ['mode', 'string', true],
  ['frames', 'int', true], // utterance_end / tts_end
  ['duration_ms', 'int', true],
  ['aborted', 'bool', true],
  ['text', 'string', true], // stt_result
  ['state', 'string', true], // playback_state
  ['buffered_ms', 'int', true],
  ['underruns', 'int', true],
  ['code', 'string', true], // error
  ['message', 'string', true],
  ['metrics', 'any', true],
]

export const Type = Object.freeze({
  Challenge: 'challenge',
  Hello: 'hello',
  Ready: 'ready',
  UtteranceStart: 'utterance_start',
  AudioStart: 'audio_start', // server accepted utterance_start; send audio now
  UtteranceEnd: 'utterance_end',
  STTResult: 'stt_result',
  TTSStart: 'tts_start',
  TTSEnd: 'tts_end',
  TurnComplete: 'turn_complete',
  Abort: 'abort',
  PlaybackState: 'playback_state',
  Metrics: 'metrics',
  Error: 'error',
  Ping: 'ping',
  Pong: 'pong',
})

export function encodeMessage(m) {
  return JSON.stringify(encodeObject(MessageSchema, m))
}

export function decodeMessage(data) {
  return decodeObject(MessageSchema, parseJSON(data), 'Message')
}

// negotiate picks the first offered codec the server supports.
export function negotiate(offered) {
  for (const c of offered ?? []) {
    if (codecEqual(c, Supported)) return {...c}
  }
  throw new Error(`no supported codec offered (server supports ${FormatPCM16LE}/${SampleRate} Hz/${Channels} ch)`)
}

const deviceIDPattern = /^[a-z0-9][a-z0-9-]{2,47}$/

// validDeviceID accepts 3-48 lower-case letters, digits and hyphens.
export const validDeviceID = id => typeof id === 'string' && deviceIDPattern.test(id)

// validateHello checks a hello message before authentication; null when valid.
export function validateHello(m) {
  if (m.type !== Type.Hello) return 'first message must be hello'
  if (m.v !== ProtocolVersion) return `unsupported protocol version ${m.v} (server speaks ${ProtocolVersion})`
  if (!validDeviceID(m.device_id)) return 'invalid device_id'
  if (Buffer.byteLength(m.mac) !== 64) return 'missing or malformed authentication'
  if (m.playback_buffer_ms < 100 || m.playback_buffer_ms > 10000) return 'playback_buffer_ms must be 100-10000'
  return null
}

// validateUtteranceStart checks an utterance_start against the session codec.
export function validateUtteranceStart(m, session) {
  if (m.turn_id === 0) return 'turn_id must be non-zero'
  if (!m.codec) return 'utterance_start must state its codec'
  if (!codecEqual(m.codec, session)) return `codec ${m.codec.format}/${m.codec.sample_rate} Hz/${m.codec.channels} ch does not match the negotiated codec`
  if (!['', 'en', 'hi', 'hinglish', 'auto'].includes(m.language)) return `unsupported language ${JSON.stringify(m.language)}`
  if (!['', 'general', 'documents', 'web', 'auto'].includes(m.mode)) return `unsupported mode ${JSON.stringify(m.mode)}`
  return null
}

// frameBytes is the PCM payload size for one frame of frameMs.
export const frameBytes = frameMs => Math.trunc(frameMs) * BytesPerMS

// leadFor returns the playback lead (ms): the configured lead, capped so that
// lead plus two frames fits in the device's declared buffer.
export function leadFor(configuredMs, frameMs, deviceBufferMS) {
  const lead = Math.min(configuredMs, deviceBufferMS - 2 * frameMs)
  return Math.max(lead, frameMs)
}
