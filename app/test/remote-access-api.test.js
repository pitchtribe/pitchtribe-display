'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');

const offline = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });

test('remote access API: needs the dashboard password, never stores the SSH password', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ra-api-'));
  const ctx = createApp({ dataDir, sportsFetch: offline, feedsFetch: offline, log: () => {} });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { ctx.close(); server.closeAllConnections(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { cookie, 'x-pitchtribe': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  await call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });
  const reqFile = path.join(dataDir, 'remote-access-request.json');

  // Not on a Pi (no helper status yet): say so.
  let unavailable = await call('GET', '/api/remote-access');
  assert.equal(unavailable.body.available, false);
  assert.match(unavailable.body.unavailableReason, /only be switched on from a Raspberry Pi/);
  assert.equal((await call('POST', '/api/remote-access', { enabled: true, username: 'clubadmin', password: 'long-enough-pw', currentPassword: 'correct horse' })).status, 503);

  /* Unreadable is a different thing from missing, and the two want opposite
     things said. The helper keeps the mirror root-only when the group it
     narrows it to is absent — a real, recoverable state, and the explanation
     goes to the root helper's journal where no club will ever find it. Saying
     "this only works on a Raspberry Pi" to somebody standing in front of one,
     with nothing about repairing it, was the wrong half of that. */
  const mirror = path.join(dataDir, 'remote-access-status.json');
  fs.writeFileSync(mirror, '{}', { mode: 0o000 });
  if (process.getuid && process.getuid() !== 0) {
    unavailable = await call('GET', '/api/remote-access');
    assert.equal(unavailable.body.available, false);
    assert.match(unavailable.body.unavailableReason, /cannot read its state — re-run the PitchTribe installer/);
    // The POST still refuses. Its message is not asserted because the error
    // handler replaces every 5xx body with "Something went wrong" on purpose,
    // and the dashboard does not offer the buttons when available is false —
    // the GET above is where a club reads what is wrong.
    assert.equal((await call('POST', '/api/remote-access', { enabled: false, currentPassword: 'correct horse' })).status, 503);
  }
  fs.rmSync(mirror, { force: true });

  fs.writeFileSync(path.join(dataDir, 'remote-access-status.json'), JSON.stringify({ sshEnabled: false, sshActive: false, users: ['dan'] }));
  let r = await call('GET', '/api/remote-access');
  assert.equal(r.body.available, true);
  assert.deepEqual(r.body.status.users, ['dan']);

  r = await call('POST', '/api/remote-access', { enabled: true, username: 'clubadmin', password: 'long-enough-pw', currentPassword: 'wrong' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /dashboard password/);
  assert.equal((await call('POST', '/api/remote-access', { enabled: true, username: 'root', password: 'long-enough-pw', currentPassword: 'correct horse' })).status, 400);
  assert.equal((await call('POST', '/api/remote-access', { enabled: true, username: 'clubadmin', password: 'short', currentPassword: 'correct horse' })).status, 400);
  assert.ok(!fs.existsSync(reqFile));

  r = await call('POST', '/api/remote-access', { enabled: true, username: 'clubadmin', password: 'long-enough-pw', currentPassword: 'correct horse' });
  assert.equal(r.status, 200);
  const raw = fs.readFileSync(reqFile, 'utf8');
  const req = JSON.parse(raw);
  assert.deepEqual([req.id, req.action, req.username], [r.body.requestId, 'enable', 'clubadmin']);
  assert.match(req.passwordHash, /^\$6\$/);
  assert.ok(!raw.includes('long-enough-pw'), 'the plain password is never written');
  assert.equal(fs.statSync(reqFile).mode & 0o077, 0, 'readable by the server and root only');

  r = await call('POST', '/api/remote-access', { enabled: false, currentPassword: 'correct horse' });
  assert.equal(JSON.parse(fs.readFileSync(reqFile, 'utf8')).action, 'disable');

  cookie = '';
  assert.equal((await call('GET', '/api/remote-access')).status, 401);
});

test('support access API: needs the dashboard password, and will not run unbounded', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sa-api-'));
  const ctx = createApp({ dataDir, sportsFetch: offline, feedsFetch: offline, log: () => {} });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { ctx.close(); server.closeAllConnections(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { cookie, 'x-pitchtribe': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  await call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });
  const reqFile = path.join(dataDir, 'remote-access-request.json');
  const statusFile = path.join(dataDir, 'remote-access-status.json');
  const write = (s) => fs.writeFileSync(statusFile, JSON.stringify(s));

  write({ sshEnabled: false, sshActive: false, users: ['dan'] });

  // Off on a fresh card, and the dashboard is told so without having to guess.
  let r = await call('GET', '/api/remote-access');
  assert.equal(r.body.status.support.enabled, false);
  assert.equal(r.body.status.support.installed, false);
  assert.equal(r.body.status.support.expiresAt, null);
  assert.deepEqual(r.body.supportHours, [1, 4, 6, 12, 24]);
  assert.equal(r.body.supportHoursDefault, 6);

  // The dashboard password again, the same as for SSH.
  r = await call('POST', '/api/remote-access', { support: { enabled: true, hours: 6 }, currentPassword: 'wrong' });
  assert.equal(r.status, 403);
  assert.ok(!fs.existsSync(reqFile), 'a wrong password asks the Pi for nothing');

  // Only the lengths on the list. Anything else is refused here as well as in
  // the helper, so an unbounded session cannot be asked for at all.
  for (const hours of [0, 7, 999, -1, 'forever', null]) {
    r = await call('POST', '/api/remote-access', { support: { enabled: true, hours }, currentPassword: 'correct horse' });
    assert.equal(r.status, 400, `hours=${hours}`);
    assert.match(r.body.error, /how long support access should last/);
  }
  assert.ok(!fs.existsSync(reqFile));

  r = await call('POST', '/api/remote-access', { support: { enabled: true, hours: 6 }, currentPassword: 'correct horse' });
  assert.equal(r.status, 200);
  let req = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
  assert.deepEqual([req.id, req.action, req.hours], [r.body.requestId, 'support-enable', 6]);
  assert.equal(fs.statSync(reqFile).mode & 0o077, 0, 'readable by the server and root only');

  // No length given means the default, not "no limit".
  r = await call('POST', '/api/remote-access', { support: { enabled: true }, currentPassword: 'correct horse' });
  assert.equal(JSON.parse(fs.readFileSync(reqFile, 'utf8')).hours, 6);

  // Ending it needs the password too — it is not a free action.
  assert.equal((await call('POST', '/api/remote-access', { support: { enabled: false } })).status, 403);
  r = await call('POST', '/api/remote-access', { support: { enabled: false }, currentPassword: 'correct horse' });
  assert.equal(JSON.parse(fs.readFileSync(reqFile, 'utf8')).action, 'support-disable');

  // A support request never carries SSH fields along with it, however much the
  // caller puts in the body: one is not a way of quietly doing the other.
  r = await call('POST', '/api/remote-access', {
    support: { enabled: true, hours: 1 }, enabled: true, username: 'clubadmin', password: 'long-enough-pw', currentPassword: 'correct horse',
  });
  req = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
  assert.equal(req.action, 'support-enable');
  assert.equal(req.username, undefined);
  assert.equal(req.passwordHash, undefined);

  // A live session is reported with the link to finish at and when it ends.
  write({
    sshEnabled: false,
    sshActive: false,
    users: ['dan'],
    support: {
      installed: true, enabled: true, user: 'dan', hours: 6, signedIn: true, shellSessions: 2,
      expiresAt: '2026-11-04T20:00:00.000Z', lastConnection: '2026-11-04T15:00:00.000Z',
      signin: { url: 'https://connect.raspberrypi.com/verify/ABCD-1234', code: 'ABCD-1234', at: '2026-11-04T14:00:00.000Z' },
    },
  });
  const s = (await call('GET', '/api/remote-access')).body.status.support;
  assert.deepEqual(
    [s.installed, s.enabled, s.signedIn, s.connected, s.user, s.hours, s.expiresAt, s.signin.code],
    [true, true, true, true, 'dan', 6, '2026-11-04T20:00:00.000Z', 'ABCD-1234'],
  );
  assert.equal(s.lastConnection, '2026-11-04T15:00:00.000Z');

  cookie = '';
  assert.equal((await call('GET', '/api/remote-access')).status, 401);
  assert.equal((await call('POST', '/api/remote-access', { support: { enabled: true }, currentPassword: 'correct horse' })).status, 401);
});

test('tunnel access API: validates token, writes request, never echoes the token', async (t) => {
  const GOOD_TOKEN = Buffer.from(JSON.stringify({
    a: 'ad7861717c55f5e2f439ca07d7402f35',
    t: '8f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8',
    s: Buffer.from('x'.repeat(32)).toString('base64'),
  })).toString('base64');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ta-api-'));
  const ctx = createApp({ dataDir, sportsFetch: offline, feedsFetch: offline, log: () => {} });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { ctx.close(); server.closeAllConnections(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { cookie, 'x-pitchtribe': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const bodyText = await res.text();
    return { status: res.status, text: bodyText, body: JSON.parse(bodyText) };
  };
  await call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });
  const reqFile = path.join(dataDir, 'remote-access-request.json');
  const statusFile = path.join(dataDir, 'remote-access-status.json');

  // GET includes tunnel state from the mirror.
  fs.writeFileSync(statusFile, JSON.stringify({ sshEnabled: false, sshActive: false, users: ['dan'], tunnel: { enabled: true, connected: true } }));
  let r = await call('GET', '/api/remote-access');
  assert.equal(r.body.status.tunnel.enabled, true);
  assert.equal(r.body.status.tunnel.connected, true);
  // The token is not in the GET response under any key.
  assert.ok(!r.text.includes(GOOD_TOKEN), 'GET response never contains a token');

  // A missing status file (not on a Pi) blocks POST.
  fs.rmSync(statusFile, { force: true });
  r = await call('POST', '/api/remote-access', { tunnel: { enabled: true, token: GOOD_TOKEN }, currentPassword: 'correct horse' });
  assert.equal(r.status, 503);

  // Restore the mirror.
  fs.writeFileSync(statusFile, JSON.stringify({ sshEnabled: false, sshActive: false, users: ['dan'] }));

  // Wrong dashboard password → 403, no request written.
  r = await call('POST', '/api/remote-access', { tunnel: { enabled: true, token: GOOD_TOKEN }, currentPassword: 'wrong' });
  assert.equal(r.status, 403);
  assert.ok(!fs.existsSync(reqFile), 'wrong password asks the Pi for nothing');

  // Malformed token → 400 at the route boundary, no request file written.
  r = await call('POST', '/api/remote-access', { tunnel: { enabled: true, token: 'not-a-token' }, currentPassword: 'correct horse' });
  assert.equal(r.status, 400);
  assert.ok(!r.text.includes('not-a-token'), '400 response does not echo the bad input');
  assert.ok(!fs.existsSync(reqFile), 'bad token writes nothing to disk');

  // Valid token → tunnel-enable request written, token is in it (the root helper
  // is the one with authority over the env file, so the route must pass it on).
  r = await call('POST', '/api/remote-access', { tunnel: { enabled: true, token: GOOD_TOKEN }, currentPassword: 'correct horse' });
  assert.equal(r.status, 200);
  const req = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
  assert.equal(req.action, 'tunnel-enable');
  assert.equal(req.token, GOOD_TOKEN, 'route passes the validated token to the helper');
  // The HTTP *response* body must not contain the token (the response is just { requestId }).
  assert.ok(!r.text.includes(GOOD_TOKEN), 'HTTP response body does not contain the token');

  // Disable → tunnel-disable request, SSH and support fields untouched.
  r = await call('POST', '/api/remote-access', { tunnel: { enabled: false }, currentPassword: 'correct horse' });
  assert.equal(r.status, 200);
  const reqDis = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
  assert.equal(reqDis.action, 'tunnel-disable');
  assert.equal(reqDis.username, undefined, 'disable request carries no SSH fields');
  assert.equal(reqDis.token, undefined, 'disable request carries no token');

  // A tunnel POST does not carry SSH or support fields alongside it.
  r = await call('POST', '/api/remote-access', {
    tunnel: { enabled: true, token: GOOD_TOKEN }, enabled: true, username: 'clubadmin', password: 'long-enough-pw', currentPassword: 'correct horse',
  });
  const reqMixed = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
  assert.equal(reqMixed.action, 'tunnel-enable');
  assert.equal(reqMixed.username, undefined, 'tunnel block leaves SSH out of the request');
  assert.equal(reqMixed.passwordHash, undefined);
});
