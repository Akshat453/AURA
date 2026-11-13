// AI Assistant: WebSocket session, push-to-talk capture, ordered playback,
// the conversation thread, citations, tool status and confirmation cards.
// Only the message being streamed is re-rendered; earlier messages are left
// alone, and nothing here delays microphone capture or audio playback.
import {loadWorklet, startCapture} from './capture.js'
import {$, el, icon, button, emit, on, recall, remember, registerView, state, toast} from './ui.js'
import {seconds, splitCitations, toolLabels, toolFailedLabel, dueLabel, ymd, friendlyError} from './format.js'
import * as knowledge from './knowledge.js'
import {mailHandoff, draftFromAction} from './mailhandoff.js'

const ui = {
  thread: $('thread'), inner: $('threadInner'), welcome: $('welcome'), state: $('chatState'), stateText: $('chatStateText'),
  talk: $('talk'), stop: $('stop'), send: $('send'), form: $('textForm'), input: $('textInput'), clear: $('clear'),
  lang: $('language'), mode: $('mode'), levelTrack: $('levelTrack'), levelBar: $('levelBar'), microphone: $('microphone'),
  debugPanel: $('debugPanel'), debugToggle: $('debugToggle'), debugStats: $('debugStats'), debugInputAudio: $('debugInputAudio'),
  debugWhisperAudio: $('debugWhisperAudio'), debugDownload: $('debugDownload'), expectedText: $('expectedText'),
  rawTranscript: $('rawTranscript'), compareTranscript: $('compareTranscript'), comparison: $('comparison'),
}

let ws, stream, source, capture, ctx, gain
let turn = 0, playing = [], audioQueue = Promise.resolve()
let speaking = false, recording = false, starting = false, stopping = false, pressHeld = false, busy = false
let turnStoppedAt = 0, firstAudible = null, lastMetrics = null, cancelledTurn = 0
let debugURLs = [], debugInfo = null
let current = null // the assistant message being built for `turn`
const cards = new Map() // action id -> confirmation card controller

// ---- State line ----
const STATES = {idle: 'idle', ready: 'ready', listening: 'listening', busy: 'busy', speaking: 'speaking', waiting: 'waiting', error: 'error'}
function setState(kind, text) {
  ui.state.dataset.state = STATES[kind] || 'idle'
  ui.stateText.textContent = text
}
function settle() {
  const open = [...cards.values()].some(c => c.open)
  if (ws?.readyState !== WebSocket.OPEN) return setState('error', 'Disconnected — reconnecting…')
  setState(open ? 'waiting' : 'ready', open ? 'Waiting for your confirmation — say yes or no, or use the buttons' : 'Ready — hold the microphone or type a message')
}

export function sendEvent(type, extra = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type, version: 1, ...extra}))
}

// ---- Connection ----
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => { emit('connection', true); settle() }
  ws.onclose = () => { emit('connection', false); ui.talk.disabled = true; setState('error', 'Disconnected — reconnecting…'); setTimeout(connect, 1500) }
  ws.onerror = () => {}
  ws.onmessage = m => typeof m.data === 'string' ? control(JSON.parse(m.data)) : receiveAudio(m.data)
}

