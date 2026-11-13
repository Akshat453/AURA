// Settings: only options the app actually supports. Theme and playback are
// per-browser preferences; privacy consents are sent with every turn and
// enforced by the server; health comes from /readyz.
import {$, el, api, registerView, recall, remember, on, state, button} from './ui.js'
import {setVolume} from './chat.js'

export function applyTheme(choice) {
  const dark = choice === 'dark' || (choice === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.querySelectorAll('[data-theme-choice]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice)))
}

async function listMicrophones() {
  const sel = $('microphone'), current = recall('pa-mic', sel.value)
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput')
    sel.replaceChildren(el('option', {value: '', text: 'System default'}), ...devices.filter(d => d.deviceId && d.deviceId !== 'default').map((d, i) => el('option', {value: d.deviceId, text: d.label || `Microphone ${i + 1}`})))
    if ([...sel.options].some(o => o.value === current)) sel.value = current
  } catch {}
  micPermission()
}

async function micPermission() {
  const hint = $('micPermission')
  try {
    const p = await navigator.permissions.query({name: 'microphone'})
    const text = {granted: 'Microphone access is allowed for this page.', denied: 'Microphone access is blocked. Allow it in the browser’s site settings (the icon left of the address), then reload.', prompt: 'The browser will ask for permission the first time you record.'}
    hint.textContent = text[p.state] || ''
    p.onchange = () => { hint.textContent = text[p.state] || '' }
  } catch { hint.textContent = '' }
}

async function health() {
  const box = $('health')
  box.replaceChildren(el('li', {class: 'loading', text: 'Checking…'}))
  const r = await fetch('/readyz').then(x => x.json()).catch(() => null)
  if (!r) { box.replaceChildren(el('li', {}, el('span', {class: 'dot bad'}), 'The assistant server is not reachable.')); return }
  const names = {whisper: 'Speech recognition (Whisper)', piper: 'Speech synthesis (Piper)', gemini: 'Gemini (cloud)', rag: 'Document search', web_search: 'Web search (Tavily)'}
  box.replaceChildren(...Object.entries(names).map(([k, label]) => {
    const v = r[k] || 'unknown'
    const ok = v === 'ok' || v.startsWith('configured'), off = v === 'disabled' || v === 'not configured'
    const detail = {ok: 'Ready', disabled: 'Disabled', 'not configured': 'Not configured'}[v] || (v.startsWith('configured') ? 'Configured' : v)
    return el('li', {}, el('span', {class: `dot ${ok ? 'ok' : off ? '' : 'bad'}`}), label, el('span', {class: 'muted', text: detail}))
  }))
  const p = state.prof
  $('aboutLine').textContent = p.enabled ? `Professor tools on · time zone ${p.timezone} · a confirmation question stays open for ${p.confirmation_timeout_s} s` : 'Professor tools are disabled on this server.'
}

function notifications() {
  const host = $('micTest').parentElement
  if (!('Notification' in window) || host.querySelector('#notifyBtn')) return
  const b = button(Notification.permission === 'granted' ? 'Desktop notifications on' : 'Allow desktop notifications', async () => {
    const r = await Notification.requestPermission()
    b.textContent = r === 'granted' ? 'Desktop notifications on' : 'Notifications blocked in the browser'
  }, {cls: 'btn sm', iconName: 'bell', id: 'notifyBtn', title: 'Show reminders as desktop notifications while this page is open', disabled: Notification.permission === 'granted'})
  host.append(b)
}

export function init() {
  const choice = recall('pa-theme', 'light')
  applyTheme(choice)
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (recall('pa-theme', 'light') === 'system') applyTheme('system') })
  document.querySelectorAll('[data-theme-choice]').forEach(b => { b.onclick = () => { remember('pa-theme', b.dataset.themeChoice); applyTheme(b.dataset.themeChoice) } })
  $('microphone').onchange = () => remember('pa-mic', $('microphone').value)
  $('micTest').onclick = async () => {
    try { const s = await navigator.mediaDevices.getUserMedia({audio: true}); s.getTracks().forEach(t => t.stop()) } catch {}
    listMicrophones()
  }
  const speak = $('speakReplies'), vol = $('volume')
  speak.checked = recall('pa-speak', 'yes') !== 'no'
  speak.onchange = () => remember('pa-speak', speak.checked ? 'yes' : 'no')
  vol.value = recall('pa-volume', '1')
  const showVol = () => { $('volumeValue').textContent = `${Math.round(vol.value * 100)}%` }
  vol.oninput = () => { setVolume(Number(vol.value)); showVol() }
  showVol()
  const diag = $('showDiag')
  diag.checked = recall('pa-diag') === 'yes'
  diag.onchange = () => remember('pa-diag', diag.checked ? 'yes' : 'no')
  $('healthRefresh').onclick = health
  on('microphones', listMicrophones)
  listMicrophones()
  registerView('settings', {title: 'Settings', show: () => { health(); micPermission(); notifications() }})
}
