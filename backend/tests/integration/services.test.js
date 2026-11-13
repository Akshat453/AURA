// External integrations with local fakes (Tavily, Google), session isolation
// and concurrent writes against the scheduler.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import {AssistantServer} from '../../src/app.js'
import {testConfig} from '../../src/config/env.js'
import {silentLogger} from '../../src/config/logger.js'
import {speechLikePCM} from '../../src/utils/audio.js'
import {Tavily} from '../../src/services/websearch/tavily.js'
import {scopeCalendar, scopeGmail} from '../../src/services/google/google.js'
import {AnyRecipient} from '../../src/modules/email/drafts.js'
import {ProfessorService} from '../../src/modules/professor/service.js'
import {FakeLLM, FakeTTS, MemoSTT, ScriptedLLM} from '../helpers/fakes.js'
import {reminderPlan} from '../helpers/plans.js'
import {api, Clock, newDeviceEnv, openTab, startHTTP, testNow, tmpDir, turn} from '../helpers/env.js'

async function serve(t, handler) {
  const s = http.createServer(handler)
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  t.after(() => new Promise(r => s.close(() => r())))
  return `http://127.0.0.1:${s.address().port}`
}

const readJSON = req => new Promise(r => {
  let b = ''
  req.on('data', c => (b += c))
  req.on('end', () => r(b ? JSON.parse(b) : {}))
})

async function mockTavily(t, status) {
  const seen = {calls: 0, query: null}
  const url = await serve(t, async (req, res) => {
    seen.calls++
    const body = await readJSON(req)
    seen.query = body.query
    assert.equal(req.url, '/search')
    assert.equal(req.headers.authorization, 'Bearer tvly-mock')
    if (status !== 200) {
      res.writeHead(status)
      res.end('upstream failure')
      return
    }
    res.end(JSON.stringify({results: [{title: 'Campus news', url: 'https://example.org/news', content: 'The library now opens at 7 am on weekdays.', score: 0.9, published_date: '2026-10-18'}]}))
  })
  const tv = new Tavily('tvly-mock', 3, 2000, 60000)
  tv.baseURL = url
  return {tv, seen}
}

test('web mode searches once and grounds the answer in the results', async t => {
  const env = await newDeviceEnv(t)
  const {tv, seen} = await mockTavily(t, 200)
  env.srv.setRetrieval(null, tv)
  const dev = await env.mustDial('desk-esp32')
  const res = await turn(dev, {turn: 1, pcm: speechLikePCM(16000, 0.6, 0.3), language: 'en', mode: 'web'})
  assert.ok(res.complete && !res.error)
  assert.equal(seen.calls, 1)
  assert.ok(seen.query.includes('utterance'))
  const req = env.llm.seen()
  assert.equal(req.length, 1)
  assert.ok(req[0].evidence.includes('library now opens at 7 am') && req[0].evidence.includes('https://example.org/news'))
})

test('a failed web search still answers and invents no evidence', async t => {
  const env = await newDeviceEnv(t)
  const {tv, seen} = await mockTavily(t, 500)
  env.srv.setRetrieval(null, tv)
  const dev = await env.mustDial('desk-esp32')
  const res = await turn(dev, {turn: 1, pcm: speechLikePCM(16000, 0.6, 0.3), language: 'en', mode: 'web'})
  assert.ok(res.complete)
  assert.ok(seen.calls >= 1 && env.tts.said() !== '')
  for (const r of env.llm.seen()) assert.ok(!r.evidence.includes('library'))
})

