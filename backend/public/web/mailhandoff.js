// Mail hand-off: buttons that open a draft, pre-filled, in the professor's own
// mail client (Gmail, Outlook on the web, or the default mail app). This
// program never sends email; nothing leaves until the professor presses Send.
import {el, icon, button, toast} from './ui.js'
import {composeLinks} from './format.js'

const NOT_SENT = 'Nothing is sent until you press Send there.'

// openLink follows a link from inside the click handler, so popup blockers
// allow the new tab; mailto links stay in this tab and start the mail app.
function openLink(href, newTab) {
  const a = el('a', {href, hidden: true, ...(newTab ? {target: '_blank', rel: 'noopener noreferrer'} : {})})
  document.body.append(a)
  a.click()
  a.remove()
}

// mailHandoff returns the button row. getDraft() is called on every click and
// must return the live field values {to, cc, bcc, subject, body}, so unsaved
// edits are what the mail client receives.
export function mailHandoff(getDraft) {
  const go = (which, newTab) => () => {
    const d = getDraft()
    if (!String(d.subject ?? '').trim() && !String(d.body ?? '').trim()) { toast('Write a subject or some text first', {error: true}); return }
    const links = composeLinks(d)
    if (!links.bodyInUrl) {
      // Started before the link opens: the copy needs this page to have focus.
      const copied = navigator.clipboard?.writeText(d.body) ?? Promise.reject(new Error('no clipboard'))
      copied.then(() => toast('The text is too long for a link, so it was copied — paste it into the message body.', {timeout: 9000}))
        .catch(() => toast('The text is too long for a link and could not be copied. Use “Copy” and paste it into the message.', {error: true, timeout: 9000}))
    }
    openLink(links[which], newTab)
  }
  return el('div', {class: 'mail-handoff', role: 'group', 'aria-label': 'Open in your email client'},
    el('span', {class: 'label', title: `This program never sends email. ${NOT_SENT}`}, icon('info'), 'Review and send it yourself'),
    button('Open in Gmail', go('gmail', true), {cls: 'btn sm', iconName: 'mail', title: `Opens a Gmail compose window in a new tab with this draft filled in. ${NOT_SENT}`}),
    button('Open in Outlook', go('outlook', true), {cls: 'btn sm', iconName: 'mail', title: `Opens an Outlook (Microsoft 365) compose window in a new tab with this draft filled in. ${NOT_SENT}`}),
    button('Mail app', go('mailto', false), {cls: 'btn sm', iconName: 'send', title: `Opens your default mail app with this draft filled in. ${NOT_SENT}`}))
}

// draftFromAction reads a draft from a confirmation card: an input's current
// value when the card has one for the field, otherwise the proposed value.
export function draftFromAction(details = {}, fieldsEl) {
  const read = k => {
    const input = fieldsEl?.querySelector(`[data-field="${k}"]`)
    const v = input ? input.value : details[k]
    return Array.isArray(v) ? v.join(', ') : String(v ?? '')
  }
  return {to: read('to'), cc: read('cc'), bcc: read('bcc'), subject: read('subject'), body: read('body')}
}
