// WebSocket write/close helpers with the semantics the Go backend had: a
// write either completes or fails within its deadline (a stuck peer is
// disconnected), and close reasons fit in a control frame.
import http from 'node:http'

export class WriteError extends Error {}

// sendWS writes one message and resolves once it was handed to the socket.
export function sendWS(ws, data, {binary = false, timeoutMs = 10000} = {}) {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== ws.OPEN) {
      reject(new WriteError('failed to write msg: WebSocket closed'))
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      ws.terminate()
      reject(new WriteError('failed to write frame: context deadline exceeded'))
    }, Math.max(1, timeoutMs))
    ws.send(data, {binary}, err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(new WriteError(`failed to write msg: ${err.message}`))
      else resolve()
    })
  })
}

// closeWS starts the close handshake; the reason is cut to the 123 bytes a
// close frame can carry.
export function closeWS(ws, code, reason = '') {
  if (ws.readyState !== ws.OPEN && ws.readyState !== ws.CONNECTING) return
  let r = Buffer.from(reason, 'utf8')
  if (r.length > 123) r = r.subarray(0, 123)
  try {
    ws.close(code, r.toString('utf8'))
  } catch {
    ws.terminate()
  }
}

// rejectUpgrade answers an upgrade request with a plain HTTP error.
export function rejectUpgrade(socket, status, text, headers = {}) {
  if (!socket.writable) {
    socket.destroy()
    return
  }
  const body = text + '\n'
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\nContent-Type: text/plain; charset=utf-8\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}\r\n${body}`)
}

// waitPong sends a ping and resolves true on the pong, false on timeout or failure.
export function waitPong(ws, timeoutMs, ctx) {
  return new Promise(resolve => {
    let done = false
    const finish = v => {
      if (done) return
      done = true
      clearTimeout(timer)
      ws.off('pong', onPong)
      ctx?.signal.removeEventListener('abort', onAbort)
      resolve(v)
    }
    const onPong = () => finish(true)
    const onAbort = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    ws.on('pong', onPong)
    ctx?.signal.addEventListener('abort', onAbort, {once: true})
    try {
      ws.ping()
    } catch {
      finish(false)
    }
  })
}