test('Google: PKCE connect, single-use state, refresh, calendar, Gmail draft once (never send), revocation', async t => {
  const fake = {paths: [], refreshes: 0, revoked: false, challenge: '', drafts: []}
  const base = await serve(t, async (req, res) => {
    const u = new URL(req.url, 'http://x')
    fake.paths.push(req.method + ' ' + u.pathname)
    if (u.pathname === '/token') {
      const form = new URLSearchParams(await new Promise(r => {
        let b = ''
        req.on('data', c => (b += c))
        req.on('end', () => r(b))
      }))
      if (form.get('grant_type') === 'authorization_code') {
        const sum = crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url')
        if (form.get('code') !== 'good-code' || sum !== fake.challenge) {
          res.writeHead(400)
          return res.end('{"error":"invalid_grant"}')
        }
        return res.end('{"access_token":"at-1","refresh_token":"rt-1","expires_in":1,"scope":"calendar gmail"}')
      }
      if (fake.revoked) {
        res.writeHead(400)
        return res.end('{"error":"invalid_grant"}')
      }
      fake.refreshes++
      return res.end('{"access_token":"at-2","expires_in":3600}')
    }
    if (u.pathname.startsWith('/calendar/v3/calendars/primary/events')) {
      if (req.headers.authorization !== 'Bearer at-2') {
        res.writeHead(401)
        return res.end()
      }
      assert.equal(u.searchParams.get('singleEvents'), 'true')
      assert.equal(u.searchParams.get('orderBy'), 'startTime')
      return res.end(JSON.stringify({items: [
        {summary: 'Department meeting', location: 'Room 12', start: {dateTime: '2026-10-21T15:00:00+05:30'}, end: {dateTime: '2026-10-21T16:00:00+05:30'}},
        {summary: 'Holiday', start: {date: '2026-10-22'}, end: {date: '2026-10-23'}},
        {summary: 'Cancelled', status: 'cancelled', start: {dateTime: '2026-10-21T17:00:00+05:30'}}]}))
    }
    if (u.pathname === '/gmail/v1/users/me/drafts' && req.method === 'POST') {
      const body = await readJSON(req)
      fake.drafts.push(Buffer.from(body.message.raw, 'base64url').toString('utf8'))
      return res.end('{"id":"r-123","message":{"id":"m-1"}}')
    }
    res.writeHead(404) // e.g. any /send endpoint
    res.end()
  })
  const dir = tmpDir()
  const srv = new AssistantServer(testConfig({googleCalendarEnabled: true, gmailDraftsEnabled: true, googleClientID: 'client', googleTokenPath: path.join(dir, 'token.json'),
    googleRedirectURL: 'http://127.0.0.1:8090/api/google/callback'}), silentLogger(), {stt: new MemoSTT(), llm: new FakeLLM(), tts: new FakeTTS()})
  const prof = ProfessorService.open({dir, zoneName: 'Asia/Kolkata'})
  t.after(() => {
    prof.close()
    srv.shutdown()
  })
  srv.setProfessor(prof, {drafts: true})
  assert.ok(srv.enableGoogle())
  Object.assign(srv.google, {authURL: base + '/auth', tokenURL: base + '/token', revokeURL: base + '/revoke', apiBase: base, gmailBase: base})
  const env = await startHTTP(t, srv)
  let r = await fetch(env.base + '/api/google/connect', {redirect: 'manual'})
  assert.equal(r.status, 302)
  const loc = new URL(r.headers.get('location'))
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(loc.searchParams.get('scope'), scopeCalendar + ' ' + scopeGmail)
  assert.ok(!loc.searchParams.get('scope').includes('gmail.send'))
  fake.challenge = loc.searchParams.get('code_challenge')
  assert.equal((await api(env, 'GET', '/api/google/callback?state=forged&code=good-code')).status, 400)
  const state = loc.searchParams.get('state')
  r = await api(env, 'GET', `/api/google/callback?state=${state}&code=good-code`)
  assert.equal(r.status, 200, r.text)
  assert.ok(srv.google.connected())
  assert.equal((await api(env, 'GET', `/api/google/callback?state=${state}&code=good-code`)).status, 400, 'state is single-use')
  const events = await srv.google.events(Date.now(), Date.now() + 86400000)
  assert.equal(events.length, 2)
  assert.equal(events[0].title, 'Department meeting')
  assert.ok(events[1].all_day)
  assert.equal(fake.refreshes, 1)
  const status = (await api(env, 'GET', '/api/professor')).text
  assert.ok(!status.includes('rt-1') && !status.includes('at-2'), 'token leaked in status')
  const d = prof.createDraft({kind: 'email', subject: 'Lecture moved\r\nBcc: attacker@evil.com', body: 'Dear students, the lecture moves to LH-3.', to: ['class@college.edu']}, AnyRecipient, '')
  r = await api(env, 'POST', `/api/drafts/${d.id}/gmail`, null, true)
  assert.equal(r.status, 200, r.text)
  assert.ok(r.text.includes('r-123'))
  const raw = fake.drafts[0]
  assert.ok(raw.includes('To: class@college.edu\r\n') && !raw.includes('\r\nBcc: attacker') && raw.includes('Subject: Lecture moved Bcc: attacker@evil.com\r\n'), raw)
  assert.equal((await api(env, 'POST', `/api/drafts/${d.id}/gmail`, null, true)).status, 409)
  assert.equal(fake.drafts.length, 1)
  assert.equal(prof.draft(d.id).gmail_draft_id, 'r-123')
  fake.revoked = true
  srv.google.token.expiryMs = 0
  srv.google.cache = new Map()
  await assert.rejects(srv.google.events(Date.now(), Date.now() + 2 * 86400000), /revoked/)
  assert.ok(!srv.google.connected())
  assert.ok(!fake.paths.some(p => p.includes('send')), 'a send endpoint was called')
})

