// Unit tests for the browser formatting helpers: node --test backend/tests/frontend/
import test from 'node:test'
import assert from 'node:assert/strict'

const f = await import('../../public/web/format.js')

test('dates follow the professor time zone, not the browser', () => {
  const lateEveningUTC = new Date('2026-10-20T20:00:00Z') // 01:30 next day in India
  assert.equal(f.ymd(lateEveningUTC, 'Asia/Kolkata'), '2026-10-21')
  assert.equal(f.ymd(lateEveningUTC, 'UTC'), '2026-10-20')
})

test('relative day labels and reminder due labels', () => {
  assert.equal(f.dayLabel('2026-10-21', '2026-10-21'), 'Today')
  assert.equal(f.dayLabel('2026-10-22', '2026-10-21'), 'Tomorrow')
  assert.equal(f.dayLabel('2026-10-20', '2026-10-21'), 'Yesterday')
  assert.equal(f.dayLabel('2026-10-24', '2026-10-21'), 'Sat 24 Oct')
  assert.equal(f.dueLabel('2026-10-22T10:00', '2026-10-21'), 'Tomorrow, 10:00 AM')
  assert.equal(f.dueLabel('2026-10-21T17:30', '2026-10-21'), 'Today, 5:30 PM')
  assert.equal(f.dayDiff('2026-12-31', '2027-01-01'), 1)
})

test('compact time ranges', () => {
  assert.equal(f.clockRange('10:00', '11:00'), '10:00–11:00 AM')
  assert.equal(f.clockRange('11:15', '12:15'), '11:15 AM–12:15 PM')
  assert.equal(f.clockRange('14:00', '16:00'), '2:00–4:00 PM')
})

test('12-hour clock', () => {
  assert.equal(f.clock12('00:05'), '12:05 AM')
  assert.equal(f.clock12('12:00'), '12:00 PM')
  assert.equal(f.clock12('09:30'), '9:30 AM')
})

test('citations are split from the answer text', () => {
  assert.deepEqual(f.splitCitations('BCNF [D1] and web [W2, W3].'),
    [{text: 'BCNF '}, {cite: ['D1']}, {text: ' and web '}, {cite: ['W2', 'W3']}, {text: '.'}])
  assert.deepEqual(f.splitCitations('No citations here'), [{text: 'No citations here'}])
  assert.deepEqual(f.splitCitations('[note_x] is not a citation'), [{text: '[note_x] is not a citation'}])
})

test('tool labels are friendly and de-duplicated', () => {
  assert.deepEqual(f.toolLabels(['get_next_class', 'get_today_timetable', 'create_reminder']), ['Checked timetable', 'Prepared a reminder'])
  assert.equal(f.toolLabel('something_new'), 'something new')
})

test('sizes, durations and greetings', () => {
  assert.equal(f.formatBytes(512), '512 B')
  assert.equal(f.formatBytes(2048), '2 KB')
  assert.equal(f.formatBytes(3 * 1048576), '3.0 MB')
  assert.equal(f.seconds(1340), '1.3 s')
  assert.equal(f.greeting(9), 'Good morning')
  assert.equal(f.greeting(14), 'Good afternoon')
  assert.equal(f.greeting(20), 'Good evening')
})

// ---- Compose links ----
const q = (url, key) => new URL(url).searchParams.get(key)

test('compose links for a normal draft', () => {
  const l = f.composeLinks({to: 'hod@college.edu, dean@college.edu', cc: ['tara@college.edu'], bcc: '', subject: 'DBMS lecture moved', body: 'Dear all,\nThursday is in LH-3.\n\nRegards'})
  assert.equal(l.bodyInUrl, true)
  assert.ok(l.gmail.startsWith('https://mail.google.com/mail/?view=cm&fs=1&'))
  assert.equal(q(l.gmail, 'to'), 'hod@college.edu,dean@college.edu')
  assert.equal(q(l.gmail, 'cc'), 'tara@college.edu')
  assert.equal(q(l.gmail, 'su'), 'DBMS lecture moved')
  assert.equal(q(l.gmail, 'body'), 'Dear all,\nThursday is in LH-3.\n\nRegards')
  assert.ok(l.outlook.startsWith('https://outlook.office.com/mail/deeplink/compose?'))
  assert.equal(q(l.outlook, 'to'), 'hod@college.edu;dean@college.edu')
  assert.equal(q(l.outlook, 'subject'), 'DBMS lecture moved')
  assert.equal(q(l.outlook, 'body'), 'Dear all,\nThursday is in LH-3.\n\nRegards')
  assert.ok(l.mailto.startsWith('mailto:hod@college.edu,dean@college.edu?'))
  assert.ok(l.mailto.includes('subject=DBMS%20lecture%20moved')) // %20, never "+"
  assert.ok(l.mailto.includes('body=Dear%20all%2C%0D%0AThursday')) // CRLF line breaks
  assert.ok(!/%0D%0D|%0A%0A%0D/.test(l.mailto))
})

