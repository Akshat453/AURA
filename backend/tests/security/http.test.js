// REST API security: loopback-only, same-origin custom header (CSRF),
// unknown fields, size limits, upload validation and the device-docs switch.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import {AssistantServer} from '../../src/app.js'
import {testConfig} from '../../src/config/env.js'
import {silentLogger} from '../../src/config/logger.js'
import {localOnly} from '../../src/middleware/security.js'
import {Registry} from '../../src/modules/device/registry.js'
import {Service as RAGService} from '../../src/services/rag/service.js'
import {FakeLLM, FakeTTS, MemoSTT, WordEmbedder} from '../helpers/fakes.js'
import {api, newBrowserEnv, startHTTP, tmpDir} from '../helpers/env.js'
import {reminderPlan} from '../helpers/plans.js'
import path from 'node:path'

test('state changes need X-Voice-Assistant and a same-host Origin; unknown fields are rejected', async t => {
  const env = await newBrowserEnv(t, reminderPlan)
  assert.equal((await api(env, 'POST', '/api/reminders', {title: 'x', due: '2026-10-22T10:00'}, false)).status, 403)
  assert.equal((await api(env, 'DELETE', '/api/notes/note_x', null, true, {Origin: 'http://evil.example'})).status, 403)
  assert.equal((await api(env, 'POST', '/api/notes', {body: 'x'}, true, {'Sec-Fetch-Site': 'cross-site'})).status, 403)
  let r = await api(env, 'POST', '/api/reminders', {title: 'x', due: '2026-10-22T10:00'}, true)
  assert.equal(r.status, 200, r.text)
  assert.equal(env.reminders().length, 1)
  r = await api(env, 'POST', '/api/timetable', {subject: 'DBMS', weekday: 'Wednesday', start: '10:00', end: '11:00', evil: 1}, true)
  assert.equal(r.status, 400)
  r = await api(env, 'GET', '/api/timetable/day?date=2026-10-21')
  assert.equal(r.status, 200)
  assert.ok(r.text.includes('"weekday":"Wednesday"'))
  // Same-origin requests from the page itself are accepted.
  r = await api(env, 'POST', '/api/notes', {body: 'from the page'}, true, {Origin: env.base, 'Sec-Fetch-Site': 'same-origin'})
  assert.equal(r.status, 200)
})

test('JSON bodies: 256 KB limit, type checks, case-insensitive field names (Go semantics)', async t => {
  const env = await newBrowserEnv(t, reminderPlan)
  let r = await api(env, 'POST', '/api/notes', Buffer.from(JSON.stringify({body: 'x'.repeat(300 << 10)})), true)
  assert.equal(r.status, 400)
  assert.match(r.text, /request body too large/)
  r = await api(env, 'POST', '/api/notes', {body: 5}, true)
  assert.equal(r.status, 400)
  assert.match(r.text, /cannot unmarshal/)
  r = await api(env, 'POST', '/api/notes', {Body: 'case-insensitive'}, true)
  assert.equal(r.status, 200)
  assert.equal(r.json().body, 'case-insensitive')
  r = await api(env, 'POST', '/api/notes', Buffer.from('not json'), true)
  assert.equal(r.status, 400)
  r = await api(env, 'POST', '/api/notes', {body: ''}, true)
  assert.equal(r.status, 422)
  assert.equal((await api(env, 'GET', '/api/notes/note_missing')).status, 404)
  assert.equal((await api(env, 'PUT', '/api/professor')).status, 405)
  assert.equal((await api(env, 'GET', '/nope')).status, 404)
})

test('all /api routes refuse non-loopback clients', async () => {
  const app = express()
  app.get('/x', localOnly, (req, res) => res.send('ok'))
  const fake = {socket: {remoteAddress: '192.168.1.20'}}
  let status = 0
  localOnly(fake, {status(s) {
    status = s
    return this
  }, set() {
    return this
  }, send() {}, headersSent: false}, () => (status = 200))
  assert.equal(status, 403)
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    let ok = false
    localOnly({socket: {remoteAddress: a}}, {}, () => (ok = true))
    assert.ok(ok, a)
  }
  void http
})

