'use strict';
/* HTTPS with the Pi's own certificate, and the opt-in redirect to it. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const tls = require('../lib/tls');
const { createApp } = require('../lib/app');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pitchtribe-tls-'));

test('the certificate is named after the Pi, not its address', () => {
  assert.deepEqual(tls.certNames('lounge-tv'), ['lounge-tv.local', 'lounge-tv', 'localhost']);
  // A fully qualified or shouty hostname still gives one usable .local name.
  assert.equal(tls.certNames('Lounge-TV.lan')[0], 'lounge-tv.local');
  // Never an empty name: openssl would refuse the subject.
  assert.equal(tls.certNames('')[0], 'pitchtribe.local');
  assert.equal(tls.certNames('!!!')[0], 'pitchtribe.local');
});

test('a certificate is kept until it is stale, then replaced', () => {
  const day = 86400 * 1000;
  const fresh = { notAfter: new Date(Date.now() + 300 * day).toISOString(), names: ['lounge-tv.local', 'localhost'] };
  assert.equal(tls.renewalReason(fresh, 'lounge-tv'), '');
  // Browsers treat an expired certificate far more harshly than an untrusted
  // one, so it is replaced before it expires, not after.
  const expiring = { ...fresh, notAfter: new Date(Date.now() + 5 * day).toISOString() };
  assert.match(tls.renewalReason(expiring, 'lounge-tv'), /expire/);
  // Renaming the Pi has to re-issue, or https://new-name.local never matches.
  assert.match(tls.renewalReason(fresh, 'bar-tv'), /bar-tv\.local/);
});

test('ensure makes a usable certificate, keeps the key private, and does not churn', async (t) => {
  const dataDir = tmp();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const first = tls.ensure({ dataDir, hostname: 'lounge-tv' });
  assert.ok(first, 'a certificate should have been made');
  const { certFile, keyFile } = tls.certPaths(dataDir);
  assert.ok(fs.existsSync(certFile) && fs.existsSync(keyFile));
  // The private key must not be readable by the club's other accounts.
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.ok(first.names.includes('lounge-tv.local'));
  assert.ok(first.names.includes('localhost'));
  // The LAN address is deliberately absent: DHCP would change it, and the
  // fingerprint has to stay stable to be worth comparing.
  assert.ok(!first.names.some((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n) && n !== '127.0.0.1'));
  assert.match(first.fingerprint, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);

  // Restarting the dashboard must not hand everyone a new warning.
  const second = tls.ensure({ dataDir, hostname: 'lounge-tv' });
  assert.equal(second.fingerprint, first.fingerprint);

  // The pair has to satisfy Node's own TLS stack, not just parse.
  const server = https.createServer({ cert: first.cert, key: first.key }, (req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const agent = new https.Agent({ rejectUnauthorized: false });
  const body = await new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: server.address().port, path: '/', agent }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve(out));
    }).on('error', reject);
  });
  assert.equal(body, 'ok');
});

test('renaming the Pi re-issues the certificate', (t) => {
  const dataDir = tmp();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const before = tls.ensure({ dataDir, hostname: 'lounge-tv' });
  const after = tls.ensure({ dataDir, hostname: 'bar-tv' });
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.ok(after.names.includes('bar-tv.local'));
});

test('a certificate that cannot be made turns HTTPS off instead of taking the dashboard down', (t) => {
  const dataDir = tmp();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const lines = [];
  const result = tls.ensure({
    dataDir,
    hostname: 'lounge-tv',
    log: (m) => lines.push(m),
    exec: () => { throw new Error('openssl: not found'); },
  });
  assert.equal(result, null, 'ensure must not throw — a club with no openssl still gets its screens');
  assert.match(lines.join('\n'), /HTTPS off/);
  // No half-written certificate left where the next start would trust it.
  assert.ok(!fs.existsSync(tls.certPaths(dataDir).certFile));
});

// ---------------------------------------------------------------- redirect

function start(extra = {}) {
  const dataDir = tmp();
  const ctx = createApp({ dataDir, log: () => {}, sportsFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }), ...extra });
  return new Promise((resolve) => {
    const server = ctx.app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      // node:http, not fetch: fetch refuses to set a Host header, and the Host
      // is exactly what the redirect decision turns on.
      const get = (url, headers = {}) =>
        new Promise((ok, bad) => {
          const req = http.request(
            { host: '127.0.0.1', port, path: url, method: 'GET', headers: { host: 'lounge-tv.local', accept: 'text/html', 'x-pitchtribe': '1', ...headers } },
            (res) => {
              res.resume();
              res.on('end', () => ok({ status: res.statusCode, location: res.headers.location }));
            }
          );
          req.on('error', bad);
          req.end();
        });
      resolve({
        get,
        ctx,
        stop: () => {
          ctx.close();
          server.closeAllConnections();
          server.close();
          fs.rmSync(dataDir, { recursive: true, force: true });
        },
      });
    });
  });
}

const TLS_ON = { port: 443, active: true, fingerprint: 'AA:BB', notAfter: new Date(Date.now() + 3e10).toISOString(), names: ['lounge-tv.local'] };

test('the dashboard is not pushed to HTTPS unless the club asks', async (t) => {
  const s = await start({ tls: { ...TLS_ON } });
  t.after(s.stop);
  // Default off: a self-signed certificate means a browser warning, and nobody
  // should meet one just by opening the dashboard.
  assert.equal((await s.get('/admin/')).status, 200);
  assert.equal(s.ctx.store.data.settings.httpsRedirect, false);
});

test('with the setting on, dashboard page loads go to HTTPS and nothing else does', async (t) => {
  const s = await start({ tls: { ...TLS_ON } });
  t.after(s.stop);
  s.ctx.store.mutate((d) => { d.settings.httpsRedirect = true; });

  const moved = await s.get('/admin/');
  assert.equal(moved.status, 302);
  assert.equal(moved.location, 'https://lounge-tv.local/admin/');

  // The TV on this Pi and the screens elsewhere stay on http: a kiosk browser
  // has no keyboard to dismiss a certificate warning with.
  assert.equal((await s.get('/healthz')).status, 200);
  assert.equal((await s.get('/player/')).status, 200);

  // The kiosk reaches the dashboard as localhost; sending it to HTTPS would
  // black out the screen.
  assert.equal((await s.get('/admin/', { host: 'localhost' })).status, 200);

  // An escape hatch for a phone that will not get past the warning.
  assert.equal((await s.get('/admin/?nossl')).status, 200);

  // Only page loads: an XHR follows the page it came from.
  assert.equal((await s.get('/admin/admin.js', { accept: '*/*' })).status, 200);
});

test('HTTPS that failed to start is not advertised, and cannot be redirected to', async (t) => {
  const broken = { ...TLS_ON, active: false };
  const s = await start({ tls: broken });
  t.after(s.stop);
  s.ctx.store.mutate((d) => { d.settings.httpsRedirect = true; });
  // Port 443 can fail to bind after the app is built (already in use, or no
  // CAP_NET_BIND_SERVICE). Redirecting then would lock the club out entirely.
  assert.equal((await s.get('/admin/')).status, 200);
});
