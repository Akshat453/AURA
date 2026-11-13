// Local TLS for the device listener: a private CA whose certificate is
// embedded in device firmware, and a server certificate for this machine's
// LAN address(es). Devices verify the chain and the host name/IP; nothing here
// relies on disabling certificate verification. File names, key formats
// (SEC1 "EC PRIVATE KEY", P-256) and permissions match the Go tooling, so
// existing certificates and provisioned firmware keep working.
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import 'reflect-metadata'
import * as x509 from '@peculiar/x509'
import {tooOpen} from './permissions.js'

x509.cryptoProvider.set(crypto.webcrypto)

export const CAFile = 'ca.crt'
export const CAKeyFile = 'ca.key'
export const ServerCertFile = 'server.crt'
export const ServerKeyFile = 'server.key'

const alg = {name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256'}

// serial is a random positive 127-bit serial number (hex), like the Go tool.
function serial() {
  const b = crypto.randomBytes(16)
  b[0] &= 0x7f
  if (b[0] === 0) b[0] = 0x01
  return b.toString('hex')
}

function writeKey(file, privateKey) {
  const pem = crypto.KeyObject.from(privateKey).export({type: 'sec1', format: 'pem'})
  fs.writeFileSync(file, pem, {mode: 0o600})
  fs.chmodSync(file, 0o600)
}

function writeCert(file, cert) {
  fs.writeFileSync(file, cert.toString('pem') + '\n', {mode: 0o644})
}

const addYears = (d, n) => {
  const x = new Date(d)
  x.setUTCFullYear(x.getUTCFullYear() + n)
  return x
}

// generateCA creates a P-256 CA valid for 10 years. It refuses to overwrite an
// existing CA, which would invalidate every provisioned device.
export async function generateCA(dir, name) {
  if (fs.existsSync(path.join(dir, CAKeyFile))) throw new Error('a CA already exists in ' + dir)
  fs.mkdirSync(dir, {recursive: true, mode: 0o700})
  const keys = await crypto.webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])
  const now = Date.now()
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: [{O: ['Professor Voice Assistant (local)']}, {CN: [name]}],
    notBefore: new Date(now - 3600_000),
    notAfter: addYears(now, 10),
    keys,
    signingAlgorithm: alg,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  })
  writeKey(path.join(dir, CAKeyFile), keys.privateKey)
  writeCert(path.join(dir, CAFile), cert)
}

function loadCA(dir) {
  let certPEM
  try {
    certPEM = fs.readFileSync(path.join(dir, CAFile), 'utf8')
  } catch (e) {
    throw new Error(`no CA in ${dir} (run devicectl init-ca): ${e.message}`, {cause: e})
  }
  const keyPEM = fs.readFileSync(path.join(dir, CAKeyFile), 'utf8')
  let cert
  let key
  try {
    cert = new x509.X509Certificate(certPEM)
    key = crypto.createPrivateKey(keyPEM)
  } catch {
    throw new Error('invalid CA PEM files')
  }
  return {cert, key}
}

// issueServerCert signs a server certificate for the given IP addresses and
// DNS names (for example the LAN IP and the mDNS name). validityMs: lifetime.
export async function issueServerCert(dir, hosts, validityMs) {
  if (!hosts?.length) throw new Error('at least one --host (LAN IP or DNS name) is required')
  const ca = loadCA(dir)
  const caKey = await ca.key.toCryptoKey(alg, false, ['sign'])
  const keys = await crypto.webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])
  const names = hosts.map(h => (net.isIP(h) ? {type: 'ip', value: h} : {type: 'dns', value: h}))
  const now = Date.now()
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: [{CN: [hosts[0]]}],
    issuer: ca.cert.subjectName,
    notBefore: new Date(now - 3600_000),
    notAfter: new Date(now + validityMs),
    publicKey: keys.publicKey,
    signingKey: caKey,
    signingAlgorithm: alg,
    extensions: [
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension(names),
      await x509.AuthorityKeyIdentifierExtension.create(ca.cert.publicKey),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  })
  writeKey(path.join(dir, ServerKeyFile), keys.privateKey)
  writeCert(path.join(dir, ServerCertFile), cert)
}

// serverTLSOptions loads the device listener certificate. TLS 1.2 is the
// minimum (ESP-IDF's mbedTLS supports 1.2 and 1.3).
export function serverTLSOptions(dir) {
  let cert
  let key
  try {
    cert = fs.readFileSync(path.join(dir, ServerCertFile))
    key = fs.readFileSync(path.join(dir, ServerKeyFile))
    crypto.createPrivateKey(key)
  } catch (e) {
    throw new Error(`device TLS certificate (run devicectl server-cert): ${e.message}`, {cause: e})
  }
  try {
    if (tooOpen(fs.statSync(path.join(dir, ServerKeyFile)))) throw new Error('server.key is readable by other users; run chmod 600')
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  return {cert, key, minVersion: 'TLSv1.2'}
}

// caPEM loads the CA certificate a device (or the simulator) trusts.
export function caPEM(caFile) {
  const b = fs.readFileSync(caFile, 'utf8')
  if (!b.includes('-----BEGIN CERTIFICATE-----')) throw new Error('no certificates in ' + caFile)
  return b
}
