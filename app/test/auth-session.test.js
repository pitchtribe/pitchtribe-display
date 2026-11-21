'use strict';
/* Signing in as yourself: /api/auth/login against the people list,
   /api/auth/me, and what happens to a session when the account behind it
   changes. The people-list routes themselves are tested in users-api.test.js;
   what is checked here is who the server decides is asking. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');
const auth = require('../lib/auth');
const um = require('../lib/user-model');

const offline = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });

const CLUB_PASSWORD = 'correct horse battery';
const OWNER = ['view', 'content', 'settings', 'users'];

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-auth-session-'));
  const ctx = createApp({ dataDir, sportsFetch: offline, feedsFetch: offline, log: () => {} });
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

  /* One browser, with its own cookie jar — so two volunteers, or one volunteer
     on a laptop and a phone, can be signed in at the same time. */
  const browser = () => {
    let cookie = '';
    const call = async (method, url, body) => {
      const res = await fetch(base + url, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          'x-pitchtribe': '1',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { status: res.status, headers: res.headers, body: await res.json() };
    };
    return { call };
  };

  // Setting the club up signs that browser in with the shared password.
  const club = browser();
  await club.call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: CLUB_PASSWORD });
  const addUser = async (body) => (await club.call('POST', '/api/users', body)).body.user;
  const signIn = async (username, password) => {
    const b = browser();
    const r = await b.call('POST', '/api/auth/login', { username, password });
    return { ...b, login: r };
  };
  return { browser, club, addUser, signIn };
}

test('a shared-password session is nobody in particular, with an owner’s rights', async (t) => {
  const s = await startServer(t);

  const r = await s.club.call('GET', '/api/auth/me');
  assert.equal(r.status, 200);
  assert.equal(r.body.user, null, 'the club’s one login names no volunteer');
  assert.equal(r.body.shared, true);
  assert.deepEqual(r.body.can, OWNER, 'it is the club itself, so it may do everything');
  assert.equal(r.headers.get('cache-control'), 'no-store');

  const stranger = s.browser();
  assert.equal((await stranger.call('GET', '/api/auth/me')).status, 401, 'and it has to be asked with a session');
});

test('a volunteer signs in by name and the session says who they are', async (t) => {
  const s = await startServer(t);
  await s.addUser({ username: 'jane', name: 'Jane Doe', role: 'owner', password: 'a-good-long-password' });

  const jane = await s.signIn('Jane', 'a-good-long-password');
  assert.equal(jane.login.status, 200, 'the username is not case-sensitive');
  assert.equal(jane.login.body.user.username, 'jane');
  assert.equal(jane.login.body.user.mustChangePassword, false);
  assert.ok(!('passwordHash' in jane.login.body.user), 'the hash never reaches the browser');

  const me = await jane.call('GET', '/api/auth/me');
  assert.equal(me.body.shared, false);
  assert.equal(me.body.user.name, 'Jane Doe');
  assert.deepEqual(me.body.can, OWNER);

  const list = await s.club.call('GET', '/api/users');
  assert.ok(list.body.users.find((u) => u.username === 'jane').lastLoginAt, 'the people list shows them as seen');
});

test('a starter password gets the volunteer in and asks for a new one', async (t) => {
  const s = await startServer(t);
  const created = await s.club.call('POST', '/api/users', { username: 'sam', role: 'editor' });
  const starter = created.body.temporaryPassword;

  const sam = await s.signIn('sam', starter);
  assert.equal(sam.login.status, 200);
  assert.equal(sam.login.body.user.mustChangePassword, true, 'so the dashboard knows to insist on a new one');
});

test('sign-in does not say which volunteers exist', async (t) => {
  const s = await startServer(t);
  await s.addUser({ username: 'jane', role: 'editor', password: 'a-good-long-password' });
  const b = s.browser();

  const nobody = await b.call('POST', '/api/auth/login', { username: 'ghost', password: 'a-good-long-password' });
  const wrong = await b.call('POST', '/api/auth/login', { username: 'jane', password: 'not-the-password' });
  assert.equal(nobody.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(nobody.body.error, wrong.body.error, 'a username nobody has reads the same as a wrong password');

  const borrowed = await b.call('POST', '/api/auth/login', { username: 'jane', password: CLUB_PASSWORD });
  assert.equal(borrowed.status, 401, 'the club’s shared password is not a way in as a named volunteer');
  assert.equal((await b.call('GET', '/api/state')).status, 401, 'none of that left a session behind');
});

test('roles apply to the session, not only to a test’s injected user', async (t) => {
  const s = await startServer(t);
  await s.addUser({ username: 'jane', role: 'owner', password: 'a-good-long-password' });
  await s.addUser({ username: 'sam', role: 'editor', password: 'a-good-long-password' });

  const sam = await s.signIn('sam', 'a-good-long-password');
  const denied = await sam.call('GET', '/api/users');
  assert.equal(denied.status, 403, 'an editor cannot see the club’s logins');
  assert.match(denied.body.error, /Only an owner/);
  assert.deepEqual((await sam.call('GET', '/api/auth/me')).body.can, ['view', 'content']);
  assert.equal((await sam.call('GET', '/api/state')).status, 200, 'but the dashboard is still theirs to use');

  const jane = await s.signIn('jane', 'a-good-long-password');
  const allowed = await jane.call('GET', '/api/users');
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.me.username, 'jane', 'and the page knows whose controls to grey out');
});

