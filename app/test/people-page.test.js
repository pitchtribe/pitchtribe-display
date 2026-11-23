'use strict';
/* The dashboard's People page against the API it actually talks to.

   The page is a classic script in a browser, so nothing here runs it: what is
   worth checking is the seam between the two halves, because that is where a
   dependency-free single-page app fails silently. A URL the page builds by
   string concatenation and a field it reads off a response are both invisible
   to node --check and to the route tests, which only ever see the server's own
   idea of its routes. A renamed route or a dropped field would leave a People
   page that loads, shows "Can't show the people list", and passes every other
   test in the suite.

   So each check comes in two halves: that admin.js still asks for this, and
   that a live server still answers it with what the page reads. The first half
   is deliberately a string match on the front-end source — it is the only
   thing that notices when the page stops calling a route the server still
   happily serves. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');

const ADMIN_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'admin.js'), 'utf8');

const offline = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
const CLUB_PASSWORD = 'correct horse batteryA1!';

/** A dashboard signed in the way a club's is today: the one shared password. */
async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-people-page-'));
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
  let cookie = '';
  /* The same three headers admin.js sends on every call: the session cookie,
     the x-pitchtribe header its CSRF defence is built on, and a JSON
     content-type only when there is a body. */
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
    return { status: res.status, body: await res.json() };
  };
  await call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: CLUB_PASSWORD });
  return { call };
}

test('the People page is reachable at all', () => {
  // A view nothing routes to is a view nobody can open, however well it works.
  assert.match(ADMIN_JS, /\['people', 'People', 'people'\]/, 'the People page is no longer in the dashboard nav, so there is no way to it');
  assert.match(ADMIN_JS, /r\.view === 'people'\) nodes = viewPeople\(\)/, 'the router no longer dispatches #/people, so the nav link would fall through to Content');
  assert.match(ADMIN_JS, /function viewPeople\(/, 'viewPeople is gone');
});

test('the People page asks for the list the way the server serves it', async (t) => {
  const s = await startServer(t);
  assert.match(ADMIN_JS, /api\('GET', '\/users'\)/, 'the page no longer loads the people list from /api/users');

  const r = await s.call('GET', '/api/users');
  assert.equal(r.status, 200);
  // The three top-level fields the page reads off this response.
  assert.ok(Array.isArray(r.body.users), 'the page maps over .users');
  assert.ok(Array.isArray(r.body.roles), 'the page builds its role menu and legend from .roles');
  assert.ok('me' in r.body, 'the page greys out your own controls from .me, and cannot tell "absent" from "nobody"');
  assert.deepEqual(r.body.users, [], 'a club still on the shared password has nobody on the list yet');
  assert.equal(r.body.me, null, 'a shared-password session is nobody in particular');
});

test('adding somebody hands back the one copy of a generated password', async (t) => {
  const s = await startServer(t);
  assert.match(ADMIN_JS, /api\('POST', '\/users', payload\)/, 'the page no longer creates people through /api/users');
  assert.match(ADMIN_JS, /res\.temporaryPassword\) showStarterPassword/, 'the page no longer shows a generated password, which would strand the volunteer it was made for');

  // Blank password field: the page sends no `password` key at all, and the only
  // copy of what the server made up comes back in this response.
  const made = await s.call('POST', '/api/users', { username: 'jane', name: 'Jane Doe', email: 'jane@riverside.example', role: 'owner', active: true });
  assert.equal(made.status, 201);
  assert.ok(made.body.temporaryPassword, 'nothing came back to read out, so the new login is unusable');
  assert.equal(made.body.user.mustChangePassword, true, 'the page promises they will be asked to choose their own');

  // Every field a table row renders.
  for (const key of ['id', 'username', 'name', 'email', 'role', 'active', 'mustChangePassword', 'lastLoginAt']) {
    assert.ok(key in made.body.user, `the people list renders .${key}`);
  }
  assert.equal(made.body.user.lastLoginAt, null, 'the page shows "never signed in" for this');

  // A password typed into the form is sent as `password`, and is theirs to keep.
  const typed = await s.call('POST', '/api/users', { username: 'sam', name: 'Sam', email: '', role: 'editor', active: true, password: 'a-good-long-passwordA1!' });
  assert.equal(typed.status, 201);
  assert.ok(!('temporaryPassword' in typed.body), 'nothing was generated, so there is nothing to show once');
  assert.equal(typed.body.user.mustChangePassword, false);

  const list = await s.call('GET', '/api/users');
  assert.deepEqual(list.body.users.map((u) => u.username), ['jane', 'sam'], 'owners first, then alphabetical — the page does no sorting of its own');
});

