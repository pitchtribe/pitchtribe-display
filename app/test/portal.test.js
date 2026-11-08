'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createPortalApp, writePortalSettings, portalPath } = require('../lib/portal');
const { createApp } = require('../lib/app');

/** Raw HTTP so we can set the Host header like a phone's captive-portal probe. */
function request(port, { method = 'GET', path: p = '/', host = '10.42.0.1', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host, ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* The portal cannot read db.json — it runs as its own user and the dashboard
   hands it what the sign-in page needs. This is that handover. */
function publish(dataDir, portal, extra = {}) {
  writePortalSettings(dataDir, { club: 'Riverside <FC>', portal, ...extra });
}
const portalFileIn = (dataDir, name) => path.join(portalPath(dataDir), name);

async function startPortal(portal) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-portal-'));
  publish(dataDir, portal);
  const allowed = [];
  let clock = Date.parse('2026-11-07T14:00:00Z');
  const ctx = createPortalApp({
    dataDir, portalHost: '10.42.0.1', subnet: '127.0.0.',
    allow: async (ip, minutes) => { allowed.push([ip, minutes]); },
    mac: () => 'aa:bb:cc:dd:ee:ff', now: () => clock, log: () => {},
  });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  return {
    port: server.address().port, dataDir, allowed,
    tick: (ms) => { clock += ms; },
    stop: () => { ctx.close(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

test('captive-portal probes for other hosts are redirected to the portal', async (t) => {
  const p = await startPortal({ enabled: true });
  t.after(p.stop);
  for (const [host, url] of [['captive.apple.com', '/hotspot-detect.html'], ['connectivitycheck.gstatic.com', '/generate_204'], ['www.msftconnecttest.com', '/connecttest.txt'], ['example.com', '/']]) {
    const r = await request(p.port, { host, path: url });
    assert.equal(r.status, 302, host);
    assert.equal(r.headers.location, 'http://10.42.0.1/');
  }
});

test('splash page: branding, escaping, strict CSP, no scripts', async (t) => {
  const p = await startPortal({ enabled: true, headline: 'Welcome to {club}', message: 'Pints & <b>chips</b>', collectEmail: 'optional' });
  t.after(p.stop);
  const r = await request(p.port);
  assert.equal(r.status, 200);
  assert.match(r.text, /<h1>Welcome to Riverside &lt;FC&gt;<\/h1>/);
  assert.match(r.text, /Pints &amp; &lt;b&gt;chips&lt;\/b&gt;/);
  assert.match(r.text, /name="email"/);
  assert.ok(!/<script/i.test(r.text), 'works without JavaScript');
  assert.match(r.headers['content-security-policy'], /default-src 'none'/);
  const css = await request(p.port, { path: '/theme.css' });
  assert.match(css.text, /--accent: #2ce6a8/);
});

test('accepting the terms opens the firewall for the session length', async (t) => {
  const p = await startPortal({ enabled: true, sessionMinutes: 90, collectEmail: 'off' });
  t.after(p.stop);
  let r = await request(p.port, { method: 'POST', path: '/accept', body: '' });
  assert.equal(r.status, 400, 'terms must be ticked');
  assert.match(r.text, /agree to the terms/);
  assert.equal(p.allowed.length, 0);

  r = await request(p.port, { method: 'POST', path: '/accept', body: 'terms=yes' });
  assert.equal(r.status, 200);
  assert.match(r.text, /You’re online/);
  assert.deepEqual(p.allowed, [['127.0.0.1', 90]]);

  r = await request(p.port);
  assert.match(r.text, /You’re online/, 'connected guests see the success page');
  const saved = JSON.parse(fs.readFileSync(portalFileIn(p.dataDir, 'portal-sessions.json'), 'utf8'));
  assert.equal(saved.sessions['127.0.0.1'].mac, 'aa:bb:cc:dd:ee:ff');
  assert.equal(saved.stats.days['2026-11-07'], 1);

  p.tick(91 * 60_000);
  r = await request(p.port);
  assert.match(r.text, /Connect to Wi-Fi/, 'session expired: splash again');
});

test('email collection: optional, required, consent recorded, validation', async (t) => {
  const p = await startPortal({ enabled: true, collectEmail: 'required' });
  t.after(p.stop);
  let r = await request(p.port, { method: 'POST', path: '/accept', body: 'terms=yes' });
  assert.equal(r.status, 400);
  assert.match(r.text, /enter your email/);
  r = await request(p.port, { method: 'POST', path: '/accept', body: 'terms=yes&email=not-an-email' });
  assert.equal(r.status, 400);
  assert.match(r.text, /value="not-an-email"/, 'keeps what was typed');
  r = await request(p.port, { method: 'POST', path: '/accept', body: 'terms=yes&email=jo%40example.com&consent=yes' });
  assert.equal(r.status, 200);
  const lines = fs.readFileSync(portalFileIn(p.dataDir, 'portal-guests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((g) => [g.email, g.consent]), [['jo@example.com', true]]);
});

test('switched off, outside the guest network, and rate limiting', async (t) => {
  const p = await startPortal({ enabled: false });
  t.after(p.stop);
  let r = await request(p.port);
  assert.equal(r.status, 503);
  publish(p.dataDir, { enabled: true });
  fs.utimesSync(portalFileIn(p.dataDir, 'settings.json'), new Date(), new Date(Date.now() + 5000));
  r = await request(p.port);
  assert.equal(r.status, 200, 'picks up dashboard changes without a restart');
  for (let i = 0; i < 10; i++) await request(p.port, { method: 'POST', path: '/accept', body: '' });
  r = await request(p.port, { method: 'POST', path: '/accept', body: 'terms=yes' });
  assert.equal(r.status, 429);
});

test('dashboard: portal settings, network file for the root helper, guest export', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-portal-admin-'));
  const ctx = createApp({ dataDir, log: () => {} });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { ctx.close(); server.closeAllConnections(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { cookie, 'x-pitchtribe': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  };
  await call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });

  let r = await call('GET', '/api/portal');
  assert.equal(r.body.settings.enabled, false);
  assert.equal(r.body.stats.active, 0);

  assert.equal((await call('PUT', '/api/portal', { ssid: '' })).status, 400);
  assert.equal((await call('PUT', '/api/portal', { ssid: 'Club 🍺' })).status, 400, 'printable ASCII only');
  assert.equal((await call('PUT', '/api/portal', { redirectUrl: 'javascript:alert(1)' })).status, 400);
  r = await call('PUT', '/api/portal', { enabled: true, ssid: 'Riverside-Guest', downMbps: 20, upMbps: 5, collectEmail: 'optional', accent: '#ff0000', channel: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.channel, 6, 'only channels 1, 6 and 11');
  const net = JSON.parse(fs.readFileSync(path.join(dataDir, 'portal-network.json'), 'utf8'));
  assert.deepEqual(net, {
    enabled: true, ssid: 'Riverside-Guest', radio: 'auto', band: '2.4', channel: 6, accessPoints: false, downMbps: 20, upMbps: 5,
  });

  // Coverage: radio, band and channel, and ceiling access points.
  r = await call('PUT', '/api/portal', { radio: 'usb', band: '5', channel: 44, accessPoints: true });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.settings.radio, r.body.settings.band, r.body.settings.channel, r.body.settings.accessPoints], ['usb', '5', 44, true]);
  r = await call('PUT', '/api/portal', { band: '5', channel: 6 });
  assert.equal(r.body.settings.channel, 36, '5 GHz takes only channels 36, 40, 44 and 48');
  r = await call('PUT', '/api/portal', { band: '2.4', channel: 44 });
  assert.equal(r.body.settings.channel, 6);
  r = await call('PUT', '/api/portal', { radio: 'nonsense' });
  assert.equal(r.body.settings.radio, 'auto');
  r = await call('PUT', '/api/portal', { radio: 'off', accessPoints: false });
  assert.equal(r.status, 400, 'guest Wi-Fi on with nothing to broadcast it is refused');
  assert.match(r.body.error, /access points/);
  r = await call('PUT', '/api/portal', { radio: 'off', accessPoints: true });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'portal-network.json'), 'utf8')).radio, 'off');

  // The hardware the root helper found is passed through to the dashboard.
  assert.equal((await call('GET', '/api/portal')).body.hardware, null);
  const hw = { checkedAt: '2026-11-07T14:00:00Z', devices: [{ name: 'wlan1', kind: 'wifi', bus: 'usb', product: '802.11ac NIC' }], wifi: 'wlan1', wired: null, problems: [] };
  fs.writeFileSync(path.join(dataDir, 'portal-hardware.json'), JSON.stringify(hw));
  assert.deepEqual((await call('GET', '/api/portal')).body.hardware, hw);

  r = await call('GET', '/api/portal/preview');
  assert.match(r.body, /Welcome to Riverside FC/);
  assert.match(r.body, /type="button"/, 'preview form never submits');

  fs.writeFileSync(path.join(dataDir, 'portal-guests.jsonl'), `${JSON.stringify({ at: '2026-11-07T14:00:00Z', email: 'jo@example.com', consent: true })}\n${JSON.stringify({ at: '2026-11-07T15:00:00Z', email: 'a"b@example.com', consent: false })}\n`);
  r = await call('GET', '/api/portal');
  assert.deepEqual(r.body.guests, { count: 2, consented: 1 });
  r = await call('GET', '/api/portal/guests.csv');
  assert.match(r.headers.get('content-disposition'), /wifi-guests\.csv/);
  assert.match(r.body, /"jo@example.com","yes"/);
  assert.match(r.body, /"a""b@example.com","no"/);
  await call('DELETE', '/api/portal/guests');
  assert.equal((await call('GET', '/api/portal')).body.guests.count, 0);

  cookie = '';
  assert.equal((await call('GET', '/api/portal')).status, 401);
});

test('portal and dashboard meet only through DATA_DIR/portal, on a fresh card and an upgraded one', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-portal-split-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  // A card set up before the portal had its own user: both files sit in
  // DATA_DIR itself, and an upgrade must not look like the guest list was lost.
  fs.writeFileSync(path.join(dataDir, 'portal-guests.jsonl'), `${JSON.stringify({ at: '2026-11-01T12:00:00Z', email: 'old@example.com', consent: true })}\n`);
  fs.writeFileSync(path.join(dataDir, 'portal-sessions.json'), JSON.stringify({ updatedAt: '2026-11-01T12:00:00Z', sessions: {}, stats: { days: { '2026-11-01': 7 } } }));

  const ctx = createApp({ dataDir, log: () => {} });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { ctx.close(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pitchtribe': '1' },
    body: JSON.stringify({ clubName: 'Riverside FC', password: 'correct horse' }),
  });
  const cookie = (setup.headers.get('set-cookie') || '').split(';')[0];
  const get = (url) => fetch(base + url, { headers: { cookie, 'x-pitchtribe': '1' } });

  // Starting the dashboard publishes the sign-in page's settings for the portal...
  const published = JSON.parse(fs.readFileSync(path.join(portalPath(dataDir), 'settings.json'), 'utf8'));
  assert.equal(published.club, 'Riverside FC');
  assert.equal(typeof published.portal.terms, 'string');
  // ...and nothing else: no password hash, no signing secret, no API keys.
  const text = JSON.stringify(published);
  for (const secret of ['adminHash', 'sessionSecret', 'apiToken']) {
    assert.ok(!text.includes(secret), `${secret} must not be handed to the portal`);
  }

  // The old guest list and stats are still read.
  let stats = await (await get('/api/portal')).json();
  assert.deepEqual(stats.guests, { count: 1, consented: 1 });
  assert.match(await (await get('/api/portal/guests.csv')).text(), /old@example\.com/);

  // Switch guest Wi-Fi on, as the club would, which republishes the settings.
  const saved = await fetch(`${base}/api/portal`, {
    method: 'PUT',
    headers: { cookie, 'x-pitchtribe': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, ssid: 'Riverside-Guest', collectEmail: 'optional' }),
  });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(portalPath(dataDir), 'settings.json'), 'utf8')).portal.enabled, true);

  // The portal, as its own user would, writes only inside DATA_DIR/portal.
  const p = createPortalApp({
    dataDir, portalHost: '10.42.0.1', subnet: '127.0.0.', allow: async () => {}, mac: () => '', log: () => {},
  });
  const portalServer = await new Promise((r) => { const s = p.app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { p.close(); portalServer.close(); });
  const accepted = await request(portalServer.address().port, {
    method: 'POST', path: '/accept', body: 'terms=yes&email=new%40example.com&consent=yes',
  });
  assert.equal(accepted.status, 200, 'a guest can still sign in');
  assert.ok(fs.existsSync(path.join(portalPath(dataDir), 'portal-guests.jsonl')));
  assert.ok(fs.existsSync(path.join(portalPath(dataDir), 'portal-sessions.json')));

  // Once the portal has written its own list, that is the one the dashboard shows.
  stats = await (await get('/api/portal')).json();
  assert.deepEqual(stats.guests, { count: 1, consented: 1 });
  assert.match(await (await get('/api/portal/guests.csv')).text(), /new@example\.com/);
  assert.equal(stats.stats.active, 1, 'and the live session count comes from the portal’s own file');

  // Clearing the guest list clears both places.
  await fetch(`${base}/api/portal/guests`, { method: 'DELETE', headers: { cookie, 'x-pitchtribe': '1' } });
  assert.equal(fs.existsSync(path.join(portalPath(dataDir), 'portal-guests.jsonl')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'portal-guests.jsonl')), false);
  assert.equal((await (await get('/api/portal')).json()).guests.count, 0);
});
