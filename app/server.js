#!/usr/bin/env node
'use strict';
/* PitchTribe signage server: dashboard at /admin, screens at /player. */
const https = require('node:https');
const path = require('node:path');
const { createApp } = require('./lib/app');
const tls = require('./lib/tls');
const pkg = require('./package.json');

const port = Number(process.env.PORT || 8080);
const httpsPort = Number(process.env.HTTPS_PORT || 0);
const host = process.env.HOST || '0.0.0.0';
// Resolved here as well as in createApp, because the certificate has to exist
// before the app is built — it reports the fingerprint to the dashboard.
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));

// HTTPS is extra, never a condition of starting: if the certificate cannot be
// made, tlsInfo is null and the club still gets its dashboard over HTTP.
const cert = httpsPort ? tls.ensure({ dataDir, log: console.error }) : null;
const tlsInfo = cert ? { port: httpsPort, active: true, fingerprint: cert.fingerprint, notAfter: cert.notAfter, names: cert.names } : null;

const { app, close } = createApp({ port, dataDir, tls: tlsInfo });

const server = app.listen(port, host, () => {
  console.log(`PitchTribe ${pkg.version} listening on http://${host}:${port}`);
  console.log(`  Dashboard: http://localhost:${port}/admin/`);
  console.log(`  Screen:    http://localhost:${port}/player/?screen=lounge-tv`);
  console.log(`  Data:      ${dataDir}`);
});
// Long-lived SSE connections and large video uploads must not time out.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

let secure = null;
if (cert) {
  secure = https.createServer({ cert: cert.cert, key: cert.key }, app);
  secure.requestTimeout = 0;
  secure.headersTimeout = 60_000;
  // Port 443 in use, or no CAP_NET_BIND_SERVICE: say so and carry on. Without
  // this handler the error would be thrown and take the dashboard down with it.
  secure.on('error', (err) => {
    tlsInfo.active = false;
    console.error(`HTTPS off on port ${httpsPort}: ${err.message}. The dashboard stays on HTTP.`);
  });
  secure.listen(httpsPort, host, () => {
    console.log(`  Secure:    https://localhost${httpsPort === 443 ? '' : `:${httpsPort}`}/admin/`);
    console.log(`  Cert:      ${tls.shortFingerprint(cert.fingerprint)} (self-signed, expires ${cert.notAfter.slice(0, 10)})`);
  });

  // A Pi that is never rebooted would otherwise serve an expired certificate,
  // which browsers treat far more harshly than an untrusted one. Swap it in
  // place rather than asking for a restart.
  const renewal = setInterval(() => {
    const next = tls.ensure({ dataDir, log: console.error });
    if (!next || next.fingerprint === tlsInfo.fingerprint) return;
    try {
      secure.setSecureContext({ cert: next.cert, key: next.key });
      Object.assign(tlsInfo, { fingerprint: next.fingerprint, notAfter: next.notAfter, names: next.names });
      console.log(`HTTPS certificate replaced — fingerprint ${tls.shortFingerprint(next.fingerprint)}`);
    } catch (err) {
      console.error(`HTTPS certificate not replaced: ${err.message}`);
    }
  }, 24 * 3600 * 1000);
  renewal.unref();
}

function shutdown() {
  close();
  if (secure) secure.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
