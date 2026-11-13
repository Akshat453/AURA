// Device authentication, revocation, TLS verification and origin checks.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import {speechLikePCM} from '../../src/utils/audio.js'
import {Context} from '../../src/utils/context.js'
import {caPEM, generateCA, CAFile} from '../../src/security/certificates.js'
import {DeviceClient} from '../../src/modules/device/client.js'
import {mac, newNonce} from '../../src/security/hmac.js'
import {Registry} from '../../src/modules/device/registry.js'
import {newDeviceEnv, tmpDir, turn} from '../helpers/env.js'

const refused = async (p, what) => {
  await assert.rejects(p, e => {
    assert.ok(/authentication failed/.test(e.message), `${what}: ${e.message}`)
    return true
  })
}

test('only the right secret for a known, active device authenticates', async t => {
  const env = await newDeviceEnv(t)
  ;(await env.dial('desk-esp32')).close()
  await refused(DeviceClient.dial({url: env.url, deviceId: 'lab-esp32', secret: env.secrets['desk-esp32'], ca: env.ca}), 'wrong secret')
  await refused(DeviceClient.dial({url: env.url, deviceId: 'desk-esp32-copy', secret: env.secrets['desk-esp32'], ca: env.ca}), 'unknown device')
  env.reg.revoke('lab-esp32')
  await refused(env.dial('lab-esp32'), 'revoked device')
})

test('the shared refusal takes at least 300 ms (slows down guessing)', async t => {
  const env = await newDeviceEnv(t)
  const start = Date.now()
  await refused(DeviceClient.dial({url: env.url, deviceId: 'lab-esp32', secret: 'ab'.repeat(32), ca: env.ca}), 'guess')
  assert.ok(Date.now() - start >= 300)
})

test('a recorded handshake cannot be replayed (fresh nonce per connection)', async t => {
  const env = await newDeviceEnv(t)
  // Record a valid hello for one challenge…
  const ws1 = new WebSocket(env.url, {ca: env.ca})
  const nonce1 = await new Promise(r => ws1.once('message', d => r(JSON.parse(d).nonce)))
  const recorded = {type: 'hello', v: 1, device_id: 'desk-esp32', mac: mac(env.secrets['desk-esp32'], 'desk-esp32', nonce1), codecs: [{format: 'pcm_s16le', sample_rate: 16000, channels: 1}], playback_buffer_ms: 500}
  ws1.terminate()
  // …and replay it on a new connection: the server's nonce differs.
  const ws2 = new WebSocket(env.url, {ca: env.ca})
  const nonce2 = await new Promise(r => ws2.once('message', d => r(JSON.parse(d).nonce)))
  assert.notEqual(nonce1, nonce2)
  assert.match(nonce2, /^[0-9a-f]{64}$/)
  ws2.send(JSON.stringify(recorded))
  const reply = await new Promise(r => ws2.once('message', d => r(JSON.parse(d))))
  const code = await new Promise(r => ws2.once('close', c => r(c)))
  assert.equal(reply.code, 'unauthorized')
  assert.equal(code, 1008)
})

test('the device secret never crosses the network', async t => {
  const env = await newDeviceEnv(t)
  const seen = []
  const c = await env.mustDial('desk-esp32')
  const orig = c.ws.send.bind(c.ws)
  c.ws.send = (data, ...rest) => {
    seen.push(Buffer.from(data).toString('latin1'))
    return orig(data, ...rest)
  }
  await turn(c, {turn: 1, pcm: speechLikePCM(16000, 0.4, 0.3)})
  assert.ok(!seen.some(s => s.includes(env.secrets['desk-esp32'])))
})

test('a device revoked while connected is dropped at its next heartbeat (1008)', async t => {
  const env = await newDeviceEnv(t, c => (c.deviceHeartbeat = 100))
  const revoked = await env.mustDial('lab-esp32')
  const kept = await env.mustDial('desk-esp32')
  env.reg.revoke('lab-esp32')
  const [ctx, cancel] = Context.background().withTimeout(3000)
  const err = await revoked.waitClosed(ctx)
  cancel()
  assert.equal(err.code, 1008)
  const res = await turn(kept, {turn: 1, pcm: speechLikePCM(16000, 0.6, 0.3), language: 'en'})
  assert.ok(res.complete, 'other devices keep working')
})