test('Google is off without configuration (404)', async t => {
  const srv = new AssistantServer(testConfig({gmailDraftsEnabled: true}), silentLogger(), {stt: new MemoSTT(), llm: new FakeLLM(), tts: new FakeTTS()})
  t.after(() => srv.shutdown())
  assert.equal(srv.enableGoogle(), false)
  const env = await startHTTP(t, srv)
  assert.equal((await api(env, 'GET', '/api/google/connect')).status, 404)
})

test('a browser "yes" never approves the device\'s pending question (and vice versa)', async t => {
  const env = await newDeviceEnv(t, c => Object.assign(c, {actionConfirmationTimeout: 60000, deviceProfessorTools: 'all', professorToolMaxCalls: 4}))
  const prof = ProfessorService.open({dir: tmpDir(), zoneName: 'Asia/Kolkata', now: () => testNow})
  t.after(() => prof.close())
  env.srv.setProfessor(prof, {reminders: true})
  env.llm.scripted = new ScriptedLLM(reminderPlan)
  const web = {...(await startHTTP(t, env.srv)), tabs: []}
  t.after(() => web.tabs.forEach(x => x.terminate()))
  env.stt.texts = ['Remind me to submit attendance tomorrow at 10 AM', 'yes']
  const dev = await env.mustDial('desk-esp32')
  const pcm = speechLikePCM(16000, 0.6, 0.3)
  await turn(dev, {turn: 1, pcm, language: 'en', mode: 'auto'})
  const browser = await openTab(web)
  await browser.say('yes')
  assert.equal(prof.reminders({}).length, 0, 'a browser reply approved the device action')
  await turn(dev, {turn: 2, pcm, language: 'en', mode: 'auto'})
  assert.equal(prof.reminders({}).length, 1)
})

test('concurrent writes stay consistent and each reminder occurrence is notified exactly once', async () => {
  const clock = new Clock(testNow)
  const prof = ProfessorService.open({dir: tmpDir(), zoneName: 'Asia/Kolkata', now: clock.now})
  let notified = 0
  prof.scheduler().subscribe(() => notified++)
  await Promise.all(Array.from({length: 20}, async (_, i) => {
    const r = prof.createReminder({title: `r${i}`, due: '2026-10-21T09:05'}, `act_${i % 10}`) // 10 duplicate action ids
    const n = prof.createNote({body: `note ${i}`}, 'typed', '')
    prof.updateNote(n.id, {body: `edited ${i}`})
    prof.updateReminder(r.id, {title: 'renamed'})
  }))
  assert.equal(prof.reminders({}).length, 10)
  clock.t = testNow + 10 * 60000
  await Promise.all(Array.from({length: 8}, async () => prof.scheduler().fireDue()))
  assert.equal(notified, 10)
  prof.close()
})

test('sessions leave no timers or sockets behind after close', async t => {
  const env = {srv: null}
  const {newBrowserEnv} = await import('../helpers/env.js')
  Object.assign(env, await newBrowserEnv(t, reminderPlan))
  for (let i = 0; i < 5; i++) {
    const tb = await env.open()
    await tb.say('Remind me to submit attendance tomorrow at 10 AM')
    await tb.say('What is my next lecture?')
    await tb.ws.sendEvent({type: 'abort', turn_id: tb.turn})
    tb.ws.close()
  }
  const deadline = Date.now() + 3000
  while (env.srv.browsers.size > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
  assert.equal(env.srv.browsers.size, 0)
  assert.equal(env.srv.clients, 0)
})
