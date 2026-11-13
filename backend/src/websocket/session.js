// Per-connection conversation state: bounded history and the single active
// turn. Starting a turn cancels the previous one.
export class Session {
  #maxMessages
  #history = []
  #cancel = null

  constructor(maxTurns) {
    this.#maxMessages = maxTurns * 2
  }

  history() {
    return this.#history.map(m => ({...m}))
  }

  add(role, text) {
    this.#history.push({role, text})
    if (this.#history.length > this.#maxMessages) this.#history = this.#history.slice(this.#history.length - this.#maxMessages)
  }

  clear() {
    this.#history = []
  }

  // begin cancels any running turn and returns the new turn's context.
  begin(parent) {
    if (this.#cancel) this.#cancel()
    const [ctx, cancel] = parent.withCancel()
    this.#cancel = cancel
    return ctx
  }

  abort() {
    if (this.#cancel) {
      this.#cancel()
      this.#cancel = null
    }
  }
}