test('TLS verification: untrusted CA, system roots and wrong host name all fail; DNS SAN verifies', async t => {
  const env = await newDeviceEnv(t)
  const otherDir = tmpDir()
  await generateCA(otherDir, 'other')
  const other = caPEM(path.join(otherDir, CAFile))
  const base = {url: env.url, deviceId: 'desk-esp32', secret: env.secrets['desk-esp32']}
  for (const [name, cfg] of [['untrusted CA', {...base, ca: other}], ['system roots only', {...base}], ['host name mismatch', {...base, ca: env.ca, serverName: 'attacker.local'}]]) {
    await assert.rejects(DeviceClient.dial(cfg), e => /certificate|altnames|self.signed|issuer/i.test(e.message) || assert.fail(`${name}: ${e.message}`))
  }
  const ok = await DeviceClient.dial({...base, ca: env.ca, serverName: 'voice-assistant.local'})
  ok.closeNow()
  // A plain (non-TLS) client cannot even reach the WebSocket.
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(env.url.replace('wss://', 'ws://'))
    ws.once('open', resolve)
    ws.once('error', reject)
  }))
})

test('browsers (any Origin header) are refused on /device with 403, even same-host', async t => {
  const env = await newDeviceEnv(t)
  for (const origin of ['https://evil.example', `https://127.0.0.1:${env.port}`]) {
    const status = await new Promise(resolve => {
      const ws = new WebSocket(env.url, {ca: env.ca, headers: {Origin: origin}})
      ws.once('unexpected-response', (req, res) => {
        res.resume()
        resolve(res.statusCode)
      })
      ws.once('open', () => resolve(101))
      ws.once('error', () => resolve(0))
    })
    assert.equal(status, 403, origin)
  }
})

test('handshake limits: hello timeout closes, non-JSON hello is bad_hello', async t => {
  const env = await newDeviceEnv(t, c => (c.deviceHelloTimeout = 200))
  const ws = new WebSocket(env.url, {ca: env.ca})
  await new Promise(r => ws.once('message', r)) // challenge, then silence
  const start = Date.now()
  await new Promise(r => ws.once('close', r))
  assert.ok(Date.now() - start < 2000)
  const ws2 = new WebSocket(env.url, {ca: env.ca})
  await new Promise(r => ws2.once('message', r))
  ws2.send('not json')
  const reply = await new Promise(r => ws2.once('message', d => r(JSON.parse(d))))
  assert.equal(reply.code, 'bad_hello')
  ws2.send(Buffer.alloc(10), {binary: true})
})

test('connection limit answers busy (1013)', async t => {
  const env = await newDeviceEnv(t, c => (c.deviceMaxConnections = 1))
  await env.mustDial('desk-esp32')
  await assert.rejects(env.dial('lab-esp32'), /busy|too many devices/)
})

test('registry: rotation grace, revocation seen by a second instance, no secrets listed, permissions enforced', async () => {
  const file = path.join(tmpDir(), 'devices.json')
  const r = Registry.open(file)
  const secret = r.add('lab-esp32-01', 'Lab desk')
  assert.match(secret, /^[0-9a-f]{64}$/)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const nonce = newNonce()
  const m = mac(secret, 'lab-esp32-01', nonce)
  r.verify('lab-esp32-01', nonce, m)
  assert.throws(() => r.verify('lab-esp32-01', newNonce(), m), /authentication failed/)
  assert.throws(() => r.verify('lab-esp32-01', nonce, mac('ab'.repeat(32), 'lab-esp32-01', nonce)), /authentication failed/)
  assert.throws(() => r.verify('other-device', nonce, m), /unknown device/)
  assert.throws(() => r.verify('lab-esp32-01', nonce, 'zz' + m.slice(2)), /authentication failed/, 'invalid hex')
  let clock = Date.now()
  r.now = () => clock
  const fresh = r.rotate('lab-esp32-01', 60000)
  r.verify('lab-esp32-01', nonce, mac(fresh, 'lab-esp32-01', nonce))
  r.verify('lab-esp32-01', nonce, m) // old secret during grace
  clock += 120000
  assert.throws(() => r.verify('lab-esp32-01', nonce, m), /authentication failed/)
  const server = Registry.open(file)
  r.revoke('lab-esp32-01')
  assert.throws(() => server.verify('lab-esp32-01', nonce, mac(fresh, 'lab-esp32-01', nonce)), /revoked/)
  assert.equal(server.active('lab-esp32-01'), false)
  const list = r.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].secret, '')
  fs.chmodSync(file, 0o644)
  assert.throws(() => Registry.open(file), /readable by other users/)
})

test('the existing Go-written registry format is read unchanged', async () => {
  const file = path.join(tmpDir(), 'devices.json')
  const secret = 'ab'.repeat(32)
  fs.writeFileSync(file, JSON.stringify([{id: 'aura-esp32-01', name: 'AURA desk', secret, created_at: '2026-11-01T16:04:34.085465Z'}], null, 2) + '\n', {mode: 0o600})
  const r = Registry.open(file)
  const nonce = newNonce()
  assert.equal(r.verify('aura-esp32-01', nonce, mac(secret, 'aura-esp32-01', nonce)).id, 'aura-esp32-01')
  assert.equal(r.list()[0].created_at, '2026-11-01T16:04:34.085465Z')
})
