// Documents (Phase 4 RAG) and the privacy consents sent with each turn.
// The server enforces every permission; these controls only express the
// user's choice for this browser.
//
// "Let Gemini read my documents" is one choice shown in three places (the
// Documents card, the composer and Settings → Privacy), rendered from a single
// value. It is kept in sessionStorage, so every new tab starts OFF.
import {$, el, icon, api, json, button, confirmDialog, openDialog, emptyState, recall, remember, registerView, state, toast} from './ui.js'
import {formatBytes} from './format.js'

const ui = {
  consent: $('docConsent'), consentNote: $('consentNote'), noteConsent: $('noteConsent'), noteConsentNote: $('noteConsentNote'),
  upload: $('docUpload'), drop: $('dropzone'), docs: $('docList'), docState: $('docState'), docCount: $('docCount'), docEmpty: $('docEmpty'),
  searchForm: $('docSearchForm'), searchInput: $('docSearchInput'), searchResults: $('docSearchResults'), webState: $('webState'),
  shareCard: $('docShareCard'), shareStatus: $('docShareStatus'), deviceRow: $('deviceDocsRow'), deviceSwitch: $('deviceDocsSwitch'), deviceStatus: $('deviceDocsStatus'),
}
const SHARE_KEY = 'pa-doc-share', LEGACY_CONSENT_KEY = 'voice-doc-consent', NOTE_CONSENT_KEY = 'voice-note-consent'
let pollTimer = null

// ---- "Let Gemini read my documents" ----
const share = {on: false, allowed: false, asking: false}
const sessionGet = key => { try { return sessionStorage.getItem(key) } catch { return null } }
const sessionSet = (key, value) => { try { sessionStorage.setItem(key, value) } catch {} }
const shareSwitches = () => document.querySelectorAll('[data-doc-share]')

function shareText() {
  if (!share.allowed) return 'Off on this server (RAG_SEND_CONTEXT_TO_GEMINI=false): documents are only searched on this Mac and nothing from them is ever sent to Gemini.'
  return share.on
    ? 'ON — Gemini may read the few passages that match each question (never whole files), so you can ask about your documents by voice or typing. It switches off when this tab closes.'
    : 'OFF — private: documents are only searched on this Mac. Matching passages are listed for you but never sent to Gemini.'
}

function renderShare() {
  const on = share.on && share.allowed
  for (const sw of shareSwitches()) {
    sw.setAttribute('aria-checked', String(on))
    sw.disabled = !share.allowed
    sw.querySelector('.switch-state')?.replaceChildren(on ? 'On' : 'Off')
    sw.title = share.allowed ? shareText() : 'Disabled on this server (RAG_SEND_CONTEXT_TO_GEMINI=false)'
  }
  ui.consent.checked = on
  ui.consent.disabled = !share.allowed
  ui.consentNote.textContent = shareText()
  ui.shareStatus.textContent = shareText()
  ui.shareCard.classList.toggle('on', on)
}

// requestShare turns the choice on (after an explicit confirmation) or off.
async function requestShare(on) {
  if (!share.allowed || share.asking || on === share.on) { renderShare(); return }
  if (on) {
    share.asking = true
    renderShare() // a checkbox ticked before confirming shows the real state meanwhile
    const ok = await openDialog({title: 'Let Gemini read your documents?', submitLabel: 'Turn on', body: el('div', {class: 'stack'},
      el('p', {text: 'Gemini is a Google cloud service. While this is on, the few passages that match each question are sent to Gemini to write the answer, so you can ask about your documents by voice or typing.'}),
      el('ul', {class: 'small', style: 'margin:0;padding-left:18px'},
        el('li', {text: 'Only matching passages are sent — never whole files.'}),
        el('li', {text: 'Your files and their index stay on this Mac.'}),
        el('li', {text: 'It applies to this browser tab only and switches off when the tab closes.'})))})
    share.asking = false
    if (!ok) { renderShare(); return }
  }
  share.on = on
  sessionSet(SHARE_KEY, on ? 'yes' : 'no')
  renderShare()
  toast(on ? 'Gemini can now read matching document passages (this tab only)' : 'Documents are private again — searched on this Mac only')
}

