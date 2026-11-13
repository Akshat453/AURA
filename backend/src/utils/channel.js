// A bounded FIFO with Go channel semantics, used where the Go backend used
// buffered channels for back-pressure: producers wait while the buffer is
// full, so memory stays bounded however long a reply is.

export class ChannelClosedError extends Error {
  constructor() {
    super('send on closed channel')
    this.name = 'ChannelClosedError'
  }
}

export class Channel {
  #buf = []
  #cap
  #closed = false
  #receivers = [] // waiting receive resolvers
  #senders = [] // waiting {value, resolve, reject, ctx, onAbort}

  constructor(capacity = 0) {
    this.#cap = Math.max(0, capacity)
  }

  get closed() {
    return this.#closed
  }

  get length() {
    return this.#buf.length
  }

  // send waits for room; it rejects with ctx.err if ctx ends first, and with
  // ChannelClosedError if the channel is closed.
  send(value, ctx = null) {
    if (this.#closed) return Promise.reject(new ChannelClosedError())
    if (ctx?.err) return Promise.reject(ctx.err)
    const r = this.#receivers.shift()
    if (r) {
      r({value, ok: true})
      return Promise.resolve()
    }
    if (this.#buf.length < this.#cap) {
      this.#buf.push(value)
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const waiter = {value, resolve, reject, ctx, onAbort: null}
      if (ctx) {
        waiter.onAbort = () => {
          const i = this.#senders.indexOf(waiter)
          if (i >= 0) this.#senders.splice(i, 1)
          reject(ctx.err)
        }
        ctx.signal.addEventListener('abort', waiter.onAbort, {once: true})
      }
      this.#senders.push(waiter)
    })
  }

  // recv resolves {value, ok}; ok is false once the channel is closed and drained.
  recv(ctx = null) {
    if (this.#buf.length > 0) {
      const value = this.#buf.shift()
      this.#admitSender()
      return Promise.resolve({value, ok: true})
    }
    const s = this.#takeSender()
    if (s) return Promise.resolve({value: s.value, ok: true})
    if (this.#closed) return Promise.resolve({value: undefined, ok: false})
    if (ctx?.err) return Promise.reject(ctx.err)
    return new Promise((resolve, reject) => {
      const waiter = msg => {
        if (ctx) ctx.signal.removeEventListener('abort', onAbort)
        resolve(msg)
      }
      const onAbort = () => {
        const i = this.#receivers.indexOf(waiter)
        if (i >= 0) this.#receivers.splice(i, 1)
        reject(ctx.err)
      }
      if (ctx) ctx.signal.addEventListener('abort', onAbort, {once: true})
      this.#receivers.push(waiter)
    })
  }

  #takeSender() {
    const s = this.#senders.shift()
    if (!s) return null
    if (s.ctx && s.onAbort) s.ctx.signal.removeEventListener('abort', s.onAbort)
    s.resolve()
    return s
  }

  #admitSender() {
    if (this.#buf.length >= this.#cap) return
    const s = this.#takeSender()
    if (s) this.#buf.push(s.value)
  }

  // close wakes all receivers; pending senders fail like a Go send on a closed channel.
  close() {
    if (this.#closed) return
    this.#closed = true
    for (const r of this.#receivers.splice(0)) r({value: undefined, ok: false})
    for (const s of this.#senders.splice(0)) {
      if (s.ctx && s.onAbort) s.ctx.signal.removeEventListener('abort', s.onAbort)
      s.reject(new ChannelClosedError())
    }
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      const {value, ok} = await this.recv()
      if (!ok) return
      yield value
    }
  }
}