function control(message) {
  // Turn-scoped events of an older turn are ignored (the server cancelled it).
  if (message.turn_id && message.turn_id !== turn) return
  switch (message.type) {
    case 'hello':
      ui.debugPanel.hidden = !message.debug
      state.capabilities = message.capabilities || {}
      knowledge.setCapabilities(message.capabilities)
      emit('capabilities', message.capabilities)
      break
    case 'ready':
      ui.talk.disabled = false
      if (!recording && !busy) settle()
      break
    case 'debug_state': ui.debugToggle.checked = message.debug; break
    case 'audio_debug': debugInfo = message.audio; renderDebugStats(); break
    case 'audio_debug_transcript': ui.rawTranscript.textContent = message.text; compareTranscript(); break
    case 'stt_result':
      userText(message.text)
      setState('busy', 'Thinking…')
      break
    case 'route': showRoute(message.plan || {}); break
    case 'sources': showSources(message.sources || []); setState('busy', 'Reading sources…'); break
    case 'notes_found': showLocalNotes(message.notes || []); break
    case 'tool_error': chip(toolFailedLabel(message.code), true); break
    case 'llm_delta': appendAnswer(message.text); if (!speaking) setState('busy', 'Replying…'); break
    case 'tts_start':
      speaking = true; showStop(true)
      setState('speaking', speakEnabled() ? 'Speaking… press stop to interrupt' : 'Replying (spoken replies are off)')
      break
    case 'turn_complete':
      busy = false
      if (message.message === 'aborted') { finishPlayback(); break }
      audioQueue.then(finishPlayback).catch(e => setState('error', `Playback error: ${e.message}`))
      break
    case 'metrics': showMetrics(message.metrics || {}); break
    case 'action_pending': pendingCard(message.action); emit('changed', 'action'); break
    case 'action_result': actionResult(message); break
    case 'reminder_due': emit('reminder', message.reminder); break
    case 'error':
      busy = false
      if (recording && message.code === 'bad_audio') abortRecording()
      speaking = false; showStop(false)
      answerError(friendlyError(message))
      setState('error', friendlyError(message))
      setTimeout(() => { if (!busy && !recording) settle() }, 4000)
      break
  }
}

// ---- Conversation ----
function scrollDown() { ui.thread.scrollTop = ui.thread.scrollHeight }

function newExchange(text, voice) {
  ui.welcome.hidden = true
  const user = el('div', {class: 'msg user'}, el('div', {class: 'bubble', text: text || '…'}))
  if (voice) user.querySelector('.bubble').append(el('span', {class: 'sr-only', text: ' (spoken)'}))
  const bubble = el('div', {class: 'bubble'}, el('span', {class: 'typing', 'aria-label': 'Working'}, el('span'), el('span'), el('span')))
  const meta = el('div', {class: 'msg-meta'})
  const sources = el('div', {class: 'sources', hidden: true})
  const local = el('div', {class: 'sources', hidden: true})
  const msg = el('div', {class: 'msg assistant'}, el('div', {class: 'label'}, el('span', {class: 'avatar'}, icon('spark')), 'Assistant'), bubble, meta, sources, local)
  ui.inner.append(user, msg)
  current = {turn, user, msg, bubble, meta, sources, local, answer: '', list: [], chips: new Set(), voice}
  scrollDown()
}

function userText(text) {
  if (!current) newExchange(text)
  current.user.querySelector('.bubble').textContent = text
}

function chip(text, warn = false) {
  if (!current || current.chips.has(text)) return
  current.chips.add(text)
  current.meta.append(el('span', {class: `tool-chip${warn ? ' warn' : ''}`}, icon(warn ? 'alert' : 'check', 'icon'), text))
  current.meta.querySelectorAll('svg.icon').forEach(s => { s.style.width = '12px'; s.style.height = '12px' })
}

function showRoute(plan) {
  if (plan.pre_search_docs) { chip('Searched your documents'); setState('busy', 'Searching your documents…') }
  if (plan.pre_search_web) { chip('Searched the web'); setState('busy', 'Searching the web…') }
  if (plan.skip_gemini && plan.local_reply === 'docs_private') { chip('Passages kept on this Mac'); if (current) current.openSources = true }
}

function appendAnswer(delta) {
  if (!current) newExchange('')
  current.answer += delta
  renderAnswer()
}

function renderAnswer() {
  const known = new Set(current.list.map(s => s.id))
  const nodes = splitCitations(current.answer).map(part => {
    if (part.text !== undefined) return document.createTextNode(part.text)
    return el('span', {class: 'cite-group'}, ...part.cite.map(id => el('a', {
      class: known.has(id) ? 'cite' : 'cite invalid', href: `#src-${current.turn}-${id}`, text: id,
      title: known.has(id) ? 'Show source' : 'No retrieved source has this id',
      onclick: e => { e.preventDefault(); const t = document.getElementById(`src-${current.turn}-${id}`); t?.closest('details')?.setAttribute('open', ''); t?.scrollIntoView({behavior: 'smooth', block: 'nearest'}) },
    })))
  })
  current.bubble.replaceChildren(...nodes)
  if (ui.thread.scrollHeight - ui.thread.scrollTop - ui.thread.clientHeight < 160) scrollDown()
}