// ---- Desk device (ESP32) switch: a server setting, reset to DEVICE_ALLOW_DOC_CONTEXT on restart ----
let device = {allowed: false, server_allowed: false, devices_enabled: false}
function renderDevice() {
  ui.deviceRow.hidden = !device.devices_enabled
  ui.deviceSwitch.setAttribute('aria-checked', String(device.allowed))
  ui.deviceSwitch.disabled = !device.server_allowed
  ui.deviceSwitch.querySelector('.switch-state').replaceChildren(device.allowed ? 'On' : 'Off')
  ui.deviceStatus.textContent = !device.server_allowed
    ? 'Off on this server (RAG_SEND_CONTEXT_TO_GEMINI=false).'
    : device.allowed
      ? 'ON — questions asked on the desk device may use matching passages. Resets to the .env setting when the assistant restarts.'
      : 'OFF — the desk device cannot ask Gemini about your documents.'
}
async function loadDevice() {
  try { device = await api('/api/device-docs'); renderDevice() } catch {}
}
async function requestDevice(on) {
  if (!device.server_allowed || on === device.allowed) return
  if (on && !await confirmDialog('Anyone who can speak to the desk device will then be able to ask about your documents, and the matching passages will be sent to Gemini to answer. This lasts until you turn it off or the assistant restarts.',
    {title: 'Allow the desk device to use documents?', confirmLabel: 'Turn on', danger: false})) return
  try {
    device = await api('/api/device-docs', json('POST', {allowed: on}))
    renderDevice()
    toast(on ? 'The desk device may now use your documents' : 'The desk device can no longer use your documents')
  } catch (e) { toast(e.message, {error: true}); loadDevice() }
}

export function turnOptions() {
  return {mode: $('mode').value, allow_doc_context: share.on && share.allowed, allow_note_context: ui.noteConsent.checked && !ui.noteConsent.disabled}
}

export function setCapabilities(c = {}) {
  share.allowed = !!c.send_context_allowed
  renderShare()
  device = {allowed: !!c.device_docs, server_allowed: !!c.send_context_allowed, devices_enabled: !!c.devices_enabled}
  renderDevice()
  const notesAllowed = !!c.notes_send_allowed
  ui.noteConsent.disabled = !notesAllowed
  ui.noteConsent.checked = notesAllowed && recall(NOTE_CONSENT_KEY) === 'yes'
  ui.noteConsentNote.textContent = notesAllowed
    ? 'Off: notes stay on this Mac; the assistant only learns how many notes match and lists them for you. On: the titles and text of the few matching notes or memos are sent to answer.'
    : 'Off on this server (NOTES_SEND_TO_GEMINI=false): note and memo text never leaves this Mac. Matching notes are listed in the conversation and in Notes.'
  ui.webState.textContent = c.web_search ? `Web search is available (${c.web_provider}).` : 'Web search is not configured (no TAVILY_API_KEY).'
  if (state.view === 'documents') refresh()
}

// ---- Documents view ----
const busy = new Set(['queued', 'extracting', 'embedding'])
const statusBadge = d => {
  if (d.status === 'ready') return el('span', {class: 'badge success', text: 'Ready'})
  if (d.status === 'error') return el('span', {class: 'badge danger', text: 'Error', title: d.error})
  return el('span', {class: 'badge warning', text: {queued: 'Queued', extracting: 'Reading', embedding: 'Indexing'}[d.status] || d.status})
}

async function refresh() {
  loadDevice()
  try {
    const data = await api('/api/docs')
    const docs = data.documents || []
    ui.docs.replaceChildren(...docs.map(row))
    ui.docEmpty.hidden = docs.length > 0
    ui.docCount.textContent = docs.length ? `${docs.length} document${docs.length === 1 ? '' : 's'}` : ''
    const c = data.capabilities || {}
    ui.docState.textContent = c.embedder_ready === false
      ? 'The local embedding service is not running: search is keyword-only and PDFs cannot be indexed until it starts.'
      : `Search uses ${c.embedding_model || 'local embeddings'} on this Mac. Maximum ${c.max_upload_mb || '?'} MB per file.`
    clearTimeout(pollTimer)
    if (docs.some(d => busy.has(d.status)) && state.view === 'documents') pollTimer = setTimeout(refresh, 1500)
  } catch (e) {
    ui.docs.replaceChildren(); ui.docEmpty.hidden = true
    ui.docState.textContent = e.message.includes('disabled') ? 'Local documents are disabled on this server (RAG_ENABLED=false).' : `Documents unavailable: ${e.message}`
  }
}

