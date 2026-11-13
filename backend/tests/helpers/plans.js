// Scripted model plans shared by tests.
export const tomorrow10 = '2026-10-22T10:00'

export function reminderPlan(prompt) {
  if (prompt.includes('Remind me')) return [[{name: 'create_reminder', args: {title: 'Submit attendance', due: tomorrow10}}], '']
  if (prompt.includes('next lecture')) return [[], 'Yes, done! I created it.'] // the model claiming success must not change anything
  return [[], 'Sure.']
}

