// Application shell: hash routing (#/view or #/view/argument), header,
// mobile navigation, feature visibility and connection status.
import {$, api, on, views, state} from './ui.js'
import * as chat from './chat.js'
import * as knowledge from './knowledge.js'
import * as professor from './professor.js'
import * as settings from './settings.js'

const app = $('app')

function setNav(open) {
  app.classList.toggle('nav-open', open)
  $('menuButton').setAttribute('aria-expanded', String(open))
  if (open) document.querySelector('.sidebar .nav-item[aria-current="page"]')?.focus()
}

function applyFeatures() {
  const p = state.prof
  document.querySelectorAll('[data-feature]').forEach(n => { n.hidden = !(p.enabled && p.features?.[n.dataset.feature]) })
  document.querySelector('[data-group="teaching"]').hidden = !(p.features?.timetable || p.features?.reminders)
}

function route() {
  const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/')
  let view = views.has(name) ? name : 'dashboard'
  if (document.querySelector(`.nav-item[data-view="${view}"]`)?.hidden) view = 'dashboard'
  const arg = rest.join('/') || undefined
  state.view = view
  document.querySelectorAll('section[data-view]').forEach(s => { s.hidden = s.dataset.view !== view })
  document.querySelectorAll('.nav-item').forEach(a => {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current')
  })
  const spec = views.get(view)
  $('viewTitle').textContent = spec.title
  document.title = `${spec.title} · Professor Assistant`
  $('viewActions').replaceChildren(...(spec.actions?.() || []))
  setNav(false)
  if (view !== 'assistant') $('content').scrollTop = 0
  spec.show?.(arg)
  if (arg && view !== 'assistant') history.replaceState(null, '', `#/${view}`) // "new" opens a form once, not on every reload
}

on('connection', online => {
  const c = $('connection')
  c.className = `status ${online ? 'online' : 'offline'}`
  c.querySelector('.label').textContent = online ? 'Connected' : 'Reconnecting…'
  c.title = online ? 'Connected to the local assistant' : 'The local assistant is not reachable; retrying'
})

async function boot() {
  try { state.prof = await api('/api/professor') } catch { state.prof = {enabled: false, features: {}} }
  applyFeatures()
  if (state.prof.timezone) $('sidebarFoot').textContent = `Everything runs on this Mac · ${state.prof.timezone}`
  settings.init()
  knowledge.init()
  professor.init()
  chat.init()
  $('menuButton').onclick = () => setNav(!app.classList.contains('nav-open'))
  $('scrim').onclick = () => setNav(false)
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && app.classList.contains('nav-open')) setNav(false) })
  document.querySelectorAll('[data-focus]').forEach(a => a.addEventListener('click', () => setTimeout(() => $(a.dataset.focus)?.focus(), 80)))
  document.querySelectorAll('#dashQuick [data-open]').forEach(a => { a.href = `${a.getAttribute('href')}/new` })
  window.addEventListener('hashchange', route)
  route()
}

boot()
