// Request body schemas (Zod), mirroring the Go request structs. As with Go's
// encoding/json, a JSON null leaves a field at its zero value, and optional
// ("pointer") fields distinguish absent/null (unchanged) from a value.
import {z} from 'zod'

const str = z.string().nullable().optional().transform(v => v ?? '')
const optStr = z.string().nullable().optional().transform(v => v ?? undefined)
const optBool = z.boolean().nullable().optional().transform(v => v ?? undefined)
const int = z.number().int().nullable().optional().transform(v => v ?? 0)
const strList = z.array(z.string().nullable().transform(v => v ?? '')).nullable().optional().transform(v => v ?? null)

export const ClassBody = z.object({
  subject: str, course_code: str, section: str, room: str,
  weekday: z.any().optional(), // 1-7 or a day name
  start: str, end: str, timezone: str, effective_from: str, effective_to: str,
  active: optBool,
}).strict()

export const ReminderInput = z.object({title: str, description: str, due: str, recurrence: str}).strict()

export const ReminderPatch = z.object({title: optStr, description: optStr, due: optStr, recurrence: optStr, completed: optBool}).strict()

export const NoteInput = z.object({title: str, body: str, tags: strList}).strict()

export const NotePatch = z.object({title: optStr, body: optStr, append: optStr, tags: z.array(z.string().nullable().transform(v => v ?? '')).nullable().optional().transform(v => v ?? undefined)}).strict()

export const MemoBody = z.object({title: str, transcript: str, language: str, duration_ms: int, audio_id: str}).strict()

export const MemoPatch = z.object({title: optStr, transcript: optStr}).strict()

export const DraftInput = z.object({kind: str, subject: str, body: str, audience: str, to: strList, cc: strList, bcc: strList}).strict()
