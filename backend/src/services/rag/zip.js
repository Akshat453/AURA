// Minimal ZIP reader for Office documents: lists entries from the central
// directory and inflates single entries with a hard cap on the decompressed
// size, independent of the sizes the archive claims (zip-bomb safe).
import {Inflate} from 'fflate'

export class ZipError extends Error {}

function findEOCD(b) {
  const min = Math.max(0, b.length - 22 - 0xffff)
  for (let i = b.length - 22; i >= min; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new ZipError('zip: not a valid zip file')
}

// entries returns [{name, method, compressedSize, size, localOffset}].
export function entries(b) {
  if (b.length < 22) throw new ZipError('zip: not a valid zip file')
  const eocd = findEOCD(b)
  let count = b.readUInt16LE(eocd + 10)
  let cdSize = b.readUInt32LE(eocd + 12)
  let cdOffset = b.readUInt32LE(eocd + 16)
  if (cdOffset === 0xffffffff || count === 0xffff) {
    // ZIP64 end of central directory locator precedes the EOCD.
    const loc = eocd - 20
    if (loc < 0 || b.readUInt32LE(loc) !== 0x07064b50) throw new ZipError('zip: not a valid zip file')
    const z64 = Number(b.readBigUInt64LE(loc + 8))
    if (z64 + 56 > b.length || b.readUInt32LE(z64) !== 0x06064b50) throw new ZipError('zip: not a valid zip file')
    count = Number(b.readBigUInt64LE(z64 + 32))
    cdSize = Number(b.readBigUInt64LE(z64 + 40))
    cdOffset = Number(b.readBigUInt64LE(z64 + 48))
  }
  if (cdOffset + cdSize > b.length) throw new ZipError('zip: not a valid zip file')
  const out = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) throw new ZipError('zip: not a valid zip file')
    const method = b.readUInt16LE(p + 10)
    let compressedSize = b.readUInt32LE(p + 20)
    let size = b.readUInt32LE(p + 24)
    const nameLen = b.readUInt16LE(p + 28)
    const extraLen = b.readUInt16LE(p + 30)
    const commentLen = b.readUInt16LE(p + 32)
    let localOffset = b.readUInt32LE(p + 42)
    const name = b.toString('utf8', p + 46, p + 46 + nameLen)
    // ZIP64 extended information extra field.
    let e = p + 46 + nameLen
    const eEnd = e + extraLen
    while (e + 4 <= eEnd) {
      const id = b.readUInt16LE(e)
      const len = b.readUInt16LE(e + 2)
      if (id === 0x0001) {
        let q = e + 4
        if (size === 0xffffffff && q + 8 <= e + 4 + len) {
          size = Number(b.readBigUInt64LE(q))
          q += 8
        }
        if (compressedSize === 0xffffffff && q + 8 <= e + 4 + len) {
          compressedSize = Number(b.readBigUInt64LE(q))
          q += 8
        }
        if (localOffset === 0xffffffff && q + 8 <= e + 4 + len) localOffset = Number(b.readBigUInt64LE(q))
      }
      e += 4 + len
    }
    out.push({name, method, compressedSize, size, localOffset})
    p = eEnd + commentLen
  }
  return out
}

// read inflates one entry, failing once more than max bytes come out.
export function read(b, entry, max) {
  const lo = entry.localOffset
  if (lo + 30 > b.length || b.readUInt32LE(lo) !== 0x04034b50) throw new ZipError('zip: not a valid zip file')
  const start = lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt16LE(lo + 28)
  const end = start + entry.compressedSize
  if (end > b.length) throw new ZipError('zip: not a valid zip file')
  const data = b.subarray(start, end)
  if (entry.method === 0) {
    if (data.length > max) throw new ZipError(`${entry.name} is too large`)
    return Buffer.from(data)
  }
  if (entry.method !== 8) throw new ZipError('zip: unsupported compression algorithm')
  const chunks = []
  let total = 0
  let tooLarge = false
  const inflater = new Inflate(chunk => {
    if (tooLarge) return
    total += chunk.length
    if (total > max) {
      tooLarge = true
      return
    }
    chunks.push(Buffer.from(chunk))
  })
  const step = 16 * 1024
  try {
    for (let i = 0; i < data.length && !tooLarge; i += step) inflater.push(data.subarray(i, Math.min(i + step, data.length)), i + step >= data.length)
  } catch (e) {
    throw new ZipError(`zip: ${e.message}`)
  }
  if (tooLarge) throw new ZipError(`${entry.name} is too large`)
  return Buffer.concat(chunks, total)
}
