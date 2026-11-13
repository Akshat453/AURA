// Locally saved email and announcement drafts. Nothing here sends email: the
// optional Gmail adapter can only create Gmail drafts, and the browser opens
// Gmail / Outlook / the default mail app for the professor to review and send.
// Addresses are never invented: a draft proposed by the assistant may only use
// addresses the user actually typed or said in this conversation.
import {runeLen} from '../../utils/gotext.js'
import {clean, defineJSON, localTime, newID, NotFoundError, nullable} from '../professor/common.js'
import {maxNoteRunes} from '../notes/notes.js'

// AnyRecipient disables the "the user provided this address" check (drafts
// the professor edits directly on the web page).
export const AnyRecipient = '\x00'

// An addr-spec as Go's net/mail.ParseAddress accepts it and returns unchanged
// (dot-atom local part and domain; UTF-8 allowed as in RFC 6532).
const atext = "[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~\\u0080-\\uFFFF]"
const dotAtom = `${atext}+(?:\\.${atext}+)*`
const addrSpec = new RegExp(`^${dotAtom}@${dotAtom}$`, 'u')

function normalizeAddresses(list, provided) {
  const seen = new Set()
  const out = []
  for (const item of list ?? []) {
    for (let a of String(item).split(/[,; ]/)) {
      a = a.replace(/^[<>"' ]+|[<>"' ]+$/g, '')
      if (a === '') continue
      if (!addrSpec.test(a) || !a.slice(a.lastIndexOf('@') + 1).includes('.')) throw new Error(`${JSON.stringify(a)} is not a valid email address`)
      const low = a.toLowerCase()
      if (provided !== AnyRecipient && !provided.toLowerCase().includes(low)) {
        throw new Error(`the address ${a} was not given by the user; never invent recipients — leave the field empty`)
      }
      if (!seen.has(low)) {
        seen.add(low)
        out.push(a)
      }
    }
  }
  if (out.length > 50) throw new Error('at most 50 recipients per field')
  return out.length ? out : null
}

// prepareDraft validates a draft; every recipient must appear in provided.
export function prepareDraft(input, provided) {
  const inp = {...input}
  if (inp.kind !== 'email' && inp.kind !== 'announcement') throw new Error('kind must be email or announcement')
  inp.subject = clean(inp.subject, 300)
  inp.audience = clean(inp.audience, 200)
  inp.body = clean(inp.body, maxNoteRunes + 1)
  if (inp.subject === '') throw new Error('a subject (or announcement title) is required')
  if (inp.body === '') throw new Error('the draft body is empty')
  if (runeLen(inp.body) > maxNoteRunes) throw new Error(`drafts are limited to ${maxNoteRunes} characters`)
  inp.to = normalizeAddresses(inp.to, provided)
  inp.cc = normalizeAddresses(inp.cc, provided)
  inp.bcc = normalizeAddresses(inp.bcc, provided)
  if (inp.kind === 'announcement' && (inp.to?.length ?? 0) + (inp.cc?.length ?? 0) + (inp.bcc?.length ?? 0) > 0) {
    throw new Error('announcements have an audience, not email recipients')
  }
  return inp
}

// recipientsJSON is the stored/serialised form ({to?, cc?, bcc?}).
export function recipientsJSON(r) {
  const out = {}
  if (r?.to?.length) out.to = r.to
  if (r?.cc?.length) out.cc = r.cc
  if (r?.bcc?.length) out.bcc = r.bcc
  return out
}

function draftJSON() {
  const out = {id: this.id, kind: this.kind, subject: this.subject, recipients: recipientsJSON(this.recipients)}
  if (this.audience) out.audience = this.audience
  out.body = this.body
  if (this.gmail_draft_id) out.gmail_draft_id = this.gmail_draft_id
  out.created_at = localTime(this.createdAt)
  out.updated_at = localTime(this.updatedAt)
  return out
}

function scanDraft(r) {
  let rec
  try {
    rec = JSON.parse(r.recipients) ?? {}
  } catch {
    rec = {}
  }
  const recipients = {to: rec.to ?? null, cc: rec.cc ?? null, bcc: rec.bcc ?? null}
  return defineJSON({id: r.id, kind: r.kind, subject: r.subject, recipients, audience: r.audience, body: r.body, gmail_draft_id: r.gmail_draft_id,
    createdAt: r.created_at, updatedAt: r.updated_at}, draftJSON)
}

const draftColumns = 'id, kind, subject, recipients, audience, body, gmail_draft_id, created_at, updated_at'

export const methods = {
  // createDraft stores a validated draft (idempotent per action id).
  createDraft(input, provided, actionID = '') {
    const existing = this.existingByAction('drafts', actionID)
    if (existing) return this.draft(existing)
    const inp = prepareDraft(input, provided)
    const rec = JSON.stringify(recipientsJSON({to: inp.to, cc: inp.cc, bcc: inp.bcc}))
    const now = Math.floor(this.nowMs() / 1000)
    const id = newID('draft_')
    try {
      this.db.prepare('INSERT INTO drafts(id, kind, subject, recipients, audience, body, action_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, inp.kind, inp.subject, rec, inp.audience, inp.body, nullable(actionID), now, now)
    } catch (e) {
      const first = this.raced(e, 'drafts', actionID)
      if (first) return this.draft(first)
      throw e
    }
    return this.draft(id)
  },

  // updateDraft replaces a draft's content (edited by the professor on the page).
  updateDraft(id, input) {
    const old = this.draft(id)
    const inp = prepareDraft({...input, kind: old.kind}, AnyRecipient)
    const rec = JSON.stringify(recipientsJSON({to: inp.to, cc: inp.cc, bcc: inp.bcc}))
    this.db.prepare('UPDATE drafts SET subject=?, recipients=?, audience=?, body=?, updated_at=? WHERE id=?').run(inp.subject, rec, inp.audience, inp.body, Math.floor(this.nowMs() / 1000), id)
    return this.draft(id)
  },

  // setGmailDraftID records the Gmail draft created for a local draft.
  setGmailDraftID(id, gmailID) {
    this.db.prepare('UPDATE drafts SET gmail_draft_id=?, updated_at=? WHERE id=?').run(gmailID, Math.floor(this.nowMs() / 1000), id)
  },

  deleteDraft(id) {
    if (this.db.prepare('DELETE FROM drafts WHERE id=?').run(id).changes === 0) throw new NotFoundError()
  },

  draft(id) {
    const r = this.db.prepare(`SELECT ${draftColumns} FROM drafts WHERE id=?`).get(id)
    if (!r) throw new NotFoundError()
    return scanDraft(r)
  },

  // drafts lists drafts, newest first; kind filters email or announcement.
  drafts(kind = '', limit = 0) {
    let q = `SELECT ${draftColumns} FROM drafts`
    const args = []
    if (kind) {
      q += ' WHERE kind=?'
      args.push(kind)
    }
    if (limit <= 0 || limit > 500) limit = 100
    q += ` ORDER BY updated_at DESC LIMIT ${limit}`
    return this.db.prepare(q).all(...args).map(scanDraft)
  },
}
