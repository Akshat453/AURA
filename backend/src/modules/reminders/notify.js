// macOS notifications for due reminders (REMINDER_MACOS_NOTIFICATIONS=true).
// The title and text are passed as arguments, never interpolated into the
// AppleScript source, so reminder text cannot inject script code.
import {execFile} from 'node:child_process'
import {excerpt} from '../professor/say.js'

export function macNotify(title, text) {
  if (process.platform !== 'darwin') return Promise.reject(new Error('macOS notifications are only available on macOS'))
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, excerpt(text, 200)],
      {timeout: 5000}, err => (err ? reject(err) : resolve()))
  })
}
