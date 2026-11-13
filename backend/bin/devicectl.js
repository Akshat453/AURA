#!/usr/bin/env node
// devicectl manages ESP32 device access: the local CA and server certificate
// for the device TLS listener, and per-device credentials.
//
//   devicectl init-ca
//   devicectl server-cert --host 192.168.1.20 --host voice-assistant.local
//   devicectl add --id lab-esp32-01 --name "Lab desk"      # prints the secret once
//   devicectl rotate --id lab-esp32-01 [--grace 10m]
//   devicectl revoke --id lab-esp32-01
//   devicectl list
import os from 'node:os'
import path from 'node:path'
import {parseFlags} from '../src/utils/flags.js'
import {formatDuration} from '../src/utils/goparse.js'
import {CAFile, CAKeyFile, generateCA, issueServerCert} from '../src/security/certificates.js'
import {Registry} from '../src/modules/device/registry.js'

const env = (k, d) => process.env[k] || d

function usage() {
  process.stderr.write('usage: devicectl init-ca | server-cert --host IP|NAME ... | add --id ID [--name N] | rotate --id ID [--grace D] | revoke --id ID | list\n')
  process.exit(2)
}

function check(fn) {
  try {
    return fn()
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`)
    process.exit(1)
  }
}

async function checkAsync(p) {
  try {
    return await p
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`)
    process.exit(1)
  }
}

function printSecret(id, secret) {
  process.stdout.write(`device id: ${id}\nsecret:    ${secret}\n\nStore the secret in the device's encrypted NVS (it is shown only once; it is\nnot a Gemini key or any cloud credential). Anyone with it can act as this device.\n`)
}

// lanAddresses suggests this machine's private IPv4 addresses.
function lanAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push(a.address)
    }
  }
  return [...out, 'voice-assistant.local']
}

async function main() {
  if (process.argv.length < 3) usage()
  const cmd = process.argv[2]
  const {values: f} = parseFlags(process.argv.slice(3), {
    'tls-dir': {type: 'string', default: env('DEVICE_TLS_DIR', 'data/device-tls'), usage: 'device TLS directory'},
    registry: {type: 'string', default: env('DEVICE_REGISTRY', 'data/devices.json'), usage: 'device credential file'},
    id: {type: 'string', default: '', usage: 'device id (3-48 lower-case letters, digits, hyphens)'},
    name: {type: 'string', default: '', usage: 'human-readable device name'},
    grace: {type: 'duration', default: 0, usage: 'rotate: keep accepting the old secret for this long'},
    validity: {type: 'duration', default: 365 * 24 * 3600 * 1000, usage: 'server-cert: certificate validity'},
    host: {type: 'list', default: [], usage: 'server-cert: LAN IP or DNS name devices use to reach this machine (repeatable)'},
  }, cmd)
  switch (cmd) {
    case 'init-ca':
      await checkAsync(generateCA(f['tls-dir'], 'Professor Voice Assistant local CA'))
      process.stdout.write(`CA created: ${path.join(f['tls-dir'], CAFile)} (embed this certificate in the device firmware)\nCA key:     ${path.join(f['tls-dir'], CAKeyFile)} (keep private; never copy it to a device)\n`)
      return
    case 'server-cert':
      if (f.host.length === 0) {
        process.stderr.write("suggested --host values (this machine's LAN addresses):\n")
        for (const a of lanAddresses()) process.stderr.write(`  --host ${a}\n`)
        process.exit(2)
      }
      await checkAsync(issueServerCert(f['tls-dir'], f.host, f.validity))
      process.stdout.write(`server certificate for ${f.host.join(',')} written to ${f['tls-dir']} (valid ${formatDuration(f.validity)})\n`)
      return
    case 'add':
    case 'rotate':
    case 'revoke':
    case 'list': {
      const reg = check(() => Registry.open(f.registry))
      if (cmd === 'add') {
        printSecret(f.id, check(() => reg.add(f.id, f.name)))
      } else if (cmd === 'rotate') {
        printSecret(f.id, check(() => reg.rotate(f.id, f.grace)))
        process.stdout.write(f.grace > 0 ? `the previous secret keeps working for ${formatDuration(f.grace)}\n` : 'the previous secret no longer works\n')
      } else if (cmd === 'revoke') {
        check(() => reg.revoke(f.id))
        process.stdout.write(`${f.id} revoked; a connected session is closed at its next heartbeat\n`)
      } else {
        for (const c of check(() => reg.list())) {
          process.stdout.write(`${c.id.padEnd(24)} ${(c.revoked ? 'revoked' : 'active').padEnd(8)} created ${String(c.created_at).slice(0, 10)}  ${c.name ?? ''}\n`)
        }
      }
      return
    }
    default:
      usage()
  }
}

main()
