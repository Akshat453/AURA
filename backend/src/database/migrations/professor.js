// Professor database migrations, applied in order. The applied count is kept
// in PRAGMA user_version, so adding a migration never rewrites existing data
// and a database created by the Go backend (user_version 1) is used as is.
//
// To add a schema change, append a new migration string (never edit an
// existing one) and, for reversibility, document its inverse in `down`.
export const migrations = [
  `
CREATE TABLE classes (
  id TEXT PRIMARY KEY, subject TEXT NOT NULL, course_code TEXT NOT NULL DEFAULT '', section TEXT NOT NULL DEFAULT '',
  room TEXT NOT NULL DEFAULT '', weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439), end_min INTEGER NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  timezone TEXT NOT NULL, effective_from TEXT NOT NULL DEFAULT '', effective_to TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK (end_min > start_min)
);
CREATE INDEX classes_weekday ON classes(weekday, start_min);
CREATE TABLE reminders (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  local_time TEXT NOT NULL, timezone TEXT NOT NULL, due_at INTEGER NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','daily','weekdays','weekly')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  delivery TEXT NOT NULL DEFAULT 'pending' CHECK (delivery IN ('pending','notified','overdue')),
  fired_due INTEGER NOT NULL DEFAULT 0, fired_at INTEGER NOT NULL DEFAULT 0, completed_at INTEGER NOT NULL DEFAULT 0,
  action_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX reminders_due ON reminders(status, due_at);
CREATE TABLE notes (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'typed', action_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX notes_updated ON notes(updated_at);
CREATE TABLE memos (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, transcript TEXT NOT NULL, language TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0, audio_file TEXT NOT NULL DEFAULT '', audio_bytes INTEGER NOT NULL DEFAULT 0,
  action_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE drafts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('email','announcement')), subject TEXT NOT NULL,
  recipients TEXT NOT NULL DEFAULT '{}', audience TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
  gmail_draft_id TEXT NOT NULL DEFAULT '', action_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);`,
]

// down lists, per migration, the statements that reverse it (for manual
// rollback during development; never run automatically on user data).
export const down = ['DROP TABLE drafts; DROP TABLE memos; DROP TABLE notes; DROP TABLE reminders; DROP TABLE classes;']

// migrate applies pending migrations, each in its own transaction.
export function migrate(db) {
  const version = db.pragma('user_version', {simple: true})
  for (let i = version; i < migrations.length; i++) {
    try {
      db.transaction(() => {
        db.exec(migrations[i])
        db.pragma(`user_version = ${i + 1}`)
      })()
    } catch (e) {
      throw new Error(`migration ${i + 1}: ${e.message}`, {cause: e})
    }
  }
}