function answerError(text) {
  if (!current) return
  if (!current.answer) current.bubble.replaceChildren(el('span', {class: 'error', text}))
  current.bubble.classList.toggle('error', !current.answer)
}

function showSources(list) {
  if (!current) return
  current.list = list
  const wrap = el('details', {open: !!current.openSources}, el('summary', {class: 'small muted', text: `${list.length} source${list.length === 1 ? '' : 's'}`}),
    el('div', {class: 'sources'}, ...list.map(s => {
      const head = el('div', {class: 'source-head'}, el('span', {class: 'cite', text: s.id}))
      if (s.kind === 'web') {
        let host = ''
        try { host = new URL(s.url).hostname } catch {}
        head.append(el('a', {class: 'title', href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.title || host}), el('small', {text: `${host}${s.published ? ` · ${s.published}` : ''}`}))
      } else {
        head.append(el('span', {class: 'title', text: s.document}), el('small', {text: [s.page ? `page ${s.page}` : '', s.heading].filter(Boolean).join(' · ')}))
      }
      return el('div', {class: 'source', id: `src-${current.turn}-${s.id}`}, head, el('details', {}, el('summary', {text: 'Passage'}), el('p', {text: s.snippet})))
    })))
  current.sources.replaceChildren(wrap)
  current.sources.hidden = list.length === 0
  renderAnswer()
}

function showLocalNotes(list) {
  if (!current || !list.length) return
  current.local.replaceChildren(el('div', {class: 'small muted'}, icon('lock'), ' Matching notes — shown here only, not sent to Gemini'),
    ...list.map(n => el('div', {class: 'source'}, el('div', {class: 'source-head'}, el('span', {class: 'title', text: n.title}), el('small', {text: n.kind})), el('p', {class: 'small', text: n.snippet, style: 'margin-top:4px;color:var(--text-2)'}))))
  current.local.querySelector('svg.icon').style.cssText = 'width:13px;height:13px;vertical-align:-2px'
  current.local.hidden = false
}

function showMetrics(m) {
  lastMetrics = m
  if (!current) return
  toolLabels(m.tool_calls).forEach(t => chip(t))
  if (m.invalid_citations?.length) chip(`Unverified citation ${m.invalid_citations.join(', ')}`, true)
  current.metrics = m
  renderDiag()
}

function renderDiag() {
  if (!current?.metrics || recall('pa-diag') !== 'yes') return
  const m = {...current.metrics, ...(current.firstAudible ? {first_audible_ms: current.firstAudible} : {})}
  const labels = {stt_ms: 'Speech to text', route_ms: 'Tool routing', retrieval_ms: 'Document search', web_search_ms: 'Web search', tool_ms: 'Tools', llm_first_text_ms: 'First text', llm_total_ms: 'Gemini', first_tts_ms: 'First speech synthesis', first_audio_delivery_ms: 'Audio delivered', first_audible_ms: 'First audible', action_ms: 'Saved', total_ms: 'Total'}
  const items = Object.entries(labels).filter(([k]) => m[k]).map(([k, l]) => el('span', {text: `${l} ${Math.round(m[k])} ms`}))
  if (m.tool_route) items.push(el('span', {text: `Tools offered: ${m.tool_route}`}))
  current.msg.querySelector('details.diag')?.remove()
  current.msg.append(el('details', {class: 'diag'}, el('summary', {}, icon('clock'), ` ${seconds(m.first_audio_delivery_ms || m.total_ms || 0)} to first audio`), el('div', {class: 'metrics'}, ...items)))
  current.msg.querySelector('details.diag svg').style.cssText = 'width:12px;height:12px'
}

// ---- Confirmation cards ----
const labels = {title: 'Title', body: 'Text', tags: 'Tags', description: 'Details', transcript: 'Transcript', subject: 'Subject', to: 'To', cc: 'Cc', bcc: 'Bcc',
  audience: 'Audience', due: 'When', recurrence: 'Repeats', changes: 'Changes', time: 'Time', current_time: 'Currently', kind: 'Type', previous_title: 'Note'}