test('an edit sends only the fields the form changed', async (t) => {
  const s = await startServer(t);
  assert.match(ADMIN_JS, /api\('PATCH', `\/users\/\$\{encodeURIComponent\(user\.id\)\}`, payload\)/, 'the page no longer saves edits through /api/users/:id');

  const { body: { user } } = await s.call('POST', '/api/users', { username: 'jane', role: 'owner' });
  const r = await s.call('PATCH', `/api/users/${user.id}`, { username: 'jane', name: 'Jane Doe', email: 'jane@riverside.example', role: 'owner', active: true });
  assert.equal(r.status, 200);
  assert.ok(r.body.user, 'the page re-reads the saved person from .user');
  assert.equal(r.body.user.name, 'Jane Doe');

  // The page's own guard: a username already taken comes back as a sentence it
  // can put straight into the form's error line.
  await s.call('POST', '/api/users', { username: 'sam', role: 'editor' });
  const clash = await s.call('PATCH', `/api/users/${user.id}`, { username: 'sam', role: 'owner', active: true });
  assert.equal(clash.status, 400);
  assert.match(clash.body.error, /already taken/i, 'the page shows .error verbatim, so it has to read as English');
});

test('a password reset needs the owner’s own password', async (t) => {
  const s = await startServer(t);
  assert.match(ADMIN_JS, /api\('POST', `\/users\/\$\{encodeURIComponent\(user\.id\)\}\/password-reset`/, 'the page no longer resets passwords through /api/users/:id/password-reset');
  assert.match(ADMIN_JS, /currentPassword: current\.value/, 'the reset dialog stopped asking for the signed-in person’s own password, which the route requires');

  const { body: { user } } = await s.call('POST', '/api/users', { username: 'jane', role: 'owner' });

  const wrong = await s.call('POST', `/api/users/${user.id}/password-reset`, { currentPassword: 'not it' });
  assert.equal(wrong.status, 403);
  assert.ok(wrong.body.error, 'the dialog has nothing to put in its error line');

  const generated = await s.call('POST', `/api/users/${user.id}/password-reset`, { currentPassword: CLUB_PASSWORD });
  assert.equal(generated.status, 200);
  assert.ok(generated.body.temporaryPassword, 'a blank "new password" field is meant to generate one');
  assert.equal(generated.body.user.mustChangePassword, true);

  const chosen = await s.call('POST', `/api/users/${user.id}/password-reset`, { currentPassword: CLUB_PASSWORD, password: 'another-good-passwordA1!' });
  assert.equal(chosen.status, 200);
  assert.ok(!('temporaryPassword' in chosen.body), 'a password typed in the dialog is not shown back');
  assert.equal(chosen.body.user.mustChangePassword, false, 'one they chose themselves is theirs to keep');
});

test('removing somebody, and the last owner who cannot be', async (t) => {
  const s = await startServer(t);
  assert.match(ADMIN_JS, /api\('DELETE', `\/users\/\$\{encodeURIComponent\(user\.id\)\}`\)/, 'the page no longer removes people through /api/users/:id');

  const { body: { user: jane } } = await s.call('POST', '/api/users', { username: 'jane', role: 'owner' });
  const { body: { user: sam } } = await s.call('POST', '/api/users', { username: 'sam', role: 'editor' });

  const gone = await s.call('DELETE', `/api/users/${sam.id}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.ok, true);

  /* The page does not try to work this out for itself — it has no way to know
     which owners are active without reimplementing the model — so it shows
     whatever the server says. That makes the wording part of the contract. */
  const last = await s.call('DELETE', `/api/users/${jane.id}`);
  assert.equal(last.status, 400);
  assert.match(last.body.error, /at least one owner/i, 'the page toasts .error as-is');
});
