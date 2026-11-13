// Demo data for development and evaluation. Every row has a fixed id that
// contains "seed", so seeding is idempotent (an upsert by id) and never
// touches rows the professor created. All names, addresses and figures are
// fictional; addresses use the reserved example.com domain.
import {goWeekday, localLayout} from '../../utils/time.js'
import {nextOccurrence} from './reminders.js'
import {parseClock} from './timetable.js'
import {recipientsJSON} from '../email/drafts.js'

const seedClasses = [
  ['Database Management Systems', 'CS-301', 'A', 'E-204', 1, '09:00', '10:00', '', '', true],
  ['Computer Networks', 'CS-305', 'B', 'E-108', 1, '11:15', '12:15', '', '', true],
  ['DBMS Lab', 'CS-391', 'A', 'Lab-3', 1, '14:00', '16:00', '', '', true],
  ['Agile Software Development', 'CS-342', 'A', 'E-210', 2, '10:00', '11:00', '', '', true],
  ['Operating Systems', 'CS-302', 'B', 'E-108', 2, '12:00', '13:00', '', '', true],
  ['Computer Networks Lab', 'CS-395', 'B', 'Lab-2', 2, '15:00', '17:00', '', '', true],
  ['Database Management Systems', 'CS-301', 'A', 'E-204', 3, '09:00', '10:00', '', '', true],
  ['Machine Learning', 'CS-411', 'C', 'E-305', 3, '11:15', '12:15', '', '', true],
  ['Final-year Project Mentoring', 'CS-499', '', 'Faculty cabin F-12', 3, '14:00', '15:00', '', '', true],
  ['Agile Software Development', 'CS-342', 'A', 'E-210', 4, '10:00', '11:00', '', '', true],
  ['Operating Systems', 'CS-302', 'B', 'E-108', 4, '12:00', '13:00', '', '', true],
  ['Machine Learning Lab', 'CS-491', 'C', 'Lab-5', 4, '14:00', '16:00', '', '', true],
  ['Computer Networks', 'CS-305', 'B', 'E-108', 5, '09:00', '10:00', '', '', true],
  ['Machine Learning', 'CS-411', 'C', 'E-305', 5, '11:15', '12:15', '', '', true],
  ['Research Seminar', '', '', 'Seminar Hall', 5, '15:00', '16:00', '', '', true],
  ['DBMS Remedial Session', 'CS-301', 'A', 'E-204', 6, '10:00', '12:00', '', '', false],
]

// [title, description, dueDays (relative to today), local HH:MM, recurrence, completed, createdAgo]
const seedReminders = [
  ['Submit CS-301 mid-semester marks on the ERP portal', 'Marks for Section A, 64 students. Moderation sheet is in the department shared drive.', 2, '17:00', 'none', false, 6],
  ['Review Team 4 sprint demo (Agile Lab)', '', 1, '11:00', 'none', false, 3],
  ['Book Seminar Hall for the guest lecture on cloud databases', 'Confirm projector and microphone with the estate office.', 4, '10:30', 'none', false, 9],
  ['Send DBMS lab manual to the department office for printing', 'Print 70 copies; estimated cost ₹4,200 from the lab budget.', -3, '16:00', 'none', false, 14],
  ['Upload Operating Systems assignment 3', '', -1, '09:30', 'none', false, 8],
  ['Collect lab records from CS-391 batch A', '', 0, '15:30', 'none', false, 2],
  ['Prepare quiz 2 for Computer Networks', 'Topics: TCP congestion control, flow control, sliding window. 15 MCQs and 2 numericals.', 5, '18:00', 'none', false, 7],
  ['Attendance shortage list to the academic office', '', 7, '12:00', 'none', false, 10],
  ['Check plagiarism report for M.Tech thesis drafts', 'Three drafts submitted; threshold is 10 percent similarity.', 10, '14:00', 'none', false, 12],
  ['Daily: check project group messages', '', 1, '08:45', 'daily', false, 40],
  ['Weekday: update the attendance register', '', 1, '17:30', 'weekdays', false, 60],
  ['Weekly: Agile Lab sprint review slot', 'Every Thursday after the ML lab.', 2, '16:15', 'weekly', false, 55],
  ['Weekly: research group meeting', '', 4, '16:30', 'weekly', false, 80],
  ['Renew IEEE membership', 'Fee ₹2,950 for the academic year.', 14, '11:00', 'none', false, 20],
  ['Submit consultancy project invoice', 'Invoice of ₹1,25,000 for the database audit; send through the R&D cell.', 21, '11:30', 'none', false, 15],
  ['Return library book: Database System Concepts (7th ed.)', '', -20, '10:00', 'none', true, 45],
  ['Finalize CS-342 course outcome mapping', '', -35, '15:00', 'none', true, 50],
  ['Send internship recommendation letter', 'For a final-year student applying to a Bengaluru start-up (letter drafted in Drafts).', -12, '12:00', 'none', true, 25],
  ['Invigilation duty: end-semester exam, Block E', '', -55, '09:00', 'none', true, 70],
  ['Department meeting on NBA accreditation documents', 'Bring course files for CS-301 and CS-305.', -40, '14:30', 'none', true, 52],
  ['Submit leave application for the conference', '', -60, '10:00', 'none', true, 85],
  ['Order Raspberry Pi kits for the IoT lab', '12 kits at ₹6,800 each; total ₹81,600. Quotation from two vendors needed.', -8, '13:00', 'none', true, 30],
  ['Grade Agile Lab sprint 2 retrospectives', '', -15, '17:00', 'none', true, 28],
  ['Call with industry mentor about the capstone review', '', -5, '16:00', 'none', true, 11],
  ['Feedback form for the faculty development programme', '', -27, '11:00', 'none', true, 33],
  ['Verify answer-sheet totals before results are published', 'A long reminder to check every answer sheet total twice, compare the ERP entries with the award list, sign each page of the award list, and hand the sealed packet to the examination section before the deadline so that results are not delayed for any section.', 3, '09:15', 'none', false, 1],
]

