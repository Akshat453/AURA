// Cancellation contexts modelled on Go's context package, built on
// AbortController. The Go backend relied on two distinctions that this module
// keeps: a turn that was cancelled (an abort, a newer utterance, a closed
// connection) is never reported as an error, while a deadline is; and some
// work (finishing a started frame, executing an approved action) must not be
// interrupted by the cancellation of the turn that started it (withoutCancel).

export class CanceledError extends Error {
  constructor() {
    super('context canceled')
    this.name = 'CanceledError'
    this.code = 'ECANCELED'
  }
}

export class DeadlineError extends Error {
  constructor() {
    super('context deadline exceeded')
    this.name = 'DeadlineError'
    this.code = 'ETIMEDOUT'
  }
}

export const canceled = new CanceledError()
export const deadlineExceeded = new DeadlineError()

export function isCanceled(err) {
  for (let e = err, i = 0; e && i < 8; e = e.cause, i++) {
    if (e instanceof DeadlineError) return false
    if (e instanceof CanceledError || e?.name === 'AbortError') return true
  }
  return false
}

export function isDeadline(err) {
  for (let e = err, i = 0; e && i < 8; e = e.cause, i++) {
    if (e instanceof DeadlineError || e?.name === 'TimeoutError') return true
  }
  return false
}

export class Context {
  #controller = new AbortController()
  #timer = null

  constructor(parent = null) {
    if (parent) {
      const sig = parent.signal
      if (sig.aborted) {
        this.#controller.abort(sig.reason)
      } else {
        const onAbort = () => this.#abort(sig.reason)
        sig.addEventListener('abort', onAbort, {once: true})
        this.#controller.signal.addEventListener('abort', () => sig.removeEventListener('abort', onAbort), {once: true})
      }
    }
  }

  static background() {
    return new Context()
  }

  get signal() {
    return this.#controller.signal
  }

  // err returns null while the context is live, else canceled or deadlineExceeded.
  get err() {
    return this.#controller.signal.aborted ? this.#controller.signal.reason : null
  }

  #abort(reason) {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (!this.#controller.signal.aborted) this.#controller.abort(reason)
  }

  // withCancel returns a child context and its cancel function.
  withCancel() {
    const child = new Context(this)
    return [child, () => child.#abort(canceled)]
  }

  // withTimeout returns a child that is cancelled after ms with deadlineExceeded.
  withTimeout(ms) {
    const child = new Context(this)
    if (!child.err) {
      child.#timer = setTimeout(() => child.#abort(deadlineExceeded), Math.max(0, ms))
      child.#timer.unref?.()
    }
    return [child, () => child.#abort(canceled)]
  }

  // withoutCancel returns a context that is not cancelled with this one.
  withoutCancel() {
    return new Context()
  }

  // done resolves when the context ends (never rejects).
  done() {
    const sig = this.#controller.signal
    if (sig.aborted) return Promise.resolve()
    return new Promise(resolve => sig.addEventListener('abort', () => resolve(), {once: true}))
  }

  // throwIfDone throws the context's error when it has ended.
  throwIfDone() {
    if (this.err) throw this.err
  }
}

// sleep waits ms or until ctx ends; it rejects with ctx.err when cancelled.
export function sleep(ms, ctx = null) {
  return new Promise((resolve, reject) => {
    if (ctx?.err) {
      reject(ctx.err)
      return
    }
    const t = setTimeout(() => {
      ctx?.signal.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    const onAbort = () => {
      clearTimeout(t)
      reject(ctx.err)
    }
    ctx?.signal.addEventListener('abort', onAbort, {once: true})
  })
}

// race resolves with promise, or rejects with ctx.err if ctx ends first.
export function race(promise, ctx) {
  if (!ctx) return promise
  if (ctx.err) return Promise.reject(ctx.err)
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(ctx.err)
    ctx.signal.addEventListener('abort', onAbort, {once: true})
    promise.then(
      v => {
        ctx.signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      e => {
        ctx.signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}
