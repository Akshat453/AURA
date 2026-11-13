#!/usr/bin/env node
// Read-only screenshot tour of the web UI for the project report (headless
// Chrome over the DevTools protocol, no extra dependencies). It only navigates
// and opens items; it never saves, deletes or calls Gemini, so it is safe to
// run against the seeded demo instance:
//
//   ./scripts/start-demo.sh
//   node scripts/report-screenshots.mjs --url http://127.0.0.1:8091 --out docs/report/screenshots
import {spawn} from 'node:child_process'
import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parseArgs} from 'node:util'

const {values: opt} = parseArgs({options: {
  url: {type: 'string', default: 'http://127.0.0.1:8091'}, out: {type: 'string', default: 'docs/report/screenshots'},
  chrome: {type: 'string', default: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'},
}})
const sleep = ms => new Promise(r => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'report-shots-'))
const port = 9400 + Math.floor(Math.random() * 500)
const chrome = spawn(opt.chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run',
  '--no-default-browser-check', '--window-size=1440,900', 'about:blank'], {stdio: 'ignore'})
process.on('exit', () => { chrome.kill(); try { rmSync(profile, {recursive: true, force: true}) } catch {} })

let targets
for (let i = 0; i < 100 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() } catch { await sleep(100) } }
const socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej })
let id = 0
const waiting = new Map(), problems = []
socket.onmessage = ({data}) => {
  const m = JSON.parse(data)
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
}
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; waiting.set(i, r); socket.send(JSON.stringify({id: i, method, params})) })
const js = async expr => (await cdp('Runtime.evaluate', {expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true})).result?.result?.value
const until = async (what, expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr).catch(() => null)) return; await sleep(150) } throw new Error(`timed out: ${what}`) }
const viewport = (width, height, mobile = false) => cdp('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 2, mobile})
mkdirSync(opt.out, {recursive: true})
const taken = []
async function shot(name) {
  await sleep(600)
  const r = await cdp('Page.captureScreenshot', {format: 'png'})
  writeFileSync(join(opt.out, `${name}.png`), Buffer.from(r.result.data, 'base64'))
  taken.push(name)
}
const go = async view => { await js(`location.hash = '#/${view}'; return true`); await until(view, `return !document.querySelector('section[data-view="${view}"]').hidden`) }
const settled = sel => until(sel, `const e = document.querySelector(${JSON.stringify(sel)}); return e && !e.classList.contains('loading') && e.children.length > 0`)
const clickFirst = sel => js(`const e = document.querySelector(${JSON.stringify(sel)}); if (e) e.click(); return !!e`)

await cdp('Runtime.enable')
await cdp('Page.enable')
await viewport(1440, 900)
await cdp('Page.navigate', {url: `${opt.url}/#/dashboard`})
await until('connected', `return document.querySelector('#connection .label')?.textContent === 'Connected'`)

await go('dashboard'); await settled('#dashToday'); await settled('#dashReminders'); await shot('01-dashboard')
await go('assistant'); await shot('02-assistant')
await go('timetable'); await settled('#dayList'); await shot('03-timetable-day')
await clickFirst('[data-tt="week"]'); await until('week', `return document.querySelectorAll('#weekGrid .day-col').length === 7`); await shot('04-timetable-week')
await go('reminders'); await until('reminders', `return document.querySelectorAll('section[data-view="reminders"] li').length > 2`); await shot('05-reminders')
await go('notes'); await until('notes', `return document.querySelectorAll('#noteList li button').length > 2`)
await js(`const b = [...document.querySelectorAll('#noteList li button')].find(x => x.textContent.includes('sprint planning')) || document.querySelector('#noteList li button'); b.click(); return true`); await sleep(400); await shot('06-notes')
await go('memos'); await sleep(800); await shot('07-voice-memos')
await go('documents'); await until('docs', `return document.querySelectorAll('section[data-view="documents"] table tbody tr').length > 0`); await shot('08-documents')
await go('drafts'); await until('drafts', `return document.querySelectorAll('#draftList li button').length > 2`)
await js(`const b = [...document.querySelectorAll('#draftList li button')].find(x => x.textContent.includes('Seminar Hall')) || document.querySelector('#draftList li button'); b.click(); return true`); await sleep(400); await shot('09-email-drafts')
await go('accounts'); await shot('10-connected-accounts')
await go('settings'); await sleep(800); await shot('11-settings')
await viewport(390, 844, true); await go('dashboard'); await settled('#dashToday'); await shot('12-mobile-dashboard')
await go('timetable'); await clickFirst('[data-tt="day"]'); await settled('#dayList'); await shot('13-mobile-timetable')

console.log(JSON.stringify({screenshots: taken, problems}))
process.exit(problems.length ? 1 : 0)