// [title, body, tags, source, createdAgo, updatedAgo]
const seedNotes = [
  ['DBMS lecture 14 — normalization recap', 'Covered 1NF to BCNF with the university enrolment example. Students struggled with identifying partial dependencies. Next class: start with a 5-minute dependency diagram exercise.', 'dbms,lecture', 'typed', 75, 74],
  ['Agile Lab: sprint planning checklist', '1. Product backlog refined and ordered by the Product Owner.\n2. Sprint goal agreed in one sentence.\n3. Stories estimated with planning poker (Fibonacci points).\n4. Capacity checked against holidays.\n5. Definition of Done visible on the board.', 'agile,lab', 'typed', 70, 12],
  ['Computer Networks — common mistakes in quiz 1', 'Many answers confused flow control with congestion control. Several students used bits instead of bytes in throughput numericals. Add two solved examples in the next tutorial.', 'cn,quiz', 'typed', 66, 66],
  ['Research idea: retrieval for Hindi lecture notes', 'Try multilingual embeddings (e5-small) with hybrid keyword search. Measure recall@5 on 50 Hindi and Hinglish questions. Possible M.Tech project.', 'research,nlp', 'typed', 62, 30],
  ['Meeting notes: department curriculum committee', 'Decided to add a DevOps elective in semester 7. CI/CD with GitHub Actions to be part of the Agile Lab from next year. Action: draft syllabus by next month.', 'meeting,curriculum', 'typed', 58, 58],
  ['OS lab — deadlock demo idea', 'Use the dining philosophers simulation and let students add resource ordering to remove the deadlock.', 'os,lab', 'assistant', 55, 55],
  ['Machine Learning — project topics shortlist', 'Crop yield prediction for Gujarat districts; traffic sign recognition; sentiment on regional-language reviews; electricity demand forecasting for the campus.', 'ml,projects', 'typed', 52, 20],
  ['Guest lecture follow-up', 'Speaker suggested a hands-on session on cloud databases. Ask the training and placement cell about funding (approx. ₹15,000).', 'events', 'assistant', 49, 49],
  ['अगले सप्ताह की योजना', 'सोमवार को DBMS की क्विज़, बुधवार को ML लैब का मूल्यांकन, और शुक्रवार को रिसर्च सेमिनार की तैयारी करनी है।', 'planning,hindi', 'assistant', 45, 45],
  ['Exam paper pattern for CS-305', 'Part A: 10 short questions (2 marks each). Part B: 5 out of 7 long questions (10 marks each). Include at least two numericals on subnetting.', 'cn,exam', 'typed', 42, 40],
  ['Student counselling — attendance follow-up', 'Spoke to three students below 75 percent attendance. Agreed on a recovery plan with weekly check-ins. No names recorded here by policy.', 'mentoring', 'typed', 38, 38],
  ['Agile Lab: retrospective formats to try', 'Start/Stop/Continue; Mad/Sad/Glad; Sailboat. Rotate the format every sprint so teams stay engaged.', 'agile,lab', 'typed', 35, 35],
  ['DBMS — transaction isolation examples', 'Show dirty read, non-repeatable read and phantom read with two database sessions and compare the isolation levels.', 'dbms,lecture', 'typed', 31, 31],
  ['Conference travel checklist', 'Register online, apply for duty leave, book train to Pune, carry the poster tube and two printed copies of the paper.', 'travel', 'typed', 29, 29],
  ['Lab budget summary', 'Consumables ₹18,500; software licences ₹42,000; repair of two projectors ₹7,300. Total requested ₹67,800.', 'admin,budget', 'typed', 26, 26],
  ['Ideas for the IoT voice assistant demo', 'Show a reminder being created by voice, then the confirmation card. Mention that drafts are never sent automatically.', 'iot,demo', 'assistant', 22, 6],
  ['Operating Systems — page replacement worksheet', 'FIFO, LRU and Optimal on the reference string 7 0 1 2 0 3 0 4 2 3 0 3 2. Ask students to count page faults with 3 frames.', 'os,lecture', 'typed', 19, 19],
  ['Placement drive notes', 'Two product companies visiting next month. Students should revise SQL joins, indexing and basic system design.', 'placements', 'typed', 16, 16],
  ['Quick thought', 'Move the ML lab viva to the last week.', '', 'assistant', 13, 13],
  ['Paper review comments', 'The related-work section misses recent retrieval-augmented generation papers. Ask the authors to report latency on commodity hardware.', 'research,review', 'typed', 11, 11],
  ['Agile Lab: Definition of Done (draft)', 'Code reviewed by one teammate; unit tests pass; feature demonstrated on the shared environment; README updated; no open critical bugs.', 'agile,lab', 'typed', 9, 3],
  ['Hinglish reminder for myself', 'Kal subah 9 baje DBMS class se pehle attendance sheet print karni hai.', 'planning', 'assistant', 6, 6],
  ['Long note: semester reflection', 'This semester the flipped-classroom experiment in DBMS worked better than expected: students watched short videos before class and spent lecture time on design exercises. Attendance stayed above 85 percent and quiz averages rose by about eight marks. '.repeat(6), 'reflection,teaching', 'typed', 4, 1],
  ['Networking lab equipment issue', 'Switch in Lab-2 rack 3 drops packets intermittently. Raised a ticket with the IT helpdesk.', 'cn,lab,admin', 'typed', 2, 2],
  ['Untitled thought', 'Check whether the timetable change for Friday is final.', '', 'assistant', 0, 0],
]

