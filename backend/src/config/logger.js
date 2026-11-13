// Structured JSON logging (pino). Logs carry ids, sizes and timings only:
// never secrets, MACs, audio, transcripts, document text or note titles.
import pino from 'pino'

export function createLogger(opts = {}) {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    base: undefined,
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {level: label => ({level: label.toUpperCase()})},
    // Defense in depth: never log credential-like fields even if passed.
    redact: {paths: ['secret', 'mac', 'key', 'token', 'access_token', 'refresh_token', 'apiKey', '*.secret', '*.token'], censor: '[redacted]'},
    ...opts,
  })
}

// silentLogger is used by tests.
export const silentLogger = () => pino({level: 'silent'})