test('device-docs switch: toggles, validates, cannot exceed the master switch, refuses cross-site', async t => {
  const mk = async (master, deviceEnv, withDevices) => {
    const srv = new AssistantServer(testConfig({ragSendContext: master, deviceAllowDocContext: deviceEnv}), silentLogger(), {stt: new MemoSTT(), llm: new FakeLLM(), tts: new FakeTTS()})
    if (withDevices) srv.deviceGateway(Registry.open(path.join(tmpDir(), 'devices.json')))
    t.after(() => srv.shutdown())
    return {srv, ...(await startHTTP(t, srv))}
  }
  let env = await mk(true, false, true)
  assert.deepEqual((await api(env, 'GET', '/api/device-docs')).json(), {allowed: false, server_allowed: true, devices_enabled: true})
  for (const on of [true, false, true]) {
    const r = await api(env, 'POST', '/api/device-docs', {allowed: on}, true)
    assert.equal(r.status, 200)
    assert.equal(r.json().allowed, on)
    assert.equal((await api(env, 'GET', '/api/device-docs')).json().allowed, on)
    const c = await env.srv.publicCapabilities()
    assert.equal(c.device_docs, on)
    assert.equal(c.devices_enabled, true)
  }
  for (const bad of ['not json', '{}', '{"allowed":"yes"}', '{"allowed":' + ' '.repeat(2048) + 'true}']) {
    assert.equal((await api(env, 'POST', '/api/device-docs', Buffer.from(bad), true)).status, 400, bad.slice(0, 20))
  }
  assert.equal(env.srv.deviceDocs, true, 'a rejected request must not change the switch')
  assert.equal((await api(env, 'POST', '/api/device-docs', {allowed: false}, true, {'Sec-Fetch-Site': 'cross-site'})).status, 403)
  assert.equal(env.srv.deviceDocs, true)
  env = await mk(false, true, true)
  assert.deepEqual((await api(env, 'GET', '/api/device-docs')).json(), {allowed: false, server_allowed: false, devices_enabled: true})
  const r = await api(env, 'POST', '/api/device-docs', {allowed: true}, true)
  assert.equal(r.status, 403)
  assert.match(r.text, /RAG_SEND_CONTEXT_TO_GEMINI/)
  assert.equal(env.srv.capabilities({allowDocs: env.srv.deviceDocs}).docsToLLM, false)
  env = await mk(true, true, false)
  assert.deepEqual((await api(env, 'GET', '/api/device-docs')).json(), {allowed: true, server_allowed: true, devices_enabled: false})
})

test('document API: upload validation, duplicate detection, size limit, never served back', async t => {
  const srv = new AssistantServer(testConfig({ragSendContext: true}), silentLogger(), {stt: new MemoSTT(), llm: new FakeLLM(), tts: new FakeTTS()})
  const docs = new RAGService({dir: tmpDir(), maxUploadBytes: 64 << 10, chunkTokens: 120, chunkOverlap: 10, topK: 3, hybrid: true, minSimilarity: 0}, new WordEmbedder(), null, null)
  t.after(() => {
    docs.close()
    srv.shutdown()
  })
  srv.setRetrieval(docs, null)
  const env = await startHTTP(t, srv)
  const upload = async (name, data, header = true) => {
    const fd = new FormData()
    fd.append('file', new Blob([data]), name)
    const res = await fetch(env.base + '/api/docs', {method: 'POST', body: fd, headers: header ? {'X-Voice-Assistant': '1'} : {}})
    return {status: res.status, text: await res.text()}
  }
  assert.equal((await upload('a.md', 'hello', false)).status, 403)
  let r = await upload('../../a.md', '# Unit 3\n\nNormalization.')
  assert.equal(r.status, 200, r.text)
  const doc = JSON.parse(r.text).document
  assert.equal(doc.name, 'a.md')
  assert.equal(JSON.parse((await upload('b.md', '# Unit 3\n\nNormalization.')).text).duplicate, true)
  assert.equal((await upload('tool.exe', 'MZ')).status, 422)
  assert.equal((await upload('fake.pdf', 'not a pdf')).status, 422)
  assert.equal((await upload('big.txt', 'a'.repeat(80 << 10))).status, 422)
  assert.equal((await upload('huge.txt', 'a'.repeat(2 << 20))).status, 413)
  const list = (await api(env, 'GET', '/api/docs')).json()
  assert.equal(list.documents.length, 1)
  assert.ok(!('file' in list.documents[0]), 'stored file names are not exposed')
  assert.equal((await api(env, 'GET', `/api/docs/${doc.id}`)).status, 405, 'files are never served back')
  assert.equal((await api(env, 'GET', '/api/docs/search?q=')).status, 400)
  assert.equal((await api(env, 'DELETE', '/api/docs/note-abc', null, true)).status, 409)
  assert.equal((await api(env, 'DELETE', `/api/docs/${doc.id}`, null, true)).status, 200)
  assert.equal((await api(env, 'DELETE', `/api/docs/${doc.id}`, null, true)).status, 404)
})

test('responses never cache and never sniff', async t => {
  const env = await newBrowserEnv(t, reminderPlan)
  for (const p of ['/', '/web/app.js', '/healthz', '/api/professor', '/nope']) {
    const r = await api(env, 'GET', p)
    assert.equal(r.res.headers.get('x-content-type-options'), 'nosniff', p)
    assert.equal(r.res.headers.get('cache-control'), 'no-store', p)
  }
  assert.equal((await api(env, 'GET', '/healthz')).res.headers.get('x-powered-by'), null)
})
