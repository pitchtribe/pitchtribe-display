'use strict';
/* HTTPS for the dashboard, using a certificate the Pi makes for itself.

   A club's Pi is reached at http://<name>.local on the club's own network. No
   public certificate authority will ever issue a certificate for a .local name
   or a 192.168.x.x address, so a self-signed one is the only kind this device
   can have, and browsers will say so: "Not private", one click to continue.
   What it does buy is encryption — the admin password and the session cookie
   stop crossing the club's Wi-Fi in the clear — and a fingerprint the dashboard
   shows you, so the warning can be checked rather than merely clicked through.

   The key is generated on the Pi, on first start, into DATA_DIR. It is never
   built into the SD card image: the image build never starts the server (see
   IMAGE_BUILD in deploy/install.sh), so every card ends up with its own key
   rather than one shared by every club.

   The certificate names the Pi (<host>.local, <host>, localhost) and not its
   LAN address, which DHCP can change: re-issuing on every address change would
   churn the fingerprint, and the fingerprint is the only thing that makes the
   browser warning checkable. Reaching the dashboard by IP adds a name mismatch
   to a warning that was there anyway. */
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* Apple and Chrome reject *publicly trusted* certificates valid for more than
   398 days. This one is not publicly trusted, so the rule does not apply, but
   staying inside it costs nothing and avoids relying on that distinction. */
const DAYS = 395;
const RENEW_WITHIN_MS = 30 * 86400 * 1000;

/** The names a Pi answers to. The first is the one people type. */
function certNames(hostname = os.hostname()) {
  const host = String(hostname || '').split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '') || 'pitchtribe';
  return [`${host}.local`, host, 'localhost'];
}

function certPaths(dataDir) {
  const dir = path.join(dataDir, 'tls');
  return { dir, certFile: path.join(dir, 'cert.pem'), keyFile: path.join(dir, 'key.pem') };
}

/** The eight characters a volunteer can realistically compare on a phone. */
const shortFingerprint = (fp) => String(fp || '').split(':').slice(0, 4).join(':');

function describe(certPem) {
  const x = new crypto.X509Certificate(certPem);
  return {
    fingerprint: x.fingerprint256,
    notAfter: (x.validToDate || new Date(x.validTo)).toISOString(),
    names: String(x.subjectAltName || '')
      .split(',')
      .map((s) => s.trim().replace(/^DNS:/, '').replace(/^IP Address:/, ''))
      .filter(Boolean),
  };
}

/** Why an existing certificate has to be replaced, or '' to keep it. */
function renewalReason(info, hostname = os.hostname(), now = Date.now()) {
  const want = certNames(hostname)[0];
  if (Date.parse(info.notAfter) - now < RENEW_WITHIN_MS) return 'it is about to expire';
  if (!info.names.includes(want)) return `this Pi is called ${want} now`;
  return '';
}

function generate({ dataDir, hostname = os.hostname(), exec = childProcess.execFileSync } = {}) {
  const { dir, certFile, keyFile } = certPaths(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const names = certNames(hostname);
  const san = [...names.map((n) => `DNS:${n}`), 'IP:127.0.0.1', 'IP:::1'].join(',');
  const tmpCert = `${certFile}.${process.pid}.tmp`;
  const tmpKey = `${keyFile}.${process.pid}.tmp`;
  try {
    // P-256 rather than RSA: a Pi generates it instantly and every browser
    // since 2014 accepts it. -nodes leaves the key unencrypted, which it has
    // to be — nobody is at the Pi to type a passphrase when it reboots.
    exec('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-days', String(DAYS),
      '-subj', `/CN=${names[0]}`,
      '-addext', `subjectAltName=${san}`,
      '-addext', 'basicConstraints=critical,CA:FALSE',
      '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
      '-addext', 'extendedKeyUsage=serverAuth',
      '-keyout', tmpKey, '-out', tmpCert,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    fs.chmodSync(tmpKey, 0o600);
    fs.renameSync(tmpCert, certFile);
    fs.renameSync(tmpKey, keyFile);
  } finally {
    for (const f of [tmpCert, tmpKey]) fs.rmSync(f, { force: true });
  }
  return { certFile, keyFile };
}

/**
 * Load the Pi's certificate, making or replacing it when needed.
 * Returns null when no certificate could be made — HTTPS is then simply off,
 * and the dashboard carries on serving HTTP. A missing certificate must never
 * stop a club's screens.
 */
function ensure({ dataDir, hostname = os.hostname(), log = () => {}, exec } = {}) {
  const { certFile, keyFile } = certPaths(dataDir);
  let reason = '';
  try {
    const cert = fs.readFileSync(certFile);
    const key = fs.readFileSync(keyFile);
    const info = describe(cert);
    reason = renewalReason(info, hostname);
    if (!reason) return { ...info, cert, key };
  } catch (err) {
    reason = err.code === 'ENOENT' ? 'first start' : `the old one could not be read (${err.message})`;
  }
  try {
    generate({ dataDir, hostname, exec });
    const cert = fs.readFileSync(certFile);
    const key = fs.readFileSync(keyFile);
    const info = describe(cert);
    log(`[tls] new certificate for ${info.names[0]} (${reason}) — fingerprint ${shortFingerprint(info.fingerprint)}`);
    return { ...info, cert, key };
  } catch (err) {
    log(`[tls] HTTPS off: could not make a certificate (${err.message}). The dashboard stays on HTTP.`);
    return null;
  }
}

module.exports = { DAYS, RENEW_WITHIN_MS, certNames, certPaths, describe, ensure, generate, renewalReason, shortFingerprint };
