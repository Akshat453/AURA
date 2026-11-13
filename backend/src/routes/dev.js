// Development-only STT evaluation tools (/dev/). Registered only when
// VOICE_DEV_TOOLS=true and answering loopback clients only.
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import {httpError, localOnly, readBody, writeJSON} from '../middleware/security.js'
import {publicDir} from '../app.js'
import {compare, loadManifest} from '../utils/eval.js'
import {stamp} from '../utils/time.js'
import {DateTime} from 'luxon'

const sttLanguage = l => (l === 'en' || l === 'hi' ? l : l === 'hinglish' ? 'hi' : 'auto')

export function registerDev(srv, route, app) {
  app.use('/dev', localOnly, express.static(path.join(publicDir, 'devweb'), {cacheControl: false, etag: false, lastModified: false, index: 'index.html', redirect: true}))
  route('GET', '/dev/api/fixtures', localOnly, (req, res) => {
    let m
    try {
      m = loadManifest(srv.cfg.fixturesDir)
    } catch (e) {
      httpError(res, e.message, 500)
      return
    }
    writeJSON(res, {fixtures: m.fixtures ?? null, skipped: m.skipped ?? null, whisper_model: `en: ${srv.modelFor('en')} · hi/hinglish/auto: ${srv.modelFor('hi')}`})
  })
  route('GET', '/dev/fixtures/:id', localOnly, (req, res) => {
    let f
    let wav
    try {
      ;({fixture: f, wav} = srv.loadFixture(req.params.id))
    } catch (e) {
      httpError(res, e.message, 404)
      return
    }
    res.set('Content-Type', 'audio/wav')
    res.set('Content-Disposition', `inline; filename=${JSON.stringify(f.id + '.wav')}`)
    res.send(wav)
  })
  // direct is the baseline: the fixture WAV goes to Whisper unchanged,
  // bypassing the browser, WebSocket and server-side audio processing.
  route('POST', '/dev/api/direct', localOnly, async (req, res) => {
    let body
    try {
      body = JSON.parse((await readBody(req, 1 << 16)).toString('utf8'))
    } catch (e) {
      httpError(res, e.message, 400)
      return
    }
    let f
    let wav
    try {
      ;({fixture: f, wav} = srv.loadFixture(String(body.Fixture ?? body.fixture ?? '')))
    } catch (e) {
      httpError(res, e.message, 404)
      return
    }
    if (typeof srv.stt.transcribeWAV !== 'function') {
      httpError(res, 'STT provider cannot transcribe WAV files', 501)
      return
    }
    const language = String(body.Language ?? body.language ?? '') || f.language
    const out = {fixture: f.id, text: '', language: '', language_sent: sttLanguage(language), model: srv.modelFor(sttLanguage(language)), stt_ms: 0}
    const [ctx, cancel] = srv.baseCtx.withTimeout(srv.cfg.sttTimeout)
    const start = performance.now()
    try {
      const r = await srv.stt.transcribeWAV(ctx, wav, out.language_sent)
      out.stt_ms = Math.trunc(performance.now() - start)
      out.text = r.text
      out.language = r.language
      out.score = compare(f.reference, r.text, f.language)
    } catch (e) {
      out.stt_ms = Math.trunc(performance.now() - start)
      out.error = e.message
    } finally {
      cancel()
    }
    writeJSON(res, out)
  })
  route('POST', '/dev/api/reports', localOnly, async (req, res) => {
    let body
    try {
      body = await readBody(req, 16 << 20)
      JSON.parse(body.toString('utf8'))
    } catch {
      httpError(res, 'report must be JSON', 400)
      return
    }
    try {
      fs.mkdirSync(srv.cfg.reportDir, {recursive: true, mode: 0o755})
      const label = String(req.query.label ?? '').replace(/[^A-Za-z0-9_-]+/g, '-') || 'report'
      const name = `${stamp(DateTime.local())}-${label}.json`
      fs.writeFileSync(path.join(srv.cfg.reportDir, name), body, {mode: 0o644})
      writeJSON(res, {path: path.join(srv.cfg.reportDir, name)})
    } catch (e) {
      httpError(res, e.message, 500)
    }
  })
}
