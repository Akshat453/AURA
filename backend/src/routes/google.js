// Google Calendar / Gmail draft routes (optional integration).
import {httpError, localOnly, sameOrigin, writeJSON} from '../middleware/security.js'
import {isNotFound} from '../modules/professor/common.js'

export function registerGoogle(srv, route) {
  const off = res => {
    if (!srv.google) {
      httpError(res, 'Google integration is not configured (set GOOGLE_CALENDAR_ENABLED or GMAIL_DRAFTS_ENABLED and GOOGLE_OAUTH_CLIENT_ID)', 404)
      return true
    }
    return false
  }

  // connect redirects to Google's consent page (the professor started it).
  route('GET', '/api/google/connect', localOnly, (req, res) => {
    if (off(res)) return
    res.redirect(302, srv.google.connectURL())
  })

  route('GET', '/api/google/callback', localOnly, async (req, res) => {
    if (off(res)) return
    const g = srv.google
    const st = g.takeState(String(req.query.state ?? '')) // single use
    if (!st) {
      httpError(res, 'invalid or expired sign-in request; start again from the assistant page', 400)
      return
    }
    if (req.query.error) {
      httpError(res, 'Google sign-in was not completed: ' + req.query.error, 400)
      return
    }
    let t
    try {
      t = await g.exchange(String(req.query.code ?? ''), st.verifier)
    } catch (e) {
      httpError(res, 'Google sign-in failed: ' + e.message, 502)
      return
    }
    if (!t.refresh_token) {
      httpError(res, "Google did not return a refresh token; remove the app's access in your Google account and connect again", 502)
      return
    }
    try {
      g.save(t)
    } catch (e) {
      httpError(res, 'could not store the Google token: ' + e.message, 500)
      return
    }
    srv.log.info({scopes: t.scope}, 'google account connected')
    res.set('Content-Type', 'text/html; charset=utf-8')
    res.send('<!doctype html><meta charset="utf-8"><p>Google account connected. You can close this tab and return to the assistant.</p>')
  })

  route('POST', '/api/google/disconnect', localOnly, sameOrigin, async (req, res) => {
    if (off(res)) return
    await srv.google.revoke()
    writeJSON(res, {status: 'disconnected'})
  })

  route('GET', '/api/google/events', localOnly, async (req, res) => {
    if (off(res)) return
    if (!srv.google.calendar) {
      httpError(res, 'Google Calendar is disabled', 404)
      return
    }
    let days = /^[+-]?\d+$/.test(String(req.query.days ?? '')) ? Number(req.query.days) : 0
    days = Math.min(Math.max(days, 1), 14)
    const from = Date.now()
    try {
      writeJSON(res, {events: await srv.google.events(from, from + days * 86400000)})
    } catch (e) {
      httpError(res, e.message, 502)
    }
  })

  // gmail copies a saved local draft to Gmail as a draft, once. Never sends.
  route('POST', '/api/drafts/:id/gmail', localOnly, sameOrigin, async (req, res) => {
    if (off(res) || !srv.prof) return
    const g = srv.google
    if (!g.gmail) {
      httpError(res, 'Gmail drafts are disabled', 404)
      return
    }
    const id = req.params.id
    if (g.drafting.has(id)) {
      httpError(res, 'this draft is already being created in Gmail', 409)
      return
    }
    g.drafting.add(id)
    try {
      let d
      try {
        d = srv.prof.draft(id)
      } catch (e) {
        if (isNotFound(e)) httpError(res, 'not found', 404)
        else httpError(res, e.message, 422)
        return
      }
      if (d.kind !== 'email') {
        httpError(res, 'only email drafts can be copied to Gmail', 400)
        return
      }
      if (d.gmail_draft_id) {
        httpError(res, 'a Gmail draft was already created for this draft (id ' + d.gmail_draft_id + ')', 409)
        return
      }
      let gid
      try {
        gid = await g.createDraft(d.recipients.to, d.recipients.cc, d.recipients.bcc, d.subject, d.body)
      } catch (e) {
        httpError(res, 'Gmail draft not created: ' + e.message, 502)
        return
      }
      try {
        srv.prof.setGmailDraftID(id, gid)
      } catch (e) {
        httpError(res, 'the Gmail draft ' + gid + ' was created but could not be recorded locally: ' + e.message, 500)
        return
      }
      srv.log.info({draft_id: id}, 'gmail draft created') // ids only; no content
      writeJSON(res, {gmail_draft_id: gid, status: 'created (not sent)'})
    } finally {
      g.drafting.delete(id)
    }
  })
}