test('suspending a volunteer takes their dashboard away on the next request', async (t) => {
  const s = await startServer(t);
  const sam = await s.addUser({ username: 'sam', role: 'editor', password: 'a-good-long-password' });

  const b = await s.signIn('sam', 'a-good-long-password');
  assert.equal((await b.call('GET', '/api/state')).status, 200);

  await s.club.call('PATCH', `/api/users/${sam.id}`, { active: false });
  assert.equal((await b.call('GET', '/api/state')).status, 401, 'the cookie still verifies; the account is off');
  assert.equal(
    (await b.call('POST', '/api/auth/login', { username: 'sam', password: 'a-good-long-password' })).status,
    401,
    'and there is no signing back in'
  );
});

test('resetting a password signs that volunteer out, and nobody else', async (t) => {
  const s = await startServer(t);
  await s.addUser({ username: 'jane', role: 'owner', password: 'jane-good-password' });
  const sam = await s.addUser({ username: 'sam', role: 'editor', password: 'sam-good-password' });

  const jane = await s.signIn('jane', 'jane-good-password');
  const samLaptop = await s.signIn('sam', 'sam-good-password');
  const samPhone = await s.signIn('sam', 'sam-good-password');

  const reset = await jane.call('POST', `/api/users/${sam.id}/password-reset`, { currentPassword: 'jane-good-password' });
  assert.equal(reset.status, 200, 'an owner is asked for their own password, not the club’s');
  const starter = reset.body.temporaryPassword;
  assert.ok(starter);

  assert.equal((await samLaptop.call('GET', '/api/state')).status, 401, 'sam’s session is over');
  assert.equal((await samPhone.call('GET', '/api/state')).status, 401, 'on every device sam left it on');
  assert.equal((await jane.call('GET', '/api/state')).status, 200, 'jane, who did it, is still signed in');
  assert.equal((await s.club.call('GET', '/api/state')).status, 200, 'and the screens-night session carries on');

  const back = await samLaptop.call('POST', '/api/auth/login', { username: 'sam', password: starter });
  assert.equal(back.status, 200);
  assert.equal(back.body.user.mustChangePassword, true);
});

test('a volunteer changes their own password and stays signed in', async (t) => {
  const s = await startServer(t);
  await s.addUser({ username: 'jane', role: 'owner', password: 'jane-good-password' });

  const laptop = await s.signIn('jane', 'jane-good-password');
  const phone = await s.signIn('jane', 'jane-good-password');

  let r = await laptop.call('POST', '/api/settings/password', { current: 'not-it', next: 'a-new-good-password' });
  assert.equal(r.status, 400, 'their own password is what is asked for');
  r = await laptop.call('POST', '/api/settings/password', { current: 'jane-good-password', next: 'short' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at least 8 characters/);

  r = await laptop.call('POST', '/api/settings/password', { current: 'jane-good-password', next: 'a-new-good-password' });
  assert.equal(r.status, 200);
  assert.equal((await laptop.call('GET', '/api/state')).status, 200, 'the browser that did it got a fresh cookie');
  assert.equal((await phone.call('GET', '/api/state')).status, 401, 'the device they left signed in is out');

  const b = s.browser();
  assert.equal((await b.call('POST', '/api/auth/login', { username: 'jane', password: 'a-new-good-password' })).status, 200);
  assert.equal(
    (await b.call('POST', '/api/auth/login', { password: CLUB_PASSWORD })).status,
    200,
    'and the club’s shared password was not touched'
  );
});

test('changing the club’s shared password still signs every shared session out', async (t) => {
  const s = await startServer(t);
  const other = s.browser();
  await other.call('POST', '/api/auth/login', { password: CLUB_PASSWORD });

  const r = await s.club.call('POST', '/api/settings/password', { current: CLUB_PASSWORD, next: 'a-new-club-password' });
  assert.equal(r.status, 200);
  assert.equal((await other.call('GET', '/api/state')).status, 401, 'they were all the same login');
  assert.equal((await s.club.call('GET', '/api/state')).status, 200);
});

test('session cookies: shared, named, and what they refuse', () => {
  const secret = 'club-secret';
  const shared = auth.issueToken(secret);
  const named = auth.issueToken(secret, 'user-id-1');

  assert.equal(auth.readToken(shared, secret).userId, null, 'a shared session names nobody');
  const claim = auth.readToken(named, secret);
  assert.equal(claim.userId, 'user-id-1');
  assert.ok(claim.issuedAt <= Date.now() && claim.issuedAt > Date.now() - 5000, 'and carries when it was issued');

  assert.equal(auth.verifyToken(named, secret), true);
  assert.equal(auth.readToken(named, 'another-secret'), null, 'only the club’s secret signs one');
  assert.equal(auth.readToken(named.replace('user-id-1', 'user-id-2'), secret), null, 'the name cannot be swapped');
  assert.equal(auth.readToken('v2..1.2.signature', secret), null, 'a named session with no name is not the shared one');
  assert.equal(auth.readToken(shared.replace('v1', 'v2'), secret), null, 'nor is a shared one relabelled');
  const old = auth.issueToken(secret, 'user-id-1', { now: Date.now() - 31 * 86400 * 1000 });
  assert.equal(auth.readToken(old, secret), null, 'a session runs out after 30 days');
});

test('a password change ends that account’s older sessions', () => {
  const user = um.createUser({ username: 'jane', password: 'a good password' });
  const opened = Date.now();
  assert.equal(um.sessionValid(user, opened), true, 'nothing has signed this account out');

  um.setPassword(user, 'a better password', { now: new Date(opened + 1000) });
  assert.equal(um.sessionValid(user, opened), false, 'the cookie from before the change is done');
  assert.equal(um.sessionValid(user, opened + 2000), true, 'the one issued after it is good');

  assert.equal(um.sessionValid({ ...user, active: false }, opened + 2000), false, 'a suspended account has no sessions');
  assert.equal(um.sessionValid(user, null), false, 'a stamped account needs a cookie that says when it was issued');
  assert.equal(um.sessionValid(null, opened), false);
});
