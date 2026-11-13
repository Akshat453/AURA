// Document management API for the local RAG index. Uploaded files are stored
// under RAG_STORAGE_PATH and are never served back over HTTP; only metadata,
// status and retrieved passages are.
import busboy from 'busboy'
import {httpError, localOnly, readBody, sameOrigin, writeJSON} from '../middleware/security.js'
import {documentJSON, isTextID} from '../services/rag/store.js'
import {trimSpace} from '../utils/gotext.js'

// readMultipartFile reads the first file field `field` (≤ limit bytes; the
// whole body ≤ bodyLimit). Resolves {name, data} or rejects with .status.
export function readMultipartFile(req, field, limit, bodyLimit) {
  return new Promise((resolve, reject) => {
    let bb
    try {
      bb = busboy({headers: req.headers, limits: {files: 1, fileSize: limit, fieldSize: 64 << 10}})
    } catch {
      reject(Object.assign(new Error('not multipart'), {status: 400}))
      return
    }
    let result = null
    let total = 0
    let failed = false
    const fail = e => {
      if (failed) return
      failed = true
      req.unpipe(bb)
      req.resume()
      reject(e)
    }
    req.on('data', chunk => {
      total += chunk.length
      if (total > bodyLimit) fail(Object.assign(new Error('request body too large'), {status: 413}))
    })
    bb.on('file', (name, stream, info) => {
      if (name !== field || result) {
        stream.resume()
        return
      }
      const chunks = []
      let size = 0
      stream.on('data', c => {
        size += c.length
        chunks.push(c)
      })
      stream.on('limit', () => {}) // the caller compares the size with its own limit
      stream.on('end', () => {
        result = {name: info.filename ?? '', data: Buffer.concat(chunks, size), truncated: stream.truncated}
      })
    })
    bb.on('error', e => fail(Object.assign(e, {status: 400})))
    bb.on('close', () => {
      if (failed) return
      if (!result) reject(Object.assign(new Error('no file'), {status: 400}))
      else resolve(result)
    })
    req.pipe(bb)
  })
}

export function registerDocs(srv, route) {
  const disabled = res => {
    if (!srv.docs) {
      httpError(res, 'local document search is disabled (RAG_ENABLED=false)', 404)
      return true
    }
    return false
  }

  route('GET', '/api/docs', localOnly, async (req, res) => {
    if (disabled(res)) return
    const docs = srv.docs.uploads().map(documentJSON) // notes and memos are listed in their own panels
    writeJSON(res, {documents: docs, capabilities: await srv.publicCapabilities(), index_version: srv.docs.indexVersion()})
  })

  route('POST', '/api/docs', localOnly, sameOrigin, async (req, res) => {
    if (disabled(res)) return
    const max = srv.docs.maxUploadBytes()
    let file
    try {
      file = await readMultipartFile(req, 'file', max + 1, max + (1 << 20))
    } catch (e) {
      if (e.status === 413) httpError(res, 'file is too large', 413)
      else httpError(res, "expected a multipart upload with a 'file' field", 400)
      return
    }
    let result
    try {
      result = await srv.docs.upload(srv.baseCtx, file.name, file.data)
    } catch (e) {
      httpError(res, e.message, 422)
      return
    }
    const d = result.document
    srv.log.info({doc_id: d.id, type: d.type, bytes: d.size, duplicate: result.duplicate, replaced: result.replaced}, 'document uploaded')
    writeJSON(res, {document: documentJSON(d), duplicate: result.duplicate, replaced: result.replaced})
  })

  route('GET', '/api/docs/search', localOnly, async (req, res) => {
    if (disabled(res)) return
    const q = trimSpace(String(req.query.q ?? ''))
    if (q === '' || [...q].length > 1000) {
      httpError(res, 'q must be 1-1000 characters', 400)
      return
    }
    const k = Number.parseInt(String(req.query.k ?? ''), 10)
    try {
      writeJSON(res, await srv.docs.search(srv.baseCtx, q, String(req.query.doc ?? ''), /^[+-]?\d+$/.test(String(req.query.k ?? '')) ? k : 0))
    } catch (e) {
      httpError(res, e.message, 500)
    }
  })

  route('DELETE', '/api/docs/:id', localOnly, sameOrigin, (req, res) => {
    if (disabled(res)) return
    if (isTextID(req.params.id)) { // owned by a note or memo: change it there
      httpError(res, 'this entry belongs to a note or voice memo; delete it in the Notes or Memos panel', 409)
      return
    }
    try {
      srv.docs.delete(null, req.params.id)
    } catch (e) {
      httpError(res, e.message, 404)
      return
    }
    writeJSON(res, {status: 'deleted'})
  })

  route('POST', '/api/docs/:id/reindex', localOnly, sameOrigin, (req, res) => {
    if (disabled(res)) return
    if (isTextID(req.params.id)) {
      httpError(res, 'this entry belongs to a note or voice memo', 409)
      return
    }
    try {
      srv.docs.reindex(req.params.id)
    } catch (e) {
      httpError(res, e.message, 404)
      return
    }
    writeJSON(res, {status: 'queued'})
  })

  // The desk-device document switch. The master switch
  // (RAG_SEND_CONTEXT_TO_GEMINI) always wins; the device choice resets to
  // DEVICE_ALLOW_DOC_CONTEXT on restart.
  route('GET', '/api/device-docs', localOnly, (req, res) => writeJSON(res, srv.deviceDocsStatus()))

  route('POST', '/api/device-docs', localOnly, sameOrigin, async (req, res) => {
    let raw
    try {
      raw = await readBody(req, 1 << 10)
    } catch {
      httpError(res, 'expected {"allowed": true|false}', 400)
      return
    }
    let allowed
    try {
      const v = JSON.parse(raw.toString('utf8'))
      allowed = v?.allowed ?? v?.Allowed
    } catch {
      allowed = undefined
    }
    if (typeof allowed !== 'boolean') {
      httpError(res, 'expected {"allowed": true|false}', 400)
      return
    }
    if (!srv.cfg.ragSendContext) {
      httpError(res, 'sending document passages to Gemini is off on this server (RAG_SEND_CONTEXT_TO_GEMINI=false)', 403)
      return
    }
    if (srv.deviceDocs !== allowed) srv.log.info({allowed}, 'device document access changed')
    srv.deviceDocs = allowed
    writeJSON(res, srv.deviceDocsStatus())
  })
}
