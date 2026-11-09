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
  assert.equal((await call('GET', '/api/remote-access')).body.available, false);
  assert.equal((await call('POST', '/api/remote-access', { enabled: true, username: 'clubadmin', password: 'long-enough-pw', currentPassword: 'correct horse' })).status, 503);

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
