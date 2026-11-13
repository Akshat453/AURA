// Confirmation workflow for data-changing assistant actions. A tool never
// changes data directly: it stages a proposal with a server-generated
// summary and an execute function. The proposal becomes confirmable only
// after the turn that asked the question has been delivered completely, and
// it runs only when the user explicitly approves it (a classified voice/text
// reply or a browser button carrying its ID). Model output, tool results and
// retrieved documents can never approve an action.
import crypto from 'node:crypto'
import {Context} from '../../utils/context.js'

export const Status = Object.freeze({
  Staged: 'staged', // proposed during a turn still in progress
  Pending: 'pending', // question delivered; awaiting the user's decision
  Executing: 'executing', // approved; running now
  Done: 'done', // executed and confirmed by storage
  Failed: 'failed', // approved, but validation or storage failed
  Rejected: 'rejected', // the user said no
  Expired: 'expired', // no decision within the timeout
  Superseded: 'superseded', // the user moved on to another request
  Discarded: 'discarded', // the turn asking the question did not complete
})

export class ActionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ActionError'
    this.code = code
  }
}

export const ErrUnknown = 'unknown'
export const ErrDecided = 'decided'
export const ErrExpired = 'expired'
export const ErrBusy = 'busy'
export const ErrOneAtATime = 'one_at_a_time'

const messages = {
  [ErrUnknown]: 'unknown action',
  [ErrDecided]: 'this action was already decided',
  [ErrExpired]: 'this confirmation request has expired; nothing was changed',
  [ErrBusy]: 'this action is already being executed',
  [ErrOneAtATime]: 'only one change can be confirmed at a time; ask the user about the next change after this one is decided',
}

export const actionError = (code, extra) => new ActionError(code, extra ? `${messages[code]}: ${extra}` : messages[code])
export const isActionError = (e, code) => e instanceof ActionError && e.code === code

const newID = () => 'act_' + crypto.randomBytes(12).toString('hex')

// actionJSON is the public view sent to browsers (history is never sent).
export function actionJSON(a) {
  if (!a) return null
  const out = {id: a.id, kind: a.kind, status: a.status, summary: a.summary}
  if (a.details && Object.keys(a.details).length) out.details = a.details
  if (a.editable?.length) out.editable = a.editable
  if (a.expiresAt) out.expires_at = a.expiresAt
  if (a.message) out.message = a.message
  if (a.language) out.language = a.language
  return out
}

const snapshot = e => ({id: e.id, kind: e.kind, status: e.status, summary: e.summary, details: e.details, editable: e.editable, expiresAt: e.expiresAt,
  message: e.message, history: e.history, language: e.language})

// Session holds the actions of one client connection (a browser tab or one
// ESP32 session). Actions are never shared between sessions.
export class Session {
  #timeout
  #staged = null
  #pending = null
  #recent = new Map() // decided actions, for replay and expiry messages
  #order = []
  now = () => Date.now()

  constructor(timeoutMs) {
    this.#timeout = timeoutMs > 0 ? timeoutMs : 60000
  }

  setClock(now) {
    this.now = now
  }