// [title, transcript, language, seconds, createdAgo]
const seedMemos = [
  ['Idea for DBMS assignment', 'For the next DBMS assignment, ask students to design the schema for a college canteen ordering system and normalise it to third normal form.', 'en', 14, 80],
  ['Lab equipment request', 'Remind the lab assistant to request two more network switches and a crimping tool kit for Lab-2.', 'en', 9, 63],
  ['Feedback on Team 2 demo', 'Team 2 showed a working login and dashboard but no tests. In the next sprint they must add unit tests before new features.', 'en', 12, 47],
  ['क्विज़ के प्रश्न', 'नेटवर्क्स की क्विज़ में सबनेटिंग के दो प्रश्न और टीसीपी हैंडशेक का एक प्रश्न जोड़ना है।', 'hi', 11, 40],
  ['Research meeting summary', 'We agreed to collect fifty Hindi questions for the retrieval benchmark and to report recall at five.', 'en', 16, 33],
  ['Quick memo', 'Call the estate office about the projector in E-204.', 'en', 5, 27],
  ['Exam duty swap', 'Ask a colleague whether we can swap invigilation duties on the twentieth.', 'en', 7, 21],
  ['Project mentoring notes', 'Group 7 wants to use SQLite for their final-year project. Suggest they keep migrations in version control.', 'en', 13, 14],
  ['Kal ki class', "Kal ki OS class mein deadlock detection ka example dikhana hai, banker's algorithm ke saath.", 'hi', 10, 9],
  ['Guest lecture thank-you', 'Send a thank-you note to the guest speaker and share the photos with the department.', 'en', 8, 5],
  ['Agile Lab retro reminder', 'Remind all teams to bring their burndown charts to the sprint review on Thursday.', 'en', 9, 2],
  ['Empty-ish memo', 'Okay.', 'en', 2, 1],
]