function row(d) {
  const err = d.error ? el('div', {class: 'small error-text', text: d.error}) : null
  const reindex = button('', () => api(`/api/docs/${d.id}/reindex`, {method: 'POST'}).then(refresh).catch(e => toast(e.message, {error: true})), {cls: 'btn ghost sm icon-only', iconName: 'refresh', title: `Re-index ${d.name}`, disabled: busy.has(d.status)})
  const del = button('', async () => {
    if (!await confirmDialog(`Delete “${d.name}” and its search index from this Mac?`, {title: 'Delete document'})) return
    api(`/api/docs/${d.id}`, {method: 'DELETE'}).then(() => { toast('Document deleted'); refresh() }).catch(e => toast(e.message, {error: true}))
  }, {cls: 'btn ghost sm icon-only danger', iconName: 'trash', title: `Delete ${d.name}`})
  return el('tr', {},
    el('td', {class: 'name'}, d.name, err),
    el('td', {class: 'hide-sm', text: d.type.toUpperCase()}),
    el('td', {class: 'hide-sm', text: formatBytes(d.size)}),
    el('td', {class: 'hide-sm', text: d.chunks ? String(d.chunks) : '—'}),
    el('td', {}, statusBadge(d)),
    el('td', {style: 'text-align:right;white-space:nowrap'}, reindex, del))
}

async function uploadFiles(files) {
  const max = state.capabilities.max_upload_mb
  for (const file of files) {
    if (max && file.size > max * 1048576) { toast(`${file.name} is larger than ${max} MB`, {error: true}); continue }
    const form = new FormData(); form.append('file', file)
    ui.docState.textContent = `Uploading ${file.name}…`
    try {
      const r = await api('/api/docs', {method: 'POST', body: form})
      toast(r.duplicate ? `${file.name}: already uploaded as ${r.document.name}` : r.replaced ? `${file.name}: new version, re-indexing` : `${file.name}: uploaded, indexing`)
    } catch (e) { toast(`${file.name}: ${e.message}`, {error: true}) }
  }
  refresh()
}

async function search(event) {
  event.preventDefault()
  const q = ui.searchInput.value.trim()
  if (!q) return
  ui.searchResults.replaceChildren(el('p', {class: 'loading', text: 'Searching…'}))
  try {
    const r = await api(`/api/docs/search?q=${encodeURIComponent(q)}`)
    if (!r.hits?.length) { ui.searchResults.replaceChildren(emptyState('search', 'No matching passages', r.warning || 'Try other words or upload the document first.')); return }
    ui.searchResults.replaceChildren(
      el('p', {class: 'small muted', text: `${r.hits.length} passage${r.hits.length === 1 ? '' : 's'} · ${r.method} search · ${r.total_ms.toFixed(0)} ms${r.warning ? ` · ${r.warning}` : ''}`}),
      el('div', {class: 'sources', style: 'margin-top:8px'}, ...r.hits.map(h => el('div', {class: 'source'},
        el('div', {class: 'source-head'}, el('span', {class: 'title', text: h.document}), el('small', {text: [h.page ? `page ${h.page}` : '', h.heading, `similarity ${h.similarity.toFixed(2)}`].filter(Boolean).join(' · ')})),
        el('p', {class: 'small', text: h.text, style: 'margin-top:6px;white-space:pre-wrap;color:var(--text-2)'})))))
  } catch (e) { ui.searchResults.replaceChildren(el('p', {class: 'error-text', text: e.message})) }
}

export function init() {
  try { localStorage.removeItem(LEGACY_CONSENT_KEY) } catch {} // the old choice outlived the tab; it is no longer used
  share.on = sessionGet(SHARE_KEY) === 'yes'
  renderShare()
  ui.consent.onchange = () => requestShare(ui.consent.checked)
  for (const sw of shareSwitches()) sw.addEventListener('click', () => requestShare(!share.on))
  ui.deviceSwitch.addEventListener('click', () => requestDevice(!device.allowed))
  ui.noteConsent.onchange = () => remember(NOTE_CONSENT_KEY, ui.noteConsent.checked ? 'yes' : 'no')
  ui.upload.onchange = () => { uploadFiles([...ui.upload.files]); ui.upload.value = '' }
  for (const ev of ['dragenter', 'dragover']) ui.drop.addEventListener(ev, e => { e.preventDefault(); ui.drop.classList.add('drag') })
  for (const ev of ['dragleave', 'drop']) ui.drop.addEventListener(ev, e => { e.preventDefault(); ui.drop.classList.remove('drag') })
  ui.drop.addEventListener('drop', e => uploadFiles([...e.dataTransfer.files]))
  ui.searchForm.onsubmit = search
  registerView('documents', {title: 'Documents', show: refresh,
    actions: () => [button('Upload', () => ui.upload.click(), {cls: 'btn primary sm', iconName: 'upload'})]})
}