const kindTitle = {create_reminder: 'New reminder', update_reminder: 'Change reminder', delete_reminder: 'Delete reminder', save_note: 'Save note', update_note: 'Update note',
  delete_note: 'Delete', save_voice_memo: 'Save voice memo', save_email_draft: 'Save email draft', save_announcement_draft: 'Save announcement draft'}

function pendingCard(a) {
  if (!a?.id || cards.has(a.id)) return
  const editable = new Set(a.editable || [])
  const order = ['title', 'subject', 'to', 'cc', 'bcc', 'audience', 'due', 'time', 'current_time', 'recurrence', 'changes', 'previous_title', 'kind', 'body', 'transcript', 'tags', 'description']
  const empty = v => v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length)
  const details = Object.entries(a.details || {})
    .filter(([k, v]) => labels[k] && k !== 'timezone' && !(k === 'recurrence' && v === 'none') && !(empty(v) && (!editable.has(k) || k === 'description' || k === 'cc' || k === 'bcc')))
    .sort(([x], [y]) => order.indexOf(x) - order.indexOf(y))
  const today = ymd(new Date(), state.prof.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)
  const show = (k, value) => (k === 'due' || k === 'time' || k === 'current_time') && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? dueLabel(value, today) : k === 'recurrence' ? ({daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week'}[value] || value) : value
  const dl = el('dl')
  const fields = el('div', {class: 'fields'})
  for (const [k, v] of details) {
    const value = Array.isArray(v) ? v.join(', ') : String(v ?? '')
    if (editable.has(k)) {
      const long = k === 'body' || k === 'transcript'
      const input = el(long ? 'textarea' : 'input', {rows: long ? 7 : undefined, 'aria-label': labels[k]})
      input.value = value // a textarea has no value attribute; set the property
      input.dataset.field = k; input.dataset.original = value
      fields.append(el('label', {class: 'field'}, labels[k], input))
    } else dl.append(el('dt', {text: labels[k]}), el('dd', {text: show(k, value)}))
  }
  const confirm = button('Confirm', () => decide('approve'), {cls: 'btn primary', iconName: 'check'})
  const cancel = button('Cancel', () => decide('reject'), {cls: 'btn', iconName: 'x'})
  const timer = el('span', {class: 'timer'})
  const result = el('p', {class: 'result', hidden: true, role: 'status'})
  const copy = 'body' in (a.details || {}) || 'transcript' in (a.details || {})
    ? button('Copy text', () => { const t = fields.querySelector('[data-field="body"],[data-field="transcript"]'); navigator.clipboard?.writeText(t?.value || '').then(() => toast('Copied')) }, {cls: 'btn ghost', iconName: 'copy'}) : null
  const card = el('div', {class: 'confirm-card', role: 'group', 'aria-label': 'Confirm this change'},
    el('div', {class: 'head'}, icon('lock'), kindTitle[a.kind] || 'Confirm change', el('span', {class: 'badge warning', text: 'Needs your confirmation', style: 'margin-left:auto;text-transform:none;letter-spacing:0'})),
    el('p', {class: 'question', text: a.summary.replace(/\s*(Say yes or no, or use the buttons\.|Please say yes or no\.)\s*$/, '')}),
    dl.childElementCount ? dl : null, fields.childElementCount ? fields : null,
    el('div', {class: 'foot'}, confirm, cancel, copy, timer), result)
  ui.inner.append(card)
  scrollDown()
  const c = {open: true, action: a, card, confirm, cancel, timer, result, fields, interval: null}
  cards.set(a.id, c)
  const expires = new Date(a.expires_at).getTime()
  const tick = () => {
    const left = Math.round((expires - Date.now()) / 1000)
    if (left > 0) { timer.textContent = `Expires in ${left} s`; return }
    close(c, 'closed', 'This request expired, so nothing was changed. Ask again if you still want it.')
  }
  tick(); c.interval = setInterval(tick, 1000)
  function decide(decision) {
    if (!c.open || c.sending) return // no double submission
    c.sending = true; confirm.disabled = cancel.disabled = true
    const edits = {}
    if (decision === 'approve') fields.querySelectorAll('[data-field]').forEach(i => { if (i.value !== i.dataset.original) edits[i.dataset.field] = i.value })
    result.hidden = false; result.textContent = decision === 'approve' ? 'Saving…' : 'Cancelling…'
    sendEvent('action_confirm', {action_id: a.id, decision, edits})
  }
  settle()
}

function close(c, cls, text) {
  c.open = false; clearInterval(c.interval)
  c.confirm.disabled = c.cancel.disabled = true
  c.fields.querySelectorAll('input,textarea').forEach(i => { i.readOnly = true })
  c.timer.textContent = ''
  c.card.classList.add(cls)
  const head = c.card.querySelector('.head .badge')
  head.className = `badge ${cls === 'done' ? 'success' : cls === 'failed' ? 'danger' : ''}`
  head.textContent = cls === 'done' ? 'Done' : cls === 'failed' ? 'Not done' : 'Closed'
  c.result.hidden = false; c.result.textContent = text
  if (!busy && !recording) settle()
}

// A saved draft can be opened in the professor's own mail client; the card's
// inputs (now read-only) hold the final, possibly edited, values.
const draftKinds = new Set(['save_email_draft', 'save_announcement_draft'])
function addHandoff(c) {
  if (c.handoff || !draftKinds.has(c.action.kind)) return
  c.handoff = mailHandoff(() => draftFromAction(c.action.details, c.fields))
  c.card.append(c.handoff)
  scrollDown()
}

function actionResult(m) {
  const a = m.action || {}
  const c = cards.get(a.id || m.action_id)
  const text = m.message || a.message || ''
  if (!c) { if (a.status === 'done') { toast(text || 'Done'); emit('changed', a.kind) } return }
  if (!c.open && a.status !== 'done') return
  switch (a.status) {
    case 'done': close(c, 'done', text || 'Done.'); addHandoff(c); emit('changed', a.kind); break
    case 'rejected': close(c, 'closed', text || 'Cancelled — nothing was changed.'); break
    case 'superseded': close(c, 'closed', 'Not confirmed: you asked something else, so nothing was changed.'); break
    case 'expired': close(c, 'closed', 'This request expired, so nothing was changed.'); break
    default:
      if (m.code === 'already_decided') break
      close(c, 'failed', text || 'It could not be done. Nothing was changed.')
  }
}

// ---- Playback ----
export function speakEnabled() { return recall('pa-speak', 'yes') !== 'no' }
export function setVolume(v) { remember('pa-volume', String(v)); if (gain) gain.gain.value = v }
function audioContext() {
  if (!ctx) {
    ctx = new AudioContext()
    gain = ctx.createGain(); gain.gain.value = Number(recall('pa-volume', '1')); gain.connect(ctx.destination)
  }
  return ctx
}

async function receiveAudio(buffer) {
  const view = new DataView(buffer), kind = view.getUint8(5), frameTurn = view.getUint32(8)
  if (frameTurn !== turn) return
  const wav = buffer.slice(16)
  if (kind === 3 || kind === 4) {
    const url = URL.createObjectURL(new Blob([wav], {type: 'audio/wav'}))
    debugURLs.push(url)
    if (kind === 3) ui.debugInputAudio.src = url
    else { ui.debugWhisperAudio.src = url; ui.debugDownload.href = url; ui.debugDownload.hidden = false }
    return
  }
  if (kind !== 2 || !speakEnabled()) return
  const msg = current
  audioQueue = audioQueue.then(async () => {
    const c = audioContext()
    const decoded = await c.decodeAudioData(wav)
    if (cancelledTurn === frameTurn) return
    await new Promise(resolve => {
      const player = c.createBufferSource()
      playing.push(player); player.buffer = decoded; player.connect(gain)
      player.onended = () => { playing = playing.filter(p => p !== player); resolve() }
      player.start()
      if (firstAudible === null && turnStoppedAt) {
        firstAudible = Math.round(performance.now() - turnStoppedAt)
        sendEvent('playback_started', {turn_id: turn, metrics: {first_audible_ms: firstAudible}})
        if (msg) { msg.firstAudible = firstAudible; if (msg === current) renderDiag() }
      }
    })
  })
}

function showStop(on) { ui.stop.hidden = !on; ui.send.hidden = on }

function finishPlayback() {
  speaking = false; showStop(false); ui.talk.disabled = false
  if (!recording) settle()
}

function stopPlayback() {
  sendEvent('abort', {turn_id: turn}); cancelledTurn = turn; speaking = false; busy = false
  playing.forEach(p => { try { p.stop() } catch {} }); playing = []; audioQueue = Promise.resolve()
  showStop(false); ui.talk.disabled = false
}

// ---- Recording (hold to talk) ----
async function startRecording() {
  if (recording || starting || ws?.readyState !== WebSocket.OPEN) return
  if (speaking || busy) stopPlayback() // barge in
  starting = true; setState('busy', 'Starting the microphone…')
  try {
    const c = audioContext()
    await c.resume()
    const constraints = {channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false}
    if (ui.microphone.value) constraints.deviceId = {exact: ui.microphone.value}
    stream = await navigator.mediaDevices.getUserMedia({audio: constraints})
    emit('microphones')
    await loadWorklet(c)
    if (!pressHeld) { cleanupCapture(); setState('ready', 'Hold the button while you speak'); return }
    source = c.createMediaStreamSource(stream)
    turn++; cancelledTurn = 0; recording = true; stopping = false; busy = true; current = null
    resetDebugRecording()
    sendEvent('listen_start', {turn_id: turn, language: ui.lang.value, sample_rate: c.sampleRate, capture_sample_rate: c.sampleRate, ...knowledge.turnOptions()})
    capture = startCapture({ctx: c, source, ws, turn,
      onLevel: peak => { ui.levelBar.style.width = `${Math.min(100, Math.round(peak * 140))}%` },
      onCongested: () => { setState('error', 'Audio transport is congested; stopping safely'); requestStop() }})
    ui.talk.classList.add('recording'); ui.talk.setAttribute('aria-label', 'Recording — release to send'); ui.levelTrack.hidden = false
    setState('listening', 'Listening… release to send')
  } catch (error) {
    cleanupCapture(); busy = false
    const denied = error.name === 'NotAllowedError'
    setState('error', denied ? 'Microphone permission was denied. Allow it in the browser’s site settings, or type instead.' : `Microphone unavailable: ${error.message}`)
  } finally { starting = false }
}

async function requestStop() {
  if (!recording || stopping) return
  stopping = true
  await capture.stop() // resolves after the final audio block has been sent
  if (!recording) return
  recording = false; stopping = false
  cleanupCapture()
  turnStoppedAt = performance.now(); firstAudible = null; lastMetrics = null
  sendEvent('listen_stop', {turn_id: turn})
  newExchange('', true)
  ui.talk.classList.remove('recording'); ui.talk.setAttribute('aria-label', 'Hold to speak'); ui.levelTrack.hidden = true
  setState('busy', 'Transcribing on this Mac…')
}

function abortRecording() {
  recording = false; stopping = false; cleanupCapture()
  ui.talk.classList.remove('recording'); ui.levelTrack.hidden = true
}

function cleanupCapture() {
  capture?.abort()
  try { source?.disconnect() } catch {}
  stream?.getTracks().forEach(t => t.stop())
  stream = source = capture = null
}

// ---- Text input ----
export function sendText(text) {
  text = text.trim()
  if (!text || ws?.readyState !== WebSocket.OPEN) return false
  if (speaking || busy) stopPlayback()
  turn++; cancelledTurn = 0; busy = true; turnStoppedAt = performance.now(); firstAudible = null; lastMetrics = null
  current = null; newExchange(text)
  sendEvent('text_input', {turn_id: turn, text, language: ui.lang.value, ...knowledge.turnOptions()})
  setState('busy', 'Thinking…')
  return true
}

function autoGrow() { ui.input.style.height = 'auto'; ui.input.style.height = `${Math.min(160, ui.input.scrollHeight)}px` }

// ---- Audio debug (Settings → Diagnostics) ----
function resetDebugRecording() {
  debugURLs.forEach(URL.revokeObjectURL); debugURLs = []; debugInfo = null
  for (const a of [ui.debugInputAudio, ui.debugWhisperAudio]) { a.removeAttribute('src'); a.load() }
  ui.debugDownload.hidden = true; ui.rawTranscript.textContent = '—'; ui.comparison.textContent = ''
  if (ui.debugToggle.checked) ui.debugStats.textContent = 'Recording…'
}
function renderDebugStats() {
  if (!debugInfo) return
  const i = debugInfo.input, o = debugInfo.whisper
  ui.debugStats.textContent = [`Microphone: ${i.sample_rate} Hz, ${(i.duration_ms / 1000).toFixed(2)} s`, `Whisper: ${o.sample_rate} Hz, ${(o.duration_ms / 1000).toFixed(2)} s`,
    `Level: peak ${i.peak_dbfs.toFixed(1)} dBFS, RMS ${i.rms_dbfs.toFixed(1)} dBFS`, `Clipping: ${i.clipped_samples} samples (${i.clipped_percent.toFixed(3)}%)`,
    `Model: ${debugInfo.model}`, `Language sent to Whisper: ${debugInfo.language || ui.lang.value}`].join('\n')
}
const normalizeText = v => v.toLocaleLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, '').trim().replace(/\s+/g, ' ')
function distance(a, b) {
  const row = Array.from({length: b.length + 1}, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0]; row[0] = i
    for (let j = 1; j <= b.length; j++) { const old = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1)); diag = old }
  }
  return row[b.length]
}
function compareTranscript() {
  const e = normalizeText(ui.expectedText.value), a = normalizeText(ui.rawTranscript.textContent)
  if (!e || !a || a === '—') { ui.comparison.textContent = 'Enter the expected sentence after recording to compare.'; return }
  const wer = 100 * distance(e.split(' '), a.split(' ')) / Math.max(1, e.split(' ').length)
  const cer = 100 * distance([...e], [...a]) / Math.max(1, [...e].length)
  ui.comparison.textContent = `Word error rate ${wer.toFixed(1)}% · character error rate ${cer.toFixed(1)}%`
}

