// PCM16 audio: validation, the speech gate, complete-utterance band-limited
// resampling, WAV encoding/decoding and alignment measurements. Arithmetic
// follows the Go implementation exactly (round half away from zero, int16
// truncation), so resampled audio is sample-for-sample identical.
import {goRound} from './goparse.js'

export const WhisperSampleRate = 16000

export class AudioError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AudioError'
  }
}

const view = pcm => new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)

export function toFloat(pcm) {
  const n = Math.floor(pcm.length / 2)
  const out = new Float64Array(n)
  const dv = view(pcm)
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true)
  return out
}

export function validatePCM16(pcm, sampleRate, maxSeconds) {
  if (sampleRate < 8000 || sampleRate > 192000) throw new AudioError('unsupported sample rate')
  if (pcm.length < Math.trunc(sampleRate / 5) * 2) throw new AudioError('recording is too short')
  if (pcm.length % 2 !== 0 || pcm.length > sampleRate * maxSeconds * 2) throw new AudioError('invalid recording length')
  if (!hasSpeech(pcm, sampleRate)) throw new AudioError('no speech detected')
}

// Speech gating. A fixed loudness threshold rejected quiet but clear speech
// while steady room noise is louder than that, so the gate measures the level
// spread instead: speech alternates syllables and pauses, noise does not.
// Measured on real recordings, speech spread was 17.5-50 dB and room/white
// noise 0.8-6.5 dB.
const speechFrameMS = 20
const speechSkipMS = 150 // microphone warm-up is often near-silent
const minSpeechSpreadDB = 12

export const hasSpeech = (pcm, sampleRate) => levelSpreadDB(pcm, sampleRate) >= minSpeechSpreadDB

// levelSpreadDB is the difference between the 90th and 10th percentile of
// 20 ms frame energies, ignoring the first 150 ms when the clip is long enough.
export function levelSpreadDB(pcm, sampleRate) {
  const frame = Math.trunc((sampleRate * speechFrameMS) / 1000)
  let samples = toFloat(pcm)
  const skip = Math.trunc((sampleRate * speechSkipMS) / 1000)
  if (samples.length >= skip + 5 * frame) samples = samples.subarray(skip)
  const levels = []
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let sum = 0
    for (let j = i; j < i + frame; j++) sum += samples[j] * samples[j]
    levels.push(10 * Math.log10(sum / frame + 1e-3)) // floor below 1 LSB of energy
  }
  if (levels.length === 0) return 0
  levels.sort((a, b) => a - b)
  const at = p => levels[goRound(p * (levels.length - 1))]
  return at(0.9) - at(0.1)
}

