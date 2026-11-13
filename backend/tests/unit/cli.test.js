// Command-line tools: devicectl, config-check and db (run as processes).
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync, spawnSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpDir} from '../helpers/env.js'
import {parseFlags} from '../../src/utils/flags.js'

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin')
const run = (tool, args, opts = {}) => spawnSync(process.execPath, [path.join(bin, tool), ...args], {encoding: 'utf8', ...opts})

test('flags accept Go syntax: -name value, --name=value, booleans, repeats, durations', () => {
  const {values} = parseFlags(['-url', 'wss://x', '--frame-ms=40', '-realtime=false', '--host', 'a', '-host', 'b', '-grace', '10m'],
    {url: {type: 'string'}, 'frame-ms': {type: 'int'}, realtime: {type: 'bool', default: true}, host: {type: 'list', default: []}, grace: {type: 'duration', default: 0}})
  assert.deepEqual(values, {url: 'wss://x', 'frame-ms': 40, realtime: false, host: ['a', 'b'], grace: 600000})
})

test('devicectl: init-ca, server-cert, add, list (no secrets), rotate, revoke', () => {
  const dir = tmpDir()
  const tls = path.join(dir, 'tls')
  const reg = path.join(dir, 'devices.json')
  assert.equal(run('devicectl.js', ['init-ca', '--tls-dir', tls]).status, 0)
  assert.equal(run('devicectl.js', ['init-ca', '--tls-dir', tls]).status, 1, 'refuses to overwrite a CA')
  assert.equal(run('devicectl.js', ['server-cert', '--tls-dir', tls]).status, 2, 'needs --host')
  assert.equal(run('devicectl.js', ['server-cert', '--tls-dir', tls, '--host', '127.0.0.1', '--host', 'aura.local']).status, 0)
  assert.equal(fs.statSync(path.join(tls, 'server.key')).mode & 0o777, 0o600)
  const out = run('devicectl.js', ['add', '--registry', reg, '--id', 'lab-esp32-01', '--name', 'Lab desk']).stdout
  const secret = /secret:\s+([0-9a-f]{64})/.exec(out)[1]
  const list = run('devicectl.js', ['list', '--registry', reg]).stdout
  assert.ok(list.includes('lab-esp32-01') && list.includes('active') && !list.includes(secret))
  assert.equal(run('devicectl.js', ['add', '--registry', reg, '--id', 'BAD ID']).status, 1)
  const rot = run('devicectl.js', ['rotate', '--registry', reg, '--id', 'lab-esp32-01', '--grace', '10m']).stdout
  assert.ok(rot.includes('keeps working for 10m0s'))
  assert.equal(run('devicectl.js', ['revoke', '--registry', reg, '--id', 'lab-esp32-01']).status, 0)
  assert.ok(run('devicectl.js', ['list', '--registry', reg]).stdout.includes('revoked'))
  const verify = spawnSync('openssl', ['verify', '-CAfile', path.join(tls, 'ca.crt'), path.join(tls, 'server.crt')], {encoding: 'utf8'})
  if (verify.status !== null) assert.ok(verify.stdout.includes('OK'))
})

test('config-check reports problems without printing secrets', () => {
  const dir = tmpDir()
  const env = path.join(dir, '.env')
  fs.writeFileSync(env, 'GEMINI_API_KEY=super-secret-value-123\nVOICE_STT_TIMEOUT=abc\nPIPER_EN_URL=http://localhost:5000\nTYPO_KEY=1\n')
  const r = run('config-check.js', ['-env', env], {cwd: dir})
  assert.equal(r.status, 1)
  assert.ok(!r.stdout.includes('super-secret-value-123'))
  assert.ok(r.stdout.includes('| `GEMINI_API_KEY` | Configured'))
  assert.ok(r.stdout.includes('Invalid: not a duration such as 30s'))
  assert.ok(r.stdout.includes('use 127.0.0.1, not localhost'))
  assert.ok(r.stdout.includes('Unknown keys') && r.stdout.includes('TYPO_KEY'))
  assert.equal(run('config-check.js', ['-env', path.join(dir, 'missing')]).status, 1)
})

test('db: seed demo, counts, check, unseed keeps own rows, production guard, reset backs up', () => {
  const dir = tmpDir()
  const env = {...process.env, DEMO_DATA_PATH: path.join(dir, 'demo'), PROFESSOR_DATA_PATH: path.join(dir, 'app', 'professor'), RAG_STORAGE_PATH: path.join(dir, 'app', 'rag'), APP_ENV: 'development'}
  const db = (...a) => run('db.js', [...a, '--env', path.join(dir, 'none')], {cwd: dir, env})
  let r = db('seed')
  assert.equal(r.status, 0, r.stderr)
  assert.ok(r.stdout.includes('classes 16 reminders 26 notes 25 memos 12 drafts 14'))
  assert.ok(r.stdout.includes('Demo documents: 4 added'))
  assert.ok(db('seed').stdout.includes('4 already present'), 'idempotent')
  r = db('check')
  assert.ok(r.stdout.includes('demo professor database      OK'), r.stdout)
  assert.ok(db('counts').stdout.includes('classes'))
  assert.equal(run('db.js', ['seed', '--env', path.join(dir, 'none')], {cwd: dir, env: {...env, APP_ENV: 'production'}}).status, 1)
  assert.equal(db('reset', '--target', 'app').status, 1, 'reset never touches the app database')
  r = db('reset')
  assert.equal(r.status, 0, r.stderr)
  assert.ok(r.stdout.includes('Backed up the previous demo databases'))
  assert.equal(fs.readdirSync(path.join(dir, 'demo-backups')).length, 1)
  r = db('unseed')
  assert.ok(/Removed \d+ demo rows/.test(r.stdout))
  void execFileSync
})