test('invalid addresses are dropped, valid ones kept once', () => {
  assert.deepEqual(f.cleanAddresses('a@x.edu; not-an-address, b@y.co.in , A@X.edu, John Doe <j@x.edu>, "q"@x.edu, c@x, d@-x.edu, e..f@x.edu'), ['a@x.edu', 'b@y.co.in'])
  assert.deepEqual(f.cleanAddresses(['first.last+tag@uni.ac.in', 'two words@x.edu', null]), ['first.last+tag@uni.ac.in'])
  const l = f.composeLinks({to: 'ok@college.edu, bad address@college.edu', subject: 's', body: 'b'})
  assert.equal(q(l.gmail, 'to'), 'ok@college.edu')
  assert.ok(l.mailto.startsWith('mailto:ok@college.edu?'))
})

test('header injection through the subject or addresses is not possible', () => {
  const l = f.composeLinks({to: 'a@x.edu\r\nBcc: spy@evil.com', cc: 'b@x.edu%0ABcc:spy@evil.com', bcc: 'c@x.edu?bcc=spy@evil.com', subject: 'Hello\r\nBcc: spy@evil.com\nX-Test: 1', body: 'Hi'})
  for (const url of [l.gmail, l.outlook, l.mailto]) {
    const u = new URL(url)
    assert.equal(u.protocol === 'mailto:' ? u.pathname : u.searchParams.get('to'), '', url)
    for (const k of ['cc', 'bcc']) assert.equal(u.searchParams.get(k), '', url)
    assert.ok(!/%0D|%0A/i.test(url.split(/[?&]body=/)[0]), `no line breaks outside the body: ${url}`)
    assert.ok(!/[\r\n]/.test(url))
  }
  assert.equal(q(l.gmail, 'su'), 'Hello Bcc: spy@evil.com X-Test: 1')
  assert.equal(q(l.gmail, 'to'), '')
  assert.equal(q(l.gmail, 'bcc'), '')
  // A body with "&" or "#" stays inside the body parameter.
  const amp = f.composeLinks({to: 'a@x.edu', subject: 'A & B #1', body: 'x&bcc=spy@evil.com#y'})
  assert.equal(q(amp.gmail, 'bcc'), '')
  assert.equal(q(amp.gmail, 'body'), 'x&bcc=spy@evil.com#y')
  assert.equal(q(amp.outlook, 'subject'), 'A & B #1')
})

test('a very long body is left out of the links', () => {
  const body = 'यह एक लंबा संदेश है। '.repeat(400)
  const l = f.composeLinks({to: 'a@x.edu', subject: 'Long', body})
  assert.equal(l.bodyInUrl, false)
  for (const url of [l.gmail, l.outlook, l.mailto]) assert.ok(url.length <= f.MAX_COMPOSE_URL, `${url.length}`)
  assert.equal(q(l.gmail, 'body'), '')
  assert.equal(q(l.gmail, 'su'), 'Long')
  assert.equal(f.MAX_COMPOSE_URL, 1900)
  // Just under the limit keeps the body.
  assert.equal(f.composeLinks({to: 'a@x.edu', subject: 'Short', body: 'ok '.repeat(300)}).bodyInUrl, true)
})

test('announcements without recipients still get links', () => {
  const l = f.composeLinks({subject: 'Quiz on Friday', body: 'CS-301: quiz on Friday.'})
  assert.equal(l.bodyInUrl, true)
  assert.equal(q(l.gmail, 'to'), '')
  assert.equal(q(l.outlook, 'to'), '')
  assert.ok(l.mailto.startsWith('mailto:?cc=&bcc=&subject=Quiz%20on%20Friday&body='))
})

test('server errors become sentences, never raw network errors', () => {
  const e = (code, message) => f.friendlyError({code, message})
  assert.match(e('stt_failed', 'Post "http://127.0.0.1:8082/inference": dial tcp 127.0.0.1:8082: connect: connection refused'), /not running on this Mac/)
  assert.match(e('stt_failed', 'whisper: no speech recognized'), /did not catch any speech/)
  assert.match(e('llm_failed', "Gemini's request limit was reached (HTTP 429, free-tier requests per minute); please try again in about a minute"), /request limit/)
  assert.match(e('llm_failed', 'Gemini request failed: Post "https://generativelanguage.googleapis.com/…": dial tcp: lookup generativelanguage.googleapis.com: no such host'), /internet connection/)
  assert.match(e('llm_failed', 'Gemini request failed: Error 400, Message: API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT'), /GEMINI_API_KEY/)
  assert.match(e('tts_failed', 'piper 403 Forbidden: '), /could not be spoken/)
  for (const code of ['stt_failed', 'llm_failed', 'tts_failed']) assert.doesNotMatch(e(code, 'dial tcp 127.0.0.1:1: connect: connection refused'), /dial tcp|127\.0\.0\.1|403/)
  assert.equal(e(undefined, undefined), 'Something went wrong.')
})

test('failed tool chips read naturally', () => {
  assert.equal(f.toolFailedLabel('web_search'), 'Web search failed')
  assert.equal(f.toolFailedLabel('search_local_docs'), 'Document search failed')
  assert.equal(f.toolFailedLabel('get_next_class'), 'A lookup failed')
  assert.equal(f.toolFailedLabel('create_reminder'), 'An action could not be prepared')
})