export function wav(pcm, sampleRate) {
  const b = Buffer.alloc(44 + pcm.length)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE((36 + pcm.length) >>> 0, 4)
  b.write('WAVEfmt ', 8, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(sampleRate >>> 0, 24)
  b.writeUInt32LE((sampleRate * 2) >>> 0, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(pcm.length >>> 0, 40)
  b.set(pcm, 44)
  return b
}

const dbfs = v => (v <= 0 ? -Infinity : 20 * Math.log10(v))

// analyzePCM16 reports levels without altering the recording.
export function analyzePCM16(pcm, sampleRate) {
  const s = {sample_rate: sampleRate, samples: Math.floor(pcm.length / 2), duration_ms: 0, peak_dbfs: 0, rms_dbfs: 0, clipped_samples: 0, clipped_percent: 0}
  if (sampleRate > 0) s.duration_ms = Math.trunc((s.samples * 1000) / sampleRate)
  if (s.samples === 0) {
    s.peak_dbfs = -Infinity
    s.rms_dbfs = -Infinity
    return s
  }
  const dv = view(pcm)
  let sum = 0
  let peak = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(dv.getInt16(i, true) / 32768)
    if (v > peak) peak = v
    if (v >= 32767 / 32768) s.clipped_samples++
    sum += v * v
  }
  s.clipped_percent = (s.clipped_samples * 100) / s.samples
  s.peak_dbfs = dbfs(peak)
  s.rms_dbfs = dbfs(Math.sqrt(sum / s.samples))
  return s
}

const sinc = x => {
  if (Math.abs(x) < 1e-12) return 1
  const p = Math.PI * x
  return Math.sin(p) / p
}

// resamplePCM16 performs complete-utterance, band-limited resampling.
// Processing the entire recording avoids discontinuities at frame boundaries.
export function resamplePCM16(pcm, inputRate, outputRate) {
  if (inputRate < 8000 || inputRate > 192000 || outputRate < 8000 || outputRate > 192000) throw new AudioError('unsupported sample rate')
  if (pcm.length % 2 !== 0) throw new AudioError('PCM16 byte count must be even')
  if (inputRate === outputRate) return Buffer.from(pcm)
  const inputSamples = pcm.length / 2
  if (inputSamples === 0) return Buffer.alloc(0)
  const outputSamples = goRound((inputSamples * outputRate) / inputRate)
  const out = Buffer.alloc(outputSamples * 2)
  const input = toFloat(pcm)
  const halfTaps = 24
  const cutoff = Math.min(1, outputRate / inputRate) * 0.94
  for (let i = 0; i < outputSamples; i++) {
    const position = (i * inputRate) / outputRate
    const center = Math.floor(position)
    let weighted = 0
    let weights = 0
    for (let sample = center - halfTaps + 1; sample <= center + halfTaps; sample++) {
      if (sample < 0 || sample >= inputSamples) continue
      const distance = position - sample
      if (Math.abs(distance) >= halfTaps) continue
      const window = 0.5 + 0.5 * Math.cos((Math.PI * distance) / halfTaps)
      const weight = cutoff * sinc(cutoff * distance) * window
      weighted += input[sample] * weight
      weights += weight
    }
    if (weights !== 0) weighted /= weights
    weighted = Math.max(-32768, Math.min(32767, goRound(weighted)))
    out.writeInt16LE(weighted, i * 2)
  }
  return out
}

export function prepareWhisper(pcm, inputRate, maxSeconds) {
  validatePCM16(pcm, inputRate, maxSeconds)
  return resamplePCM16(pcm, inputRate, WhisperSampleRate)
}

// decodeWAV accepts uncompressed mono PCM16 WAV data: {pcm, sampleRate}.
export function decodeWAV(data) {
  const r = decodeToPCM16(data)
  if (r.format !== 'pcm_s16le') throw new AudioError('WAV must be mono PCM16')
  return {pcm: r.pcm, sampleRate: r.sampleRate}
}

// decodeToPCM16 accepts mono PCM16 or IEEE float32 WAV and returns PCM16.
// Float samples are converted exactly as the browser AudioWorklet does.
export function decodeToPCM16(data) {
  const w = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (w.length < 12 || w.toString('latin1', 0, 4) !== 'RIFF' || w.toString('latin1', 8, 12) !== 'WAVE') throw new AudioError('invalid RIFF/WAVE header')
  let format = ''
  let sampleRate = 0
  let chunk = null
  for (let offset = 12; offset + 8 <= w.length;) {
    const name = w.toString('latin1', offset, offset + 4)
    const size = w.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + size
    if (end > w.length || end < start) throw new AudioError('truncated WAV chunk')
    if (name === 'fmt ') {
      if (size < 16) throw new AudioError('invalid fmt chunk')
      const tag = w.readUInt16LE(start)
      const channels = w.readUInt16LE(start + 2)
      const bits = w.readUInt16LE(start + 14)
      if (channels !== 1) throw new AudioError('WAV must be mono')
      if (tag === 1 && bits === 16) format = 'pcm_s16le'
      else if (tag === 3 && bits === 32) format = 'pcm_f32le'
      else throw new AudioError('WAV must be PCM16 or float32')
      sampleRate = w.readUInt32LE(start + 4)
    } else if (name === 'data') {
      chunk = w.subarray(start, end)
    }
    offset = end + (size % 2)
  }
  if (sampleRate === 0 || chunk === null) throw new AudioError('WAV is missing valid fmt or data')
  if (format === 'pcm_s16le') {
    if (chunk.length % 2 !== 0) throw new AudioError('odd PCM16 byte count')
    return {pcm: Buffer.from(chunk), sampleRate, format}
  }
  if (chunk.length % 4 !== 0) throw new AudioError('float32 byte count not a multiple of 4')
  const pcm = Buffer.alloc(chunk.length / 2)
  for (let i = 0; i < chunk.length / 4; i++) pcm.writeInt16LE(floatToPCM16(chunk.readFloatLE(i * 4)), i * 2)
  return {pcm, sampleRate, format}
}

// floatToPCM16 mirrors worklet.js: clamp to [-1, 1], then scale negative
// values by 32768 and positive values by 32767 with rounding.
export function floatToPCM16(v) {
  if (Number.isNaN(v)) return 0
  v = Math.max(-1, Math.min(1, v))
  return v < 0 ? goRound(v * 32768) : goRound(v * 32767)
}

export const MaxSNRDB = 200

function overlap(ref, got, lag, stride, fn) {
  for (let i = Math.max(0, -lag); i < ref.length && i + lag < got.length; i += stride) fn(ref[i], got[i + lag])
}

function correlationAt(ref, got, lag, stride) {
  let rr = 0
  let rg = 0
  let gg = 0
  overlap(ref, got, lag, stride, (a, b) => {
    rr += a * a
    rg += a * b
    gg += b * b
  })
  if (rr === 0 || gg === 0) return 0
  return rg / Math.sqrt(rr * gg)
}

// align finds the lag (within maxLag samples) that best aligns got with ref
// and reports correlation and SNR over the overlap.
export function align(refPCM, gotPCM, sampleRate, maxLag) {
  const r = toFloat(refPCM)
  const g = toFloat(gotPCM)
  const f = {lag_ms: 0, correlation: 0, snr_db: 0, duration_delta_ms: Math.trunc(((g.length - r.length) * 1000) / Math.max(1, sampleRate))}
  if (r.length === 0 || g.length === 0) return f
  const step = 4
  let best = -Infinity
  let bestLag = 0
  for (let lag = -maxLag; lag <= maxLag; lag += step) {
    const c = correlationAt(r, g, lag, step)
    if (c > best) {
      best = c
      bestLag = lag
    }
  }
  const coarse = bestLag
  best = -Infinity
  for (let lag = coarse - step; lag <= coarse + step; lag++) {
    const c = correlationAt(r, g, lag, 1)
    if (c > best) {
      best = c
      bestLag = lag
    }
  }
  f.lag_ms = (bestLag * 1000) / sampleRate
  f.correlation = correlationAt(r, g, bestLag, 1)
  let rr = 0
  let rg = 0
  let gg = 0
  overlap(r, g, bestLag, 1, (a, b) => {
    rr += a * a
    rg += a * b
    gg += b * b
  })
  if (rr > 0) {
    const k = rg / rr
    f.snr_db = MaxSNRDB // bit-identical audio; JSON cannot encode +Inf
    const noise = gg - 2 * k * rg + k * k * rr
    if (noise > 0) f.snr_db = Math.min(MaxSNRDB, 10 * Math.log10((k * k * rr) / noise))
  }
  return f
}

// padSilence surrounds a short clip with silence: lead before it and enough
// after it to reach minTotal (both in ms). Whisper transcribes very short
// clips less reliably than the same word with context.
export function padSilence(pcm, sampleRate, leadMs, minTotalMs) {
  const bytesFor = ms => Math.trunc((ms / 1000) * sampleRate) * 2
  const head = bytesFor(leadMs)
  const tail = Math.max(0, bytesFor(minTotalMs) - head - pcm.length)
  const out = Buffer.alloc(head + pcm.length + tail)
  out.set(pcm, head)
  return out
}

// speechLikePCM returns a deterministic speech-like test signal: 180 ms voiced
// "syllables" separated by 120 ms pauses, peaking at amplitude (0-1).
export function speechLikePCM(sampleRate, seconds, amplitude) {
  const samples = Math.trunc(sampleRate * seconds)
  const pcm = Buffer.alloc(samples * 2)
  const period = 0.3
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate
    const phase = t % period
    const env = phase < 0.18 ? Math.sin((Math.PI * phase) / 0.18) : 0
    const v = env * amplitude * (0.6 * Math.sin(2 * Math.PI * 140 * t) + 0.3 * Math.sin(2 * Math.PI * 280 * t) + 0.1 * Math.sin(2 * Math.PI * 1200 * t))
    pcm.writeInt16LE(floatToPCM16(v), i * 2)
  }
  return pcm
}