// ---- Wiring ----
export function init() {
  ui.talk.addEventListener('pointerdown', e => { e.preventDefault(); pressHeld = true; startRecording() })
  window.addEventListener('pointerup', () => { pressHeld = false; requestStop() })
  window.addEventListener('pointercancel', () => { pressHeld = false; requestStop() })
  ui.talk.addEventListener('keydown', e => { if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) { e.preventDefault(); pressHeld = true; startRecording() } })
  ui.talk.addEventListener('keyup', e => { if (e.code === 'Space' || e.code === 'Enter') { pressHeld = false; requestStop() } })
  ui.stop.onclick = () => { stopPlayback(); if (current && !current.answer) answerError('Stopped.'); settle() }
  ui.form.onsubmit = e => { e.preventDefault(); if (sendText(ui.input.value)) { ui.input.value = ''; autoGrow() } }
  ui.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ui.form.requestSubmit() } })
  ui.input.addEventListener('input', autoGrow)
  $('suggestions').addEventListener('click', e => { if (e.target.matches('button')) sendText(e.target.textContent) })
  ui.clear.onclick = () => {
    stopPlayback(); sendEvent('clear')
    cards.forEach(c => clearInterval(c.interval)); cards.clear(); current = null
    ui.inner.replaceChildren(ui.welcome); ui.welcome.hidden = false; settle()
  }
  for (const [elx, key] of [[ui.lang, 'pa-language'], [ui.mode, 'voice-mode']]) {
    const saved = recall(key)
    if (saved && [...elx.options].some(o => o.value === saved)) elx.value = saved
    elx.addEventListener('change', () => remember(key, elx.value))
  }
  ui.debugToggle.onchange = () => sendEvent('debug_enable', {debug: ui.debugToggle.checked})
  ui.compareTranscript.onclick = compareTranscript
  ui.expectedText.oninput = compareTranscript
  on('capabilities', c => { if (c?.default_mode && !recall('voice-mode')) ui.mode.value = c.default_mode })
  registerView('assistant', {title: 'AI Assistant', show: () => setTimeout(() => ui.input.focus({preventScroll: true}), 50)})
  connect()
}