// [kind, subject, to, cc, audience, body, createdAgo]
const seedDrafts = [
  ['email', 'CS-301 mid-semester marks published', ['cs301.section.a@example.com'], null, '', 'Dear students,\n\nThe mid-semester marks for Database Management Systems are now available on the ERP portal. Please check your marks and contact me during office hours (Tuesday 15:00–16:00) if you see any discrepancy.\n\nRegards,\nCourse Instructor, CS-301', 3],
  ['announcement', 'Agile Lab sprint review schedule', null, null, 'B.Tech CSE, Semester 5', 'Sprint 3 reviews will take place on Thursday in Lab-5 from 16:15. Each team has 10 minutes for the demo and 5 minutes for questions. Bring your updated product backlog and burndown chart.', 5],
  ['email', 'Request for Seminar Hall booking', ['estate.office@example.com'], ['hod.cse@example.com'], '', 'Dear Sir/Madam,\n\nI would like to book the Seminar Hall on Friday from 15:00 to 17:00 for a guest lecture on cloud databases. Approximately 120 students will attend. A projector and two microphones are required.\n\nThank you.', 9],
  ['email', 'Quotation request: Raspberry Pi kits', ['sales@vendor-one.example.com'], null, '', 'Hello,\n\nPlease share a quotation for 12 Raspberry Pi 5 starter kits (8 GB) including power supply and case, delivered to our campus in Gandhinagar. Kindly include GST and delivery charges in INR.\n\nRegards', 31],
  ['announcement', 'Change in Friday class timing', null, null, 'CS-305 Section B', "This Friday's Computer Networks class is moved from 09:00 to 11:15 in room E-108 because of the department event.", 12],
  ['email', 'Internship recommendation', [], null, '', 'To whom it may concern,\n\nI am pleased to recommend my student for the software engineering internship. In my Database Management Systems course the student consistently showed strong problem-solving skills and teamwork.\n\nSincerely', 26],
  ['announcement', 'Lab record submission deadline', null, null, 'CS-391 DBMS Lab, Batch A', 'Lab records for experiments 1–8 must be submitted by Monday 15:30. Late submissions will not be evaluated.', 2],
  ['email', 'Paper review submitted', ['pc.chair@conference.example.com'], null, '', 'Dear Programme Chair,\n\nI have submitted my review for paper #147 through the conference system. The main concern is the missing comparison with recent retrieval-augmented generation work.\n\nBest regards', 11],
  ['email', 'Guest lecture — thank you', ['guest.speaker@example.com'], ['hod.cse@example.com'], '', 'Dear Speaker,\n\nThank you for the insightful session on cloud databases. The students especially enjoyed the live demonstration. We look forward to hosting you again.\n\nWarm regards', 5],
  ['announcement', 'Machine Learning project topic registration', null, null, 'CS-411 Section C', 'Register your project team (3–4 members) and topic on the course page by Wednesday. Topics must include a dataset and an evaluation metric.', 18],
  ['email', 'Budget approval: lab consumables', ['accounts@example.com'], null, '', 'Dear Accounts Team,\n\nPlease find the request for lab consumables totalling ₹18,500 for the DBMS and Networks labs this semester. Itemised quotations are attached in the office file.\n\nThank you', 26],
  ['announcement', 'Attendance reminder', null, null, 'All sections taught by me', 'Students below 75 percent attendance must meet me during office hours this week.', 38],
  ['email', 'Follow-up: capstone review meeting', ['industry.mentor@example.com'], null, '', 'Hello,\n\nThank you for joining the capstone review. As discussed, the teams will share their revised architecture diagrams by next Friday.\n\nRegards', 5],
  ['email', '(no subject yet)', [], null, '', 'Draft started by voice — add details before sending.', 1],
]

const pad2 = n => String(n).padStart(2, '0')
const isWeekend = t => goWeekday(t) === 6 || goWeekday(t) === 0