  // stage records a proposal made during turn. Only one proposal per turn.
  // proposal: {kind, summary, details, editable, execute(ctx, actionID, edits), rejected, history, language}
  stage(turn, p) {
    if (typeof p.execute !== 'function' || !p.summary) throw new Error('invalid proposal')
    if (this.#staged && this.#staged.turn === turn) throw actionError(ErrOneAtATime)
    const e = {id: newID(), kind: p.kind, status: Status.Staged, summary: p.summary, details: p.details ?? null, editable: p.editable ?? [],
      expiresAt: null, message: '', history: p.history ?? '', language: p.language ?? '', turn, proposal: p}
    this.#staged = e
    return snapshot(e)
  }

  // staged returns the proposal staged during turn, if any.
  staged(turn) {
    return this.#staged && this.#staged.turn === turn ? snapshot(this.#staged) : null
  }

  // commit makes the proposal of a completed turn answerable and starts its
  // timeout. An older pending action is superseded.
  commit(turn) {
    if (!this.#staged || this.#staged.turn !== turn) return null
    if (this.#pending) this.#finish(this.#pending, Status.Superseded, '')
    const e = this.#staged
    this.#staged = null
    e.status = Status.Pending
    e.expiresAt = new Date(this.now() + this.#timeout).toISOString()
    e.expiresMs = this.now() + this.#timeout
    this.#pending = e
    return snapshot(e)
  }

  // discard drops the proposal of a turn that failed or was interrupted: the
  // user never heard the complete question, so it cannot be confirmed.
  discard(turn) {
    if (this.#staged && this.#staged.turn === turn) {
      this.#finish(this.#staged, Status.Discarded, '')
      this.#staged = null
    }
  }

  // pending returns {action, ok, expired}. An expired action is moved to the
  // decided list and reported with ok=false, expired=true.
  pending() {
    if (!this.#pending) return {action: null, ok: false, expired: false}
    if (!(this.now() < this.#pending.expiresMs)) {
      const e = this.#pending
      this.#finish(e, Status.Expired, messages[ErrExpired])
      return {action: snapshot(e), ok: false, expired: true}
    }
    return {action: snapshot(this.#pending), ok: true, expired: false}
  }

  // lastExpired returns an action that expired within the last windowMs, so a
  // late "yes" gets a clear answer instead of being sent to the model.
  lastExpired(windowMs) {
    if (this.#pending && !(this.now() < this.#pending.expiresMs)) this.#finish(this.#pending, Status.Expired, messages[ErrExpired])
    for (let i = this.#order.length - 1; i >= 0; i--) {
      const e = this.#recent.get(this.#order[i])
      if (e.status === Status.Expired && this.now() - e.expiresMs < windowMs) return snapshot(e)
      if (e.status !== Status.Expired) return null
    }
    return null
  }

  // supersede cancels the pending action because the user asked something else.
  supersede() {
    if (!this.#pending) return null
    const e = this.#pending
    this.#finish(e, Status.Superseded, '')
    return snapshot(e)
  }

  #finish(e, status, message) {
    e.status = status
    e.message = message
    if (this.#pending === e) this.#pending = null
    this.#remember(e)
  }

  #remember(e) {
    if (this.#recent.has(e.id)) return
    this.#recent.set(e.id, e)
    this.#order.push(e.id)
    if (this.#order.length > 32) { // bounded replay memory
      this.#recent.delete(this.#order[0])
      this.#order.shift()
    }
  }

  // decide applies the user's decision to action id and resolves the action
  // snapshot; failures throw an ActionError (with .action) or the execution
  // error. Approval executes at most once: a repeated or concurrent decision
  // for the same id changes nothing.
  async decide(ctx, id, approve, edits) {
    const e = this.#pending
    if (!e || e.id !== id) {
      const old = this.#recent.get(id)
      if (old) {
        const code = old.status === Status.Expired ? ErrExpired : old.status === Status.Executing ? ErrBusy : ErrDecided
        throw Object.assign(actionError(code), {action: snapshot(old)})
      }
      if (this.#staged && this.#staged.id === id) throw Object.assign(actionError(ErrUnknown, 'the question has not been delivered yet'), {action: null})
      throw Object.assign(actionError(ErrUnknown), {action: null})
    }
    if (!(this.now() < e.expiresMs)) {
      this.#finish(e, Status.Expired, messages[ErrExpired])
      throw Object.assign(actionError(ErrExpired), {action: snapshot(e)})
    }
    if (!approve) {
      this.#finish(e, Status.Rejected, e.proposal.rejected || 'Okay, nothing was changed.')
      return snapshot(e)
    }
    const allowed = new Set(e.editable)
    for (const k of Object.keys(edits ?? {})) {
      if (!allowed.has(k)) throw Object.assign(new Error(`field ${JSON.stringify(k)} cannot be edited for this action`), {action: snapshot(e)})
    }
    e.status = Status.Executing
    this.#pending = null
    this.#remember(e) // a concurrent decide now sees it as busy, then decided
    let res
    try {
      res = await e.proposal.execute((ctx ?? Context.background()).withoutCancel(), e.id, edits ?? {})
    } catch (err) {
      e.status = Status.Failed
      e.message = err.message
      err.action = snapshot(e)
      throw err
    }
    e.status = Status.Done
    e.message = res.message
    e.history = res.history ?? ''
    e.result = res
    return snapshot(e)
  }

  get(id) {
    if (this.#pending?.id === id) return snapshot(this.#pending)
    if (this.#staged?.id === id) return snapshot(this.#staged)
    const e = this.#recent.get(id)
    return e ? snapshot(e) : null
  }
}
