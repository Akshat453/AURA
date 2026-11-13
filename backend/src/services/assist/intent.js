// Professor tool routing: chooses which tool groups to offer per request
// (fewer tool declarations lower Gemini latency; docs/PROFESSOR_TOOLS.md).
// Signals: multilingual keywords, similarity to example requests (local
// embeddings), and the previous turn's groups for short follow-ups. When the
// embedder is unavailable or the scores are close it offers every tool, so
// uncertainty costs latency, never a missing tool.
import {fields} from '../../utils/gotext.js'

export const GroupTimetable = 'timetable'
export const GroupReminders = 'reminders'
export const GroupNotes = 'notes'
export const GroupDrafts = 'drafts'
export const GroupCalendar = 'calendar'

// groupTools lists the tools offered for each group, including read-only
// tools a request in that group commonly needs too.
export const groupTools = {
  [GroupTimetable]: ['get_today_timetable', 'get_next_class', 'get_free_time', 'get_upcoming_events'],
  [GroupReminders]: ['list_reminders', 'create_reminder', 'update_reminder', 'delete_reminder', 'get_upcoming_events', 'get_next_class', 'get_today_timetable'],
  [GroupNotes]: ['search_notes', 'get_note', 'save_note', 'update_note', 'delete_note', 'save_voice_memo'],
  [GroupDrafts]: ['save_email_draft', 'save_announcement_draft', 'list_drafts', 'get_today_timetable', 'get_next_class'],
  [GroupCalendar]: ['get_calendar_events', 'get_upcoming_events', 'get_today_timetable'],
}

// keywords are strong signals in English, romanized Hinglish and Devanagari.
// They only add groups; their absence never removes one.
const keywords = {
  [GroupTimetable]: ['lecture', 'class', 'timetable', 'time table', 'schedule', 'period', 'teaching', 'teach ', ' free ', 'busy', ' lab ', 'subject', 'which room',
    'padha', 'khali', 'क्लास', 'लेक्चर', 'कक्षा', 'समय सारणी', 'टाइमटेबल', 'पीरियड', 'पढ़ा', 'विषय', 'खाली', 'फ्री'],
  [GroupReminders]: ['remind', 'reminder', 'alarm', "don't let me forget", 'do not let me forget', 'yaad', 'याद', 'रिमाइंडर', 'अलार्म'],
  [GroupNotes]: ['note', 'memo', 'write down', 'jot', 'remember that', 'likh lo', 'likh do', 'likh lijiye', 'save this', 'नोट', 'मेमो', 'लिख लो', 'लिख दो',
    'लिखकर', 'रिकॉर्ड'],
  [GroupDrafts]: ['email', 'e-mail', 'mail', 'draft', 'announcement', 'announce', 'notice', 'circular', 'letter', 'rewrite', 'message to the students',
    'ईमेल', 'मेल', 'ड्राफ्ट', 'घोषणा', 'सूचना', 'नोटिस', 'सर्कुलर', 'पत्र'],
  [GroupCalendar]: ['meeting', 'calendar', 'appointment', 'event', 'मीटिंग', 'कैलेंडर', 'बैठक'],
}

// Examples per group (embedded once at startup with the local model).
export const exemplars = {
  [GroupTimetable]: ['When is my next lecture?', 'How many classes do I have today?', 'Which subject do I teach on Monday?', 'Am I free after lunch tomorrow?',
    'What is my schedule for Thursday?', 'Aaj kaunsi classes hain?', 'Kal pehla period kab hai?', 'मेरी अगली क्लास कौन सी है?', 'आज मुझे कितने लेक्चर लेने हैं?',
    'Where is my DBMS class?', 'Is my networks lecture over?', 'Do I have anything at 3 pm?'],
  [GroupReminders]: ['Remind me to submit the marks on Friday', 'Set a reminder for the staff meeting', 'Show my reminders for today', 'Cancel the attendance reminder',
    'Move my reminder to 6 pm', 'Kal subah yaad dilana', 'Mujhe 5 baje yaad dila dena', 'मुझे कल फ़ाइल जमा करना याद दिलाना', 'मेरे रिमाइंडर दिखाओ',
    'Which reminders are overdue?', 'Mark the quiz reminder as done'],
  [GroupNotes]: ["Save a note about today's lecture", 'Remember that I need to revise normalization', 'What did I write about indexing?', 'Delete my note on transactions',
    'Find my notes on computer networks', 'Add this to my lab note', 'Ek note likh lo', 'मेरे नोट्स में इंडेक्सिंग के बारे में क्या है?', 'यह नोट सेव कर दो',
    'Save a voice memo', 'Read my memo about the projector'],
  [GroupDrafts]: ['Draft an email to the head of department', 'Write an announcement about the quiz', "Create a notice cancelling tomorrow's class",
    'Rewrite this email professionally', 'Write a circular for the department', 'Students ko assignment deadline ka message likho', 'छात्रों के लिए एक घोषणा लिखो',
    'Prepare a mail to the coordinator', 'Show my saved drafts'],
  [GroupCalendar]: ['What meetings do I have today?', 'Check my Google calendar for tomorrow', 'When is the faculty meeting?', 'Do I have any appointments this week?',
    'आज मेरी कौन सी मीटिंग है?'],
}