export const methods = {
  // seed upserts the demo data. Times are relative to the service clock, so a
  // re-run moves future reminders forward instead of leaving them in the past.
  seed() {
    const now = this.now()
    const today = now.startOf('day')
    const ago = (days, hour) => Math.floor(today.minus({days}).plus({hours: hour}).toMillis() / 1000)
    const sum = {classes: 0, reminders: 0, notes: 0, memos: 0, drafts: 0}
    const db = this.db
    db.transaction(() => {
      const cls = db.prepare(`INSERT INTO classes(id, subject, course_code, section, room, weekday, start_min, end_min, timezone, effective_from, effective_to, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT (id) DO UPDATE SET subject=excluded.subject, course_code=excluded.course_code, section=excluded.section, room=excluded.room, weekday=excluded.weekday,
start_min=excluded.start_min, end_min=excluded.end_min, timezone=excluded.timezone, effective_from=excluded.effective_from, effective_to=excluded.effective_to,
active=excluded.active, updated_at=excluded.updated_at`)
      seedClasses.forEach(([subject, code, section, room, weekday, start, end, from, to, active], i) => {
        const created = ago(90, 9)
        cls.run(`cls_seed${pad2(i + 1)}`, subject, code, section, room, weekday, parseClock(start), parseClock(end), this.locName, from, to, active ? 1 : 0, created, created)
        sum.classes++
      })
      const rem = db.prepare(`INSERT INTO reminders(id, title, description, local_time, timezone, due_at, recurrence, status, delivery, fired_due, fired_at, completed_at, created_at, updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT (id) DO UPDATE SET title=excluded.title, description=excluded.description, local_time=excluded.local_time, timezone=excluded.timezone, due_at=excluded.due_at,
recurrence=excluded.recurrence, status=excluded.status, delivery=excluded.delivery, fired_due=excluded.fired_due, fired_at=excluded.fired_at, completed_at=excluded.completed_at, updated_at=excluded.updated_at`)
      seedReminders.forEach(([title, desc, dueDays, at, recurrence, completed, createdAgo], i) => {
        const day = today.plus({days: dueDays})
        const [hh, mm] = at.split(':').map(Number)
        let due = day.set({hour: hh, minute: mm, second: 0, millisecond: 0})
        if (recurrence !== 'none' && !(due > now)) due = nextOccurrence(due, recurrence, now)
        if (recurrence === 'weekdays' && isWeekend(due)) due = nextOccurrence(due, recurrence, due)
        let status = 'active'
        let delivery = 'pending'
        let completedAt = 0
        let firedDue = 0
        let firedAt = 0
        const dueSec = Math.floor(due.toMillis() / 1000)
        if (completed) {
          status = 'completed'
          delivery = 'notified'
          completedAt = dueSec + 7200
          firedDue = dueSec
          firedAt = dueSec
        } else if (!(due > now)) { // overdue: already announced once, so the scheduler does not fire it again
          delivery = 'overdue'
          firedDue = dueSec
          firedAt = dueSec
        }
        const created = ago(createdAgo, 10)
        rem.run(`rem_seed${pad2(i + 1)}`, title, desc, localLayout(due), this.locName, dueSec, recurrence, status, delivery, firedDue, firedAt, completedAt, created, created)
        sum.reminders++
      })
      const note = db.prepare(`INSERT INTO notes(id, title, body, tags, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
ON CONFLICT (id) DO UPDATE SET title=excluded.title, body=excluded.body, tags=excluded.tags, source=excluded.source, created_at=excluded.created_at, updated_at=excluded.updated_at`)
      seedNotes.forEach(([title, body, tags, source, createdAgo, updatedAgo], i) => {
        note.run(`note_seed${pad2(i + 1)}`, title, body, tags, source, ago(createdAgo, 11), ago(updatedAgo, 12))
        sum.notes++
      })
      const memo = db.prepare(`INSERT INTO memos(id, title, transcript, language, duration_ms, audio_file, audio_bytes, created_at, updated_at) VALUES (?,?,?,?,?,'',0,?,?)
ON CONFLICT (id) DO UPDATE SET title=excluded.title, transcript=excluded.transcript, language=excluded.language, duration_ms=excluded.duration_ms, created_at=excluded.created_at, updated_at=excluded.updated_at`)
      seedMemos.forEach(([title, transcript, language, seconds, createdAgo], i) => {
        const created = ago(createdAgo, 13)
        memo.run(`memo_seed${pad2(i + 1)}`, title, transcript, language, seconds * 1000, created, created)
        sum.memos++
      })
      const draft = db.prepare(`INSERT INTO drafts(id, kind, subject, recipients, audience, body, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
ON CONFLICT (id) DO UPDATE SET kind=excluded.kind, subject=excluded.subject, recipients=excluded.recipients, audience=excluded.audience, body=excluded.body, created_at=excluded.created_at, updated_at=excluded.updated_at`)
      seedDrafts.forEach(([kind, subject, to, cc, audience, body, createdAgo], i) => {
        const created = ago(createdAgo, 14)
        draft.run(`draft_seed${pad2(i + 1)}`, kind, subject, JSON.stringify(recipientsJSON({to, cc})), audience, body, created, created)
        sum.drafts++
      })
    })()
    this.sched.wake()
    return sum
  },
}
