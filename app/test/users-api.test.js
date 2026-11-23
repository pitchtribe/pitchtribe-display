'use strict';
/* Settings → People over HTTP: /api/users and the password reset.
   The model's own rules are tested in users.test.js; what is checked here is
   the route layer — status codes, what reaches the browser, who is allowed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');
const auth = require('../lib/auth');

const offline = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });

const CLUB_PASSWORD = 'correct horse batteryA1!';

/** A dashboard signed in with the club's shared password, as it is today. */
async function startServer(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-users-api-'));
  const ctx = createApp({ dataDir, sportsFetch: offline, feedsFetch: offline, log: () => {}, ...extra });
  const server = await new Promise((r) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => r(s));
  });
  t.after(() => {
    ctx.close();
    server.closeAllConnections();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = async (method, url, body, { csrf = true } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-pitchtribe': '1' } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const call = (method, url, body) => request(method, url, body);
  const callWithoutCsrfHeader = (method, url, body) => request(method, url, body, { csrf: false });
  await call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: CLUB_PASSWORD });
  return { call, callWithoutCsrfHeader, ctx, dataDir, dbFile: path.join(dataDir, 'db.json'), clearCookie: () => { cookie = ''; } };
}

test('users API: add, list, edit and remove the club’s logins', async (t) => {
  const s = await startServer(t);

  let r = await s.call('GET', '/api/users');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.users, [], 'a freshly set-up club has nobody on the list yet');
  assert.deepEqual(r.body.roles, ['owner', 'editor', 'viewer']);
  assert.equal(r.headers.get('cache-control'), 'no-store');

  r = await s.call('POST', '/api/users', { username: 'Jane', name: 'Jane Doe', email: 'Jane@Riverside.example', role: 'owner', password: 'a-good-long-passwordA1!' });
  assert.equal(r.status, 201);
  const jane = r.body.user;
  assert.equal(jane.username, 'jane', 'usernames are stored lower-case');
  assert.equal(jane.email, 'jane@riverside.example');
  assert.equal(jane.role, 'owner');
  assert.equal(jane.active, true);
  assert.equal(jane.mustChangePassword, false, 'a password the volunteer chose is theirs to keep');
  assert.ok(!('passwordHash' in jane), 'the hash never reaches the browser');
  assert.ok(!('temporaryPassword' in r.body), 'nothing was generated, so nothing is handed back');

  // No password in the form: the dashboard gets one to read out, once.
  r = await s.call('POST', '/api/users', { username: 'sam', role: 'editor' });
  assert.equal(r.status, 201);
  const starter = r.body.temporaryPassword;
  assert.ok(starter && starter.length >= 12, `a usable starter password, got ${starter}`);
  assert.equal(r.body.user.mustChangePassword, true);
  assert.equal(r.body.user.name, 'sam', 'no name given falls back to the username');
  assert.deepEqual(r.body.user.can, ['view', 'content']);

  r = await s.call('GET', '/api/users');
  assert.deepEqual(r.body.users.map((u) => u.username), ['jane', 'sam'], 'owners first, then alphabetical');

  // Clashes are refused, on either field, whatever the casing.
  assert.equal((await s.call('POST', '/api/users', { username: 'JANE', password: 'a-good-long-passwordA1!' })).status, 400);
  assert.equal((await s.call('POST', '/api/users', { username: 'jane2', email: 'JANE@riverside.example', password: 'a-good-long-passwordA1!' })).status, 400);
  assert.equal((await s.call('POST', '/api/users', { username: 'no', password: 'a-good-long-passwordA1!' })).status, 400);
  assert.equal((await s.call('POST', '/api/users', { username: 'kit', password: 'short' })).status, 400);

  // An edit touches only the fields it names.
  r = await s.call('PATCH', `/api/users/${r.body.user?.id || ''}`, {});
  assert.equal(r.status, 404, 'an unknown id is a 404, not a surprise new user');

  const sam = (await s.call('GET', '/api/users')).body.users.find((u) => u.username === 'sam');
  r = await s.call('PATCH', `/api/users/${sam.id}`, { name: 'Sam Smith', role: 'viewer' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.user.name, r.body.user.role, r.body.user.username], ['Sam Smith', 'viewer', 'sam']);

  // A password cannot be slipped in through an edit.
  r = await s.call('PATCH', `/api/users/${sam.id}`, { password: 'sneaked-in-passwordA1!' });
  assert.equal(r.status, 200);
  const stored = JSON.parse(fs.readFileSync(s.dbFile, 'utf8')).users.find((u) => u.id === sam.id);
  assert.ok(auth.verifyPassword(starter, stored.passwordHash), 'the starter password still works');
  assert.ok(!auth.verifyPassword('sneaked-in-passwordA1!', stored.passwordHash));
  assert.equal(stored.mustChangePassword, true, 'an edit does not clear the must-change flag either');

  r = await s.call('DELETE', `/api/users/${sam.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual((await s.call('GET', '/api/users')).body.users.map((u) => u.username), ['jane']);
  assert.equal((await s.call('DELETE', `/api/users/${sam.id}`)).status, 404);

  // The club has to keep an owner: jane is the only one left.
  assert.equal((await s.call('PATCH', `/api/users/${jane.id}`, { role: 'editor' })).status, 400);
  assert.equal((await s.call('PATCH', `/api/users/${jane.id}`, { active: false })).status, 400);
  assert.equal((await s.call('DELETE', `/api/users/${jane.id}`)).status, 400);
});

test('users API: the people list is behind the dashboard login and its CSRF header', async (t) => {
  const s = await startServer(t);
  const created = await s.call('POST', '/api/users', { username: 'jane', role: 'owner', password: 'a-good-long-passwordA1!' });
  assert.equal(created.status, 201);

  /* Signed in, but the request did not come from the dashboard: a cross-site
     form can send the cookie and cannot send this header. Reads are let
     through (SameSite=Strict covers them); anything that writes is not. */
  assert.equal((await s.callWithoutCsrfHeader('GET', '/api/users')).status, 200);
  for (const [method, body] of [['POST', { username: 'intruder', password: 'a-good-long-passwordA1!' }], ['PATCH', { role: 'owner' }], ['DELETE', undefined]]) {
    const url = method === 'POST' ? '/api/users' : `/api/users/${created.body.user.id}`;
    assert.equal((await s.callWithoutCsrfHeader(method, url, body)).status, 403, `${method} ${url}`);
  }
  assert.equal((await s.callWithoutCsrfHeader('POST', `/api/users/${created.body.user.id}/password-reset`, { currentPassword: CLUB_PASSWORD })).status, 403);

  s.clearCookie();
  assert.equal((await s.call('GET', '/api/users')).status, 401);
  assert.equal((await s.call('POST', '/api/users', { username: 'intruder', password: 'a-good-long-passwordA1!' })).status, 401);
  assert.equal((await s.call('DELETE', `/api/users/${created.body.user.id}`)).status, 401);
  assert.equal((await s.call('POST', `/api/users/${created.body.user.id}/password-reset`, { currentPassword: CLUB_PASSWORD })).status, 401);
});

test('users API: a password reset asks for your own password first, and hands the new one back once', async (t) => {
  const s = await startServer(t);
  const jane = (await s.call('POST', '/api/users', { username: 'jane', role: 'owner', password: 'a-good-long-passwordA1!' })).body.user;
  const url = `/api/users/${jane.id}/password-reset`;

  let r = await s.call('POST', url, { password: 'brand-new-passwordA1!' });
  assert.equal(r.status, 403, 'no password given at all is not a reset');
  r = await s.call('POST', url, { currentPassword: 'not the club password', password: 'brand-new-passwordA1!' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /password isn’t right/);
  assert.ok(auth.verifyPassword('a-good-long-passwordA1!', JSON.parse(fs.readFileSync(s.dbFile, 'utf8')).users[0].passwordHash), 'a refused reset changes nothing');

  // A password the owner types in is the volunteer's to keep.
  r = await s.call('POST', url, { currentPassword: CLUB_PASSWORD, password: 'brand-new-passwordA1!' });
  assert.equal(r.status, 200);
  assert.ok(!('temporaryPassword' in r.body));
  assert.equal(r.body.user.mustChangePassword, false);
  let stored = JSON.parse(fs.readFileSync(s.dbFile, 'utf8')).users[0];
  assert.ok(auth.verifyPassword('brand-new-passwordA1!', stored.passwordHash));
  assert.ok(!auth.verifyPassword('a-good-long-passwordA1!', stored.passwordHash));

  // No password means "give me one to read out", and then they must change it.
  r = await s.call('POST', url, { currentPassword: CLUB_PASSWORD });
  assert.equal(r.status, 200);
  assert.ok(r.body.temporaryPassword);
  assert.equal(r.body.user.mustChangePassword, true);
  stored = JSON.parse(fs.readFileSync(s.dbFile, 'utf8')).users[0];
  assert.ok(auth.verifyPassword(r.body.temporaryPassword, stored.passwordHash));

  assert.equal((await s.call('POST', url, { currentPassword: CLUB_PASSWORD, password: 'short' })).status, 400);
  assert.equal((await s.call('POST', `/api/users/nobody/password-reset`, { currentPassword: CLUB_PASSWORD })).status, 404);
});

test('users API: once sessions name a volunteer, only an owner may manage people', async (t) => {
  /* What the sign-in flow will pass in. Until it exists the shared dashboard
     password is the only way in and it is the owner by definition, so the role
     check is exercised here with a session that does name somebody. */
  let signedInAs = null;
  const s = await startServer(t, { currentUser: () => signedInAs });

  const owner = (await s.call('POST', '/api/users', { username: 'jane', role: 'owner', password: 'a-good-long-passwordA1!' })).body.user;
  const editor = (await s.call('POST', '/api/users', { username: 'sam', role: 'editor', password: 'a-good-long-passwordA1!' })).body.user;
  const db = () => JSON.parse(fs.readFileSync(s.dbFile, 'utf8')).users;

  signedInAs = db().find((u) => u.id === editor.id);
  let r = await s.call('GET', '/api/users');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Only an owner/);
  assert.equal((await s.call('POST', '/api/users', { username: 'kit', password: 'a-good-long-passwordA1!' })).status, 403);
  assert.equal((await s.call('PATCH', `/api/users/${editor.id}`, { role: 'owner' })).status, 403, 'an editor cannot promote themselves');
  assert.equal((await s.call('DELETE', `/api/users/${owner.id}`)).status, 403);

  signedInAs = db().find((u) => u.id === owner.id);
  r = await s.call('GET', '/api/users');
  assert.equal(r.status, 200);
  assert.equal(r.body.me.username, 'jane', 'the page is told who it is signed in as');

  // An owner may not take away their own way back into this page.
  assert.equal((await s.call('PATCH', `/api/users/${owner.id}`, { role: 'editor' })).status, 400);
  assert.equal((await s.call('PATCH', `/api/users/${owner.id}`, { active: false })).status, 400);
  assert.equal((await s.call('DELETE', `/api/users/${owner.id}`)).status, 400);
  assert.equal((await s.call('PATCH', `/api/users/${owner.id}`, { name: 'Jane Doe' })).status, 200, 'but may still edit the rest of their record');

  // A reset now checks the owner's own password, not the club's shared one.
  const url = `/api/users/${editor.id}/password-reset`;
  assert.equal((await s.call('POST', url, { currentPassword: CLUB_PASSWORD })).status, 403);
  r = await s.call('POST', url, { currentPassword: 'a-good-long-passwordA1!' });
  assert.equal(r.status, 200);
  assert.ok(auth.verifyPassword(r.body.temporaryPassword, db().find((u) => u.id === editor.id).passwordHash));
});

test('users API: repeated wrong answers to the reset prompt are rate limited', async (t) => {
  const s = await startServer(t);
  const jane = (await s.call('POST', '/api/users', { username: 'jane', role: 'owner', password: 'a-good-long-passwordA1!' })).body.user;
  const url = `/api/users/${jane.id}/password-reset`;

  for (let i = 0; i < 10; i += 1) {
    assert.equal((await s.call('POST', url, { currentPassword: `guess-${i}` })).status, 403);
  }
  const blocked = await s.call('POST', url, { currentPassword: CLUB_PASSWORD });
  assert.equal(blocked.status, 429, 'the right password does not get you past the limiter either');
});
