// Shared UI helpers: DOM building, icons, API calls, toasts, dialogs and a
// tiny view registry. All user, document and model text is inserted with
// textContent (never as HTML).

export const $ = id => document.getElementById(id)

export function el(tag, props = {}, ...children) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') e.className = v
    else if (k === 'text') e.textContent = v
    else if (k === 'dataset') Object.assign(e.dataset, v)
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v)
    else if (k in e && typeof v !== 'string') e[k] = v
    else e.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c)
  return e
}

export function icon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', cls); svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', `#i-${name}`)
  svg.append(use)
  return svg
}

export function button(label, onclick, {cls = 'btn sm', iconName, title, type = 'button', ...rest} = {}) {
  const b = el('button', {class: cls, type, title, onclick, ...rest})
  if (iconName) b.append(icon(iconName))
  if (label) b.append(document.createTextNode(label))
  if (!label && title) b.setAttribute('aria-label', title)
  return b
}

// api calls the local backend. State-changing calls carry the custom header
// the server requires (it blocks cross-site requests).
export async function api(path, options = {}) {
  const r = await fetch(path, {...options, headers: {'X-Voice-Assistant': '1', ...(options.headers || {})}})
  if (!r.ok) throw new Error((await r.text()).trim() || r.statusText)
  return (r.headers.get('content-type') || '').includes('json') ? r.json() : r.text()
}
export const json = (method, body) => ({method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})

export function toast(message, {error = false, timeout = 4500} = {}) {
  const t = el('div', {class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status'}, icon(error ? 'alert' : 'check'), el('span', {text: message}))
  const box = $('toasts')
  box.append(t)
  while (box.children.length > 3) box.firstElementChild.remove() // never bury the page under notifications
  setTimeout(() => t.remove(), timeout)
}

export function emptyState(iconName, title, text, action) {
  return el('div', {class: 'empty'}, icon(iconName), el('strong', {text: title}), text ? el('div', {text}) : null, action || null)
}

export function remember(key, value) { try { localStorage.setItem(key, value) } catch {} }
export function recall(key, fallback = null) { try { return localStorage.getItem(key) ?? fallback } catch { return fallback } }

// ---- Dialogs (native <dialog>: focus trap, Escape and backdrop handling) ----

// openDialog shows a form dialog. onSubmit(form) may throw to show an error
// and keep the dialog open; the submit button is disabled while it runs, so a
// double click never submits twice.
export async function openDialog({title, body, submitLabel = 'Save', danger = false, onSubmit, extraFoot = []}) {
  const dialog = $('dialog')
  if (dialog.open) { // replacing a dialog: wait for its close event so it cannot be taken for ours
    const closed = new Promise(r => dialog.addEventListener('close', r, {once: true}))
    dialog.close('replaced')
    await closed
  }
  const error = el('p', {class: 'error-text', role: 'alert', hidden: true})
  const submit = el('button', {class: `btn ${danger ? 'danger solid' : 'primary'}`, type: 'submit', text: submitLabel})
  const cancel = el('button', {class: 'btn', type: 'button', text: 'Cancel', onclick: () => dialog.close('cancel')})
  const form = el('form', {class: 'dialog-body', method: 'dialog', novalidate: true},
    el('div', {class: 'dialog-head'}, el('h2', {id: 'dialogTitle', text: title}), button('', () => dialog.close('cancel'), {cls: 'btn ghost sm icon-only', iconName: 'x', title: 'Close'})),
    el('div', {class: 'dialog-main'}, body, error),
    el('div', {class: 'dialog-foot'}, ...extraFoot, el('span', {class: 'spacer'}), cancel, submit))
  dialog.replaceChildren(form)
  return new Promise(resolve => {
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (!form.reportValidity()) return
      submit.disabled = true; error.hidden = true
      try {
        const result = onSubmit ? await onSubmit(form) : true
        dialog.close('ok'); resolve(result ?? true)
      } catch (e) { error.textContent = e.message; error.hidden = false; submit.disabled = false }
    })
    dialog.addEventListener('close', () => { if (dialog.returnValue !== 'ok') resolve(null) }, {once: true})
    dialog.returnValue = ''
    dialog.showModal()
    const first = form.querySelector('.dialog-main input, .dialog-main textarea, .dialog-main select')
    first?.focus()
  })
}

export function confirmDialog(message, {title = 'Are you sure?', confirmLabel = 'Delete', danger = true} = {}) {
  return openDialog({title, body: el('p', {text: message}), submitLabel: confirmLabel, danger})
}

export function field(label, input, hint) {
  return el('label', {class: 'field'}, label, input, hint ? el('span', {class: 'hint', text: hint}) : null)
}

// latest returns a guard for overlapping refreshes of one list: only the
// newest request may render, so a slow older response never redraws stale data.
export function latest() {
  let seq = 0
  return () => { const mine = ++seq; return () => mine === seq }
}

// ---- View registry and events ----

export const views = new Map() // name -> {title, actions(), show()}
export function registerView(name, spec) { views.set(name, spec) }
export const bus = new EventTarget()
export function emit(type, detail) { bus.dispatchEvent(new CustomEvent(type, {detail})) }
export function on(type, fn) { bus.addEventListener(type, e => fn(e.detail)) }

// Shared server facts (filled by app.js): professor status and capabilities.
export const state = {prof: {enabled: false, features: {}}, capabilities: {}, view: ''}

export function feature(name) { return !!state.prof.features?.[name] }
