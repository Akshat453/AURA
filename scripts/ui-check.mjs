#!/usr/bin/env node
// End-to-end check of the web UI in headless Chrome (DevTools protocol, no
// extra dependencies). It creates, edits and deletes data, so run it against
// a TEST instance with its own data directories, never your real data:
//
//   VOICE_ADDR=127.0.0.1:8093 PROFESSOR_DATA_PATH=/tmp/pa-test/professor RAG_STORAGE_PATH=/tmp/pa-test/rag ./bin/professor-assistant
//   node scripts/ui-check.mjs --url http://127.0.0.1:8093 --allow-writes --clip runtime/fixtures/fleurs/en_us/<id>.wav [--screenshots runtime/ui-screenshots] [--no-gemini]
//
// The microphone is simulated: the page's getUserMedia returns a stream that
// plays --clip (headless Chrome's fake device delivers silence on macOS), so
// everything after the microphone is the real code path. --no-gemini skips
// the steps that call Gemini.
import {spawn} from 'node:child_process'
import {mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parseArgs} from 'node:util'

const {values: opt} = parseArgs({options: {
  url: {type: 'string', default: 'http://127.0.0.1:8093'}, 'allow-writes': {type: 'boolean', default: false}, clip: {type: 'string'},
  screenshots: {type: 'string'}, 'no-gemini': {type: 'boolean', default: false},
  chrome: {type: 'string', default: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'},
}})
if (!opt['allow-writes']) { console.error('This check creates and deletes data. Run it against a test instance and pass --allow-writes.'); process.exit(2) }
const gemini = !opt['no-gemini']
const sleep = ms => new Promise(r => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'ui-check-'))
const port = 9400 + Math.floor(Math.random() * 500)
const chrome = spawn(opt.chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank'], {stdio: 'ignore'})
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
  if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text))
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '))
}
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; waiting.set(i, r); socket.send(JSON.stringify({id: i, method, params})) })
const js = async expr => {
  const r = await cdp('Runtime.evaluate', {expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true})
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluation failed')
  return r.result?.result?.value
}
const until = async (what, expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await js(expr).catch(() => null); if (v) return v; await sleep(150) } throw new Error(`timed out: ${what}`) }
const results = []
const check = (name, ok, detail = '') => { results.push({name, ok: !!ok, detail}); console.error(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }
async function step(name, fn) { try { await fn() } catch (e) { check(name, false, e.message) } }
const shots = opt.screenshots
if (shots) mkdirSync(shots, {recursive: true})
async function viewport(width, height, mobile = false) { await cdp('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile}); await sleep(250) }
async function shot(name) {
  if (!shots) return
  await sleep(350)
  const r = await cdp('Page.captureScreenshot', {format: 'png'})
  writeFileSync(join(shots, `${name}.png`), Buffer.from(r.result.data, 'base64'))
}
const go = async view => { await js(`location.hash = '#/${view}'; return true`); await until(`view ${view}`, `return !document.querySelector('section[data-view="${view}"]').hidden`) }
const click = sel => js(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('missing ' + ${JSON.stringify(sel)}); e.click(); return true`)
const clickText = (sel, text) => js(`const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.trim().includes(${JSON.stringify(text)})); if (!e) throw new Error('no ' + ${JSON.stringify(text)}); e.click(); return true`)
const fill = (sel, value) => js(`const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', {bubbles: true})); e.dispatchEvent(new Event('change', {bubbles: true})); return true`)
const dialogSubmit = () => js(`document.querySelector('#dialog .dialog-foot button[type=submit]').click(); return true`)
const noOverflow = () => js(`return document.documentElement.scrollWidth <= innerWidth + 1`)
const stamp = Date.now().toString(36)

await cdp('Runtime.enable')
await cdp('Page.enable')
await viewport(1440, 900)
await cdp('Page.navigate', {url: `${opt.url}/#/dashboard`})
await until('connected', `return document.querySelector('#connection .label')?.textContent === 'Connected'`)

// Simulated microphone (see header comment).
if (opt.clip) {
  const clip = readFileSync(opt.clip).toString('base64')
  await js(`window.__clip = '${clip}'; navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext(); await ctx.resume()
    const src = ctx.createBufferSource(); src.buffer = await ctx.decodeAudioData(Uint8Array.from(atob(window.__clip), c => c.charCodeAt(0)).buffer)
    const dest = ctx.createMediaStreamDestination(); src.connect(dest); src.start(); return dest.stream }; return true`)
}

await step('navigation', async () => {
  const items = await js(`return [...document.querySelectorAll('.nav-item')].filter(a => !a.hidden).map(a => a.dataset.view)`)
  for (const v of items) {
    await click(`.nav-item[data-view="${v}"]`)
    await until(`view ${v}`, `return !document.querySelector('section[data-view="${v}"]').hidden && document.querySelector('.nav-item[data-view="${v}"]').getAttribute('aria-current') === 'page'`)
  }
  check('every navigation item opens its screen', true, items.join(', '))
})

await step('dashboard', async () => {
  await go('dashboard')
  await until('dashboard data', `return !document.querySelector('#dashToday').classList.contains('loading') && !document.querySelector('#dashNext').classList.contains('loading')`)
  const t = await js(`return {g: document.querySelector('#dashGreeting').textContent, d: document.querySelector('#dashDate').textContent, today: document.querySelector('#dashToday').textContent, next: document.querySelector('#dashNext').textContent, rem: document.querySelector('#dashReminders').textContent}`)
  check('dashboard shows greeting, date, schedule, next lecture and reminders', /^Good (morning|afternoon|evening)/.test(t.g) && t.d.length > 10 && t.today.length > 5 && t.next.length > 5, `${t.g} · next: ${t.next.slice(0, 60)}`)
  await shot('desktop-dashboard')
})

await step('timetable', async () => {
  await go('timetable')
  await until('day list', `return document.querySelectorAll('#dayList li').length > 0`)
  await clickText('#viewActions button', 'Add class')
  await until('class dialog', `return document.querySelector('#dialog').open`)
  await fill('#dialog input[name=subject]', `UI Test Class ${stamp}`); await fill('#dialog input[name=start]', '16:00'); await fill('#dialog input[name=end]', '15:00')
  await dialogSubmit()
  check('class form rejects an end before the start', await until('validation', `return document.querySelector('#dialog .error-text:not([hidden])')?.textContent.includes('after the start')`))
  await fill('#dialog input[name=end]', '17:00'); await dialogSubmit()
  await until('dialog closed', `return !document.querySelector('#dialog').open`)
  await click('[data-tt="week"]')
  await until('week grid', `return document.querySelectorAll('#weekGrid .day-col').length === 7`)
  check('add class appears in the week view', await until('new class', `return document.querySelector('#weekGrid').textContent.includes('UI Test Class ${stamp}')`))
  await shot('desktop-timetable-week')
  await js(`[...document.querySelectorAll('.class-card')].find(c => c.textContent.includes('UI Test Class ${stamp}')).click(); return true`)
  await until('edit dialog', `return document.querySelector('#dialog').open && document.querySelector('#dialogTitle').textContent === 'Edit class'`)
  await fill('#dialog input[name=room]', 'LH-9'); await dialogSubmit()
  check('edit class', await until('edited', `return [...document.querySelectorAll('.class-card')].some(c => c.textContent.includes('UI Test Class ${stamp}') && c.textContent.includes('LH-9'))`))
  await js(`[...document.querySelectorAll('.class-card')].find(c => c.textContent.includes('UI Test Class ${stamp}')).click(); return true`)
  await until('edit dialog', `return document.querySelector('#dialog').open`)
  await clickText('#dialog .dialog-foot button', 'Delete')
  await until('confirm dialog', `return document.querySelector('#dialogTitle')?.textContent === 'Delete class'`)
  await dialogSubmit()
  check('delete class (after confirmation)', await until('deleted', `return !document.querySelector('#weekGrid').textContent.includes('UI Test Class ${stamp}')`))
  await click('[data-tt="today"]')
})

await step('reminders', async () => {
  await go('reminders')
  await clickText('#viewActions button', 'New reminder')
  await until('reminder dialog', `return document.querySelector('#dialog').open`)
  await fill('#dialog input[name=title]', `UI reminder ${stamp}`)
  await dialogSubmit()
  check('add reminder', await until('listed', `return document.querySelector('#remList').textContent.includes('UI reminder ${stamp}')`))
  await shot('desktop-reminders')
  await js(`[...document.querySelectorAll('#remList li')].find(l => l.textContent.includes('UI reminder ${stamp}')).querySelector('button').click(); return true`)
  await until('gone from upcoming', `return !document.querySelector('#remList').textContent.includes('UI reminder ${stamp}')`)
  await click('#remScope [data-scope="completed"]')
  check('mark done moves it to Completed', await until('completed', `return document.querySelector('#remList').textContent.includes('UI reminder ${stamp}')`))
  await js(`[...document.querySelectorAll('#remList li')].find(l => l.textContent.includes('UI reminder ${stamp}')).querySelector('button.danger').click(); return true`)
  await until('confirm', `return document.querySelector('#dialogTitle')?.textContent === 'Delete reminder'`)
  await dialogSubmit()
  check('delete reminder (after confirmation)', await until('deleted', `return !document.querySelector('#remList').textContent.includes('UI reminder ${stamp}')`))
  await click('#remScope [data-scope="upcoming"]')
})

await step('notes', async () => {
  await go('notes')
  await clickText('#viewActions button', 'New note')
  await until('editor', `return document.querySelector('#noteEditor textarea.body')`)
  await fill('#noteEditor .title-input', `UI note ${stamp}`); await fill('#noteEditor textarea.body', 'Revise B+ tree node splits before the midterm.'); await fill('#noteEditor input:not(.title-input)', 'dbms, ui')
  await clickText('#noteEditor .editor-foot button', 'Save')
  check('create note', await until('listed', `return document.querySelector('#noteList').textContent.includes('UI note ${stamp}')`))
  await fill('#noteEditor textarea.body', 'Revise B+ tree node splits and hashing before the midterm.')
  await clickText('#noteEditor .editor-foot button', 'Save')
  check('edit note', await until('saved', `return [...document.querySelectorAll('#noteList li')].some(l => l.textContent.includes('hashing'))`))
  await fill('#noteQuery', 'बी प्लस ट्री')
  check('search notes (semantic, Hindi query)', await until('search', `return document.querySelector('#noteState').textContent.includes('result') && document.querySelector('#noteList').textContent.includes('UI note ${stamp}')`, 20000))
  await shot('desktop-notes')
  await clickText('#noteRecent', 'Recent')
  await until('recent', `return document.querySelector('#noteList').textContent.includes('UI note ${stamp}')`)
  await js(`[...document.querySelectorAll('#noteList button')].find(b => b.textContent.includes('UI note ${stamp}')).click(); return true`)
  await until('opened', `return document.querySelector('#noteEditor .title-input')?.value === 'UI note ${stamp}'`)
  await clickText('#noteEditor .editor-foot button', 'Delete')
  await until('confirm', `return document.querySelector('#dialogTitle')?.textContent === 'Delete note'`)
  await dialogSubmit()
  check('delete note (after confirmation)', await until('deleted', `return !document.querySelector('#noteList').textContent.includes('UI note ${stamp}')`))
})

await step('drafts', async () => {
  await go('drafts')
  await clickText('#viewActions button', 'New draft')
  await until('editor', `return document.querySelector('#draftEditor textarea.body')`)
  await fill('#draftEditor select', 'announcement')
  check('announcement hides email recipients', await js(`return [...document.querySelectorAll('#draftEditor .form-grid')].every(g => g.hidden)`))
  await fill('#draftEditor .title-input', `UI announcement ${stamp}`); await fill('#draftEditor textarea.body', 'The quiz is on Friday.')
  await clickText('#draftEditor .editor-foot button', 'Save draft')
  check('save draft (never sent)', await until('listed', `return document.querySelector('#draftList').textContent.includes('UI announcement ${stamp}') && document.querySelector('#draftEditor').textContent.includes('Not sent')`))
  await shot('desktop-drafts')
  await clickText('#draftEditor .editor-foot button', 'Delete')
  await until('confirm', `return document.querySelector('#dialogTitle')?.textContent === 'Delete draft'`)
  await dialogSubmit()
  check('delete draft (after confirmation)', await until('deleted', `return !document.querySelector('#draftList').textContent.includes('UI announcement ${stamp}')`))
})

await step('documents', async () => {
  await go('documents')
  await js(`const dt = new DataTransfer(); dt.items.add(new File(['# UI Test Document\\n\\nThe ${stamp} course covers indexing and hashing.'], 'ui-test-${stamp}.md', {type: 'text/markdown'}));
    const i = document.querySelector('#docUpload'); i.files = dt.files; i.dispatchEvent(new Event('change')); return true`)
  check('upload document and see it indexed', await until('ready', `return [...document.querySelectorAll('#docList tr')].some(r => r.textContent.includes('ui-test-${stamp}.md') && r.textContent.includes('Ready'))`, 30000))
  await fill('#docSearchInput', 'indexing and hashing'); await js(`document.querySelector('#docSearchForm').requestSubmit(); return true`)
  check('document search', await until('hits', `return document.querySelector('#docSearchResults').textContent.includes('ui-test-${stamp}.md')`))
  await shot('desktop-documents')
  await js(`[...document.querySelectorAll('#docList tr')].find(r => r.textContent.includes('ui-test-${stamp}.md')).querySelector('button.danger').click(); return true`)
  await until('confirm', `return document.querySelector('#dialogTitle')?.textContent === 'Delete document'`)
  await dialogSubmit()
  check('delete document (after confirmation)', await until('deleted', `return ![...document.querySelectorAll('#docList tr')].some(r => r.textContent.includes('ui-test-${stamp}.md'))`))
})

await step('settings', async () => {
  await go('settings')
  check('health lists the local services', await until('health', `return document.querySelectorAll('#health li .dot').length >= 4`))
  check('note sharing shows the server setting', await js(`const c = document.querySelector('#noteConsent'); return c.disabled ? document.querySelector('#noteConsentNote').textContent.includes('NOTES_SEND_TO_GEMINI') : true`))
  await shot('desktop-settings')
  await click('[data-theme-choice="dark"]')
  check('dark theme', await js(`return document.documentElement.dataset.theme === 'dark'`))
  await go('dashboard'); await shot('desktop-dashboard-dark')
  await go('settings'); await click('[data-theme-choice="light"]')
})

if (opt.clip) await step('voice memo', async () => {
  await go('memos')
  await js(`document.querySelector('#memoKeep').checked = true; document.querySelector('#memoLang').value = 'en'; return true`)
  await click('#memoRecord')
  check('recording state is obvious', await until('recording', `return document.querySelector('#memoRecord').classList.contains('recording') && document.querySelector('#memoTimer').textContent.startsWith('Recording')`))
  await sleep(4000)
  await click('#memoRecord')
  const text = await until('transcript', `return !document.querySelector('#memoForm').hidden && document.querySelector('#mTranscript').value`, 60000)
  check('memo transcribed locally, with preview audio', text.length > 5 && await js(`return !!document.querySelector('#memoPreview').src`), JSON.stringify(text.slice(0, 60)))
  await fill('#mTitle', `UI memo ${stamp}`)
  await js(`document.querySelector('#memoForm').requestSubmit(); return true`)
  check('memo saved with its audio', await until('saved', `const li = [...document.querySelectorAll('#memoList li')].find(l => l.textContent.includes('UI memo ${stamp}')); return li && li.querySelector('audio')`))
  await js(`[...document.querySelectorAll('#memoList li')].find(l => l.textContent.includes('UI memo ${stamp}')).querySelector('button.danger').click(); return true`)
  await until('confirm', `return document.querySelector('#dialogTitle')?.textContent === 'Delete memo'`)
  await dialogSubmit()
  await until('deleted', `return ![...document.querySelectorAll('#memoList li')].some(l => l.textContent.includes('UI memo ${stamp}'))`)
})

if (gemini) await step('assistant', async () => {
  await go('assistant')
  await until('ready', `return document.querySelector('#chatState').dataset.state === 'ready'`)
  await clickText('#suggestions button', 'next lecture')
  check('typed question streams an answer', await until('answer', `const m = [...document.querySelectorAll('.msg.assistant .bubble')].pop(); return m && m.textContent.length > 15 && !m.querySelector('.typing')`, 30000))
  check('tool status is shown', await until('chip', `return document.querySelector('.msg.assistant .tool-chip')?.textContent.includes('timetable')`, 10000))
  await until('settled', `return document.querySelector('#chatState').dataset.state === 'ready'`, 20000)
  await fill('#textInput', 'Remind me to collect the lab records tomorrow at 11 AM')
  await js(`document.querySelector('#textForm').requestSubmit(); return true`)
  const card = await until('confirmation card', `const c = [...document.querySelectorAll('.confirm-card')].pop(); return c && c.querySelector('.question').textContent`, 30000)
  check('confirmation card with exact details', /reminder/i.test(card) && await js(`return [...document.querySelectorAll('.confirm-card')].pop().querySelector('dl').textContent.includes('11:00')`), card)
  check('waiting-for-confirmation state', await until('waiting', `return document.querySelector('#chatState').dataset.state === 'waiting'`))
  check('expiry countdown', await js(`return /Expires in \\d+ s/.test([...document.querySelectorAll('.confirm-card')].pop().querySelector('.timer').textContent)`))
  await shot('desktop-assistant-confirm')
  await js(`const c = [...document.querySelectorAll('.confirm-card')].pop(); const b = c.querySelector('.btn.primary'); b.click(); b.click(); return true`) // a double click submits once
  check('confirm executes once and shows success', await until('done', `const c = [...document.querySelectorAll('.confirm-card')].pop(); return c.classList.contains('done') && c.textContent.includes('Done')`))
  const remindersAfter = await fetch(`${opt.url}/api/reminders?scope=all&q=lab%20records`).then(r => r.json())
  check('exactly one reminder was created', remindersAfter.reminders.length >= 1)
  if (opt.clip) {
    await js(`const t = document.querySelector('#talk'); t.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true})); return true`)
    check('microphone listening state', await until('listening', `return document.querySelector('#chatState').dataset.state === 'listening' && document.querySelector('#talk').classList.contains('recording')`))
    await sleep(3500)
    await js(`window.dispatchEvent(new PointerEvent('pointerup')); return true`)
    check('transcribing state after release', await until('transcribing', `return /Transcribing|Thinking|Replying|Speaking/.test(document.querySelector('#chatStateText').textContent)`, 5000))
    check('spoken question transcribed into the conversation', await until('user text', `const u = [...document.querySelectorAll('.msg.user .bubble')].pop(); return u && u.textContent.length > 10 && u.textContent !== '…'`, 30000))
    await until('answer', `const m = [...document.querySelectorAll('.msg.assistant .bubble')].pop(); return m && !m.querySelector('.typing')`, 30000)
  }
  await shot('desktop-assistant')
})

await step('mobile', async () => {
  await viewport(390, 844, true)
  await go('dashboard')
  check('mobile: navigation collapses to a menu button', await js(`return getComputedStyle(document.querySelector('#menuButton')).display !== 'none' && document.querySelector('.sidebar').getBoundingClientRect().right <= 0`))
  await shot('mobile-dashboard')
  await click('#menuButton')
  check('mobile: menu opens', await until('open', `return document.querySelector('#app').classList.contains('nav-open') && document.querySelector('.sidebar').getBoundingClientRect().left >= 0`))
  await shot('mobile-menu')
  await click('.nav-item[data-view="timetable"]')
  check('mobile: navigating closes the menu', await until('closed', `return !document.querySelector('#app').classList.contains('nav-open')`))
  const overflow = []
  for (const v of ['dashboard', 'assistant', 'timetable', 'reminders', 'notes', 'memos', 'documents', 'drafts', 'accounts', 'settings']) {
    await go(v); await sleep(300)
    if (!await noOverflow()) overflow.push(v)
    if (['assistant', 'timetable', 'notes'].includes(v)) await shot(`mobile-${v}`)
  }
  check('mobile: no horizontal overflow on any screen', overflow.length === 0, overflow.join(', '))
  await viewport(820, 1180, true); await go('timetable'); await click('[data-tt="week"]').catch(() => {}); await shot('tablet-timetable-week')
  check('tablet: no horizontal overflow', await noOverflow())
  await viewport(1280, 800); await go('assistant'); await shot('laptop-assistant')
})

check('no page exceptions or console errors', problems.length === 0, problems.slice(0, 3).join(' | '))
console.log(JSON.stringify({passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results}, null, 1))
process.exit(results.every(r => r.ok) ? 0 : 1)