// generalExamples are questions that need no professor tools.
export const generalExamples = [
  'What is database normalization?', 'Explain the TCP three-way handshake', 'Tell me a joke', 'Who invented the World Wide Web?', 'Translate this sentence into Hindi',
  'What is the difference between a process and a thread?', 'Summarize the uploaded paper', 'What does unit 3 of the syllabus cover?', 'What is the latest news about AI?',
  'How do B+ trees work?', 'Thank you', 'Hello, how are you?', 'BCNF kya hota hai?', 'नॉर्मलाइज़ेशन क्या है?', 'मशीन लर्निंग समझाओ', 'Give me an example of a deadlock',
  'What is the weather like today?', 'Who is the prime minister of India?', 'How many credits is the DBMS course?', 'Explain recursion with an example',
]

// intentToolNames filters the available (enabled and permitted) tools by the
// selected groups, keeping their order. Routing can only remove tools.
export function intentToolNames(intent, available) {
  if (intent.all) return available
  const want = new Set()
  for (const g of intent.groups ?? []) for (const t of groupTools[g] ?? []) want.add(t)
  return available.filter(t => want.has(t))
}

function normalizeText(s) {
  let out = ''
  for (const r of s.toLowerCase()) out += /[\p{L}\p{Nd}\p{Mn}\p{Mc}'-]/u.test(r) ? r : ' '
  return fields(out).join(' ')
}

function cosineMax(q, list) {
  let best = -1
  for (const v of list) {
    let s = 0
    for (let i = 0; i < q.length; i++) s += q[i] * v[i]
    best = Math.max(best, s)
  }
  return best
}

export class IntentRouter {
  constructor(embedder) {
    this.embedder = embedder
    this.ready = false
    this.group = new Map()
    this.gen = []
    // taskMargin: how much more similar to a professor request than to general
    // chat a prompt must be to count as task-like (calibrated with tool-bench).
    this.taskMargin = 0.02
    // nearBest: groups within this of the closest group are offered too.
    this.nearBest = 0.01
  }

  // init embeds the examples. Until it succeeds, route offers all tools.
  async init(ctx) {
    if (!this.embedder) throw new Error('no embedder')
    const texts = []
    const owners = []
    for (const [g, list] of Object.entries(exemplars)) for (const t of list) {
      texts.push(t)
      owners.push(g)
    }
    for (const t of generalExamples) {
      texts.push(t)
      owners.push('')
    }
    const vecs = await this.embedder.embed(ctx, texts, 'query')
    const group = new Map()
    const gen = []
    vecs.forEach((v, i) => {
      if (owners[i] === '') gen.push(v)
      else {
        if (!group.has(owners[i])) group.set(owners[i], [])
        group.get(owners[i]).push(v)
      }
    })
    this.group = group
    this.gen = gen
    this.ready = true
  }

  // route decides the tool groups for prompt. recent describes the previous
  // turn, whose tools are kept for short follow-ups.
  async route(ctx, prompt, recent) {
    const start = performance.now()
    const text = ' ' + normalizeText(prompt) + ' '
    const set = new Set()
    const reasons = []
    for (const [g, words] of Object.entries(keywords)) {
      for (const w of words) {
        const lw = w.toLowerCase()
        if (text.includes(lw) || text.includes(' ' + lw.trim() + ' ')) {
          set.add(g)
          reasons.push('keyword:' + g)
          break
        }
      }
    }
    const done = intent => ({...intent, ms: Math.round((performance.now() - start) * 1000) / 1000})
    const followUp = recent && fields(text).length <= 6
    if (followUp && recent.all) return done({all: true, reason: 'follow-up'})
    const carry = intent => {
      if (!followUp || intent.all) return intent
      for (const g of recent.groups ?? []) {
        if (!intent.groups.includes(g)) {
          intent.groups.push(g)
          intent.reason += ',follow-up:' + g
        }
      }
      intent.groups.sort()
      return intent
    }
    if (!this.ready) return done({all: true, reason: 'embeddings unavailable'}) // without embeddings, stay generous
    let vecs
    const [ectx, cancel] = ctx.withTimeout(300)
    try {
      vecs = await Promise.race([this.embedder.embed(ectx, [prompt], 'query'), ectx.done().then(() => Promise.reject(ectx.err))])
    } catch {
      vecs = null
    } finally {
      cancel()
    }
    if (!vecs || vecs.length !== 1) return done({all: true, reason: 'embedding failed'})
    const q = vecs[0]
    const scores = {general: cosineMax(q, this.gen)}
    for (const [g, list] of this.group) scores[g] = cosineMax(q, list)
    let best = -1
    for (const g of this.group.keys()) best = Math.max(best, scores[g])
    const margin = best - scores.general
    if (set.size > 0) {
      if (margin >= this.taskMargin) { // safety net: also the closest groups
        for (const g of this.group.keys()) {
          if (scores[g] >= best - this.nearBest && !set.has(g)) {
            set.add(g)
            reasons.push('similar:' + g)
          }
        }
      }
    } else if (margin >= this.taskMargin) {
      return done({all: true, reason: 'task without keyword', scores})
    } else if (margin >= 0) { // close call (also for follow-ups): every tool
      return done({all: true, reason: 'uncertain', scores})
    }
    const intent = {groups: [...set].sort(), all: false, reason: reasons.join(','), scores}
    if (intent.groups.length === 0) intent.reason = 'general'
    return done(carry(intent))
  }
}
