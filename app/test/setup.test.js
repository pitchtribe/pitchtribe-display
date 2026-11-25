'use strict';
/* First run and the move off the club's shared password: lib/setup.js, the
   /api/setup routes it mounts, and bin/create-admin.js.

   The thing most worth protecting here is that a club which upgrades mid-match
   is not locked out and does not have to learn a new password: the first owner
   account adopts the shared hash, and the shared password keeps working until
   somebody retires it on purpose. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const setup = require('../lib/setup');
const um = require('../lib/user-model');
const auth = require('../lib/auth');
const { Store } = require('../lib/store');
const { createApp } = require('../lib/app');

const SHARED = 'the shared clubhouse password';
const CLI = path.join(__dirname, '..', 'bin', 'create-admin.js');

const tempDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A database as a club running the shared password has it on disk: version 1,
    no users key at all, content already on the screens. */
const v1Database = (file) =>
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      revision: 7,
      settings: { clubName: 'Riverside FC', adminHash: auth.hashPassword(SHARED) },
      assets: [{ id: 'notice-1', type: 'notice', name: 'Welcome notice' }],
      playlists: [],
      screens: [],
    }),
    { mode: 0o600 }
  );

const sharedOnly = () => ({ settings: { adminHash: auth.hashPassword(SHARED) }, users: [] });

// ---------------------------------------------------------------- the stages

test('setup: the three stages a card can be at', () => {
  const fresh = { settings: {}, users: [] };
  assert.equal(setup.stage(fresh), 'fresh');
  assert.equal(setup.setupRequired(fresh), true);
  assert.equal(setup.sharedPasswordActive(fresh), false);

  const shared = sharedOnly();
  assert.equal(setup.stage(shared), 'shared');
  assert.equal(setup.setupRequired(shared), false, 'a club with a password has been set up');
  assert.deepEqual(setup.setupState(shared), {
    stage: 'shared',
    setupRequired: false,
    migrationRequired: true,
    sharedPassword: true,
    users: 0,
    owners: 0,
  });

  const withUsers = { settings: {}, users: [um.createUser({ username: 'jane', password: 'a good passwordA1!', role: 'owner' })] };

  assert.equal(setup.stage(withUsers), 'users');
  assert.equal(setup.setupRequired(withUsers), false);
  assert.equal(setup.setupState(withUsers).migrationRequired, false, 'nothing left to migrate');
  assert.equal(setup.setupState(withUsers).owners, 1);

  // A half-restored file: neither key is an object or an array.
  assert.equal(setup.stage({}), 'fresh');
  assert.equal(setup.stage({ users: null, settings: null }), 'fresh');
});

// -------------------------------------------------------- the first owner

test('setup: the first owner adopts the club’s shared password', () => {
  const data = sharedOnly();
  const user = setup.firstOwner(data, { username: 'Chair', name: 'Club Chair' });

  assert.equal(user.username, 'chair', 'usernames are stored lower-case');
  assert.equal(user.role, 'owner', 'somebody has to be able to add everyone else');
  assert.equal(user.active, true);
  assert.equal(user.mustChangePassword, false, 'the club’s own password is not a starter password');
  assert.ok(um.verifyUserPassword(user, SHARED), 'the password the club already types still works');
  assert.equal(user.passwordHash, data.settings.adminHash, 'the same hash, not a re-hash of a password nobody typed');

  data.users.push(user);
  assert.equal(setup.stage(data), 'users');
  assert.equal(um.needsUserMigration(data), false);
  assert.equal(setup.sharedPasswordActive(data), true, 'the shared password keeps working until it is retired');
});

test('setup: the first owner can choose their own password instead', () => {
  const data = sharedOnly();
  const user = setup.firstOwner(data, { username: 'chair', password: 'a good long passwordA1!' });
  assert.ok(um.verifyUserPassword(user, 'a good long passwordA1!'));

  assert.ok(!um.verifyUserPassword(user, SHARED), 'and the shared one is not theirs');
  assert.notEqual(user.passwordHash, data.settings.adminHash);
});

test('setup: the first owner is refused when there is nothing to adopt and nothing chosen', () => {
  const fresh = { settings: {}, users: [] };
  assert.throws(() => setup.firstOwner(fresh), { status: 400, message: /Choose a password/ });
  // A fresh card is the setup wizard's job, which does set a password.
  const user = setup.firstOwner(fresh, { username: 'chair', password: 'a good long passwordA1!' });
  assert.ok(um.verifyUserPassword(user, 'a good long passwordA1!'));

});

test('setup: there is only ever a first owner once, and the model’s rules still apply', () => {
  const data = sharedOnly();
  data.users.push(setup.firstOwner(data, { username: 'chair' }));
  assert.throws(() => setup.firstOwner(data, { username: 'second' }), { status: 409, message: /already has logins/ });

  const other = sharedOnly();
  assert.throws(() => setup.firstOwner(other, { username: 'no' }), { status: 400, message: /at least 3 characters/ });
  assert.throws(() => setup.firstOwner(other, { username: 'Chair Person' }), { status: 400 });
  assert.throws(() => setup.firstOwner(other, { username: 'chair', password: 'short' }), { status: 400 });
  assert.deepEqual(other.users, [], 'a refused attempt leaves nothing behind');
});

test('setup: a role cannot be smuggled into the first account', () => {
  const data = sharedOnly();
  const user = setup.firstOwner(data, { username: 'chair', role: 'viewer' });
  assert.equal(user.role, 'owner', 'a viewer could not add anybody, and nobody else exists to do it');
});

// ------------------------------------------------- retiring the shared one

test('setup: the shared password is only retired once somebody can sign in without it', () => {
  const data = sharedOnly();
  const before = data.settings.adminHash;

  assert.throws(() => setup.retireSharedPassword(data), { status: 400, message: /own owner login first/ });
  assert.equal(data.settings.adminHash, before, 'and the club is not locked out');

  // An editor is not a way back into the people list either.
  data.users.push(um.createUser({ username: 'sam', password: 'a good passwordA1!', role: 'editor' }, { users: data.users }));
  assert.throws(() => setup.retireSharedPassword(data), { status: 400 });

  // Nor is an owner who has been switched off.
  const chair = um.createUser({ username: 'chair', password: 'a good passwordA1!', role: 'owner' }, { users: data.users });

  chair.active = false;
  data.users.push(chair);
  assert.throws(() => setup.retireSharedPassword(data), { status: 400 });

  chair.active = true;
  assert.equal(setup.retireSharedPassword(data), true);
  assert.equal(data.settings.adminHash, '');
  assert.equal(setup.setupRequired(data), false, 'a club with logins is never offered a fresh start');
  assert.equal(setup.stage(data), 'users');
  assert.equal(setup.retireSharedPassword(data), false, 'nothing to do the second time');
});

// ------------------------------------------------------------- over HTTP

const offline = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });

/** A server on a club's existing version-1 database, signed in with the shared
    password — the state a club is in the moment it updates. */
async function startMigratingServer(t) {
  const dataDir = tempDir(t, 'pt-setup-api-');
  const dbFile = path.join(dataDir, 'db.json');
  v1Database(dbFile);
  const ctx = createApp({ dataDir, sportsFetch: offline, feedsFetch: offline, log: () => {} });
  const server = await new Promise((r) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => r(s));
  });
  t.after(() => {
    ctx.close();
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body, { csrf = true } = {}) => {
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
    return { status: res.status, body: await res.json() };
  };
  const stored = () => JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  return { call, stored, dbFile, clearCookie: () => { cookie = ''; } };
}

test('setup API: a club on the shared password claims its first owner account', async (t) => {
  const s = await startMigratingServer(t);

  let r = await s.call('GET', '/api/auth/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.setupRequired, false, 'this club is set up — it is not offered a fresh start');
  assert.equal(r.body.migrationRequired, true, 'but it has a shared password to move off');
  assert.equal(r.body.stage, 'shared');
  assert.equal(r.body.clubName, 'Riverside FC');

  // Nobody is signed in yet: the first-owner step is behind the dashboard login.
  assert.equal((await s.call('POST', '/api/setup/owner', { username: 'chair' })).status, 401);
  assert.equal((await s.call('GET', '/api/setup/state')).status, 401);

  assert.equal((await s.call('POST', '/api/auth/login', { password: SHARED })).status, 200);

  r = await s.call('GET', '/api/setup/state');
  assert.deepEqual(r.body, { stage: 'shared', setupRequired: false, migrationRequired: true, sharedPassword: true, users: 0, owners: 0 });

  r = await s.call('POST', '/api/setup/owner', { username: 'Chair', name: 'Club Chair', email: 'Chair@Riverside.example' });
  assert.equal(r.status, 201);
  assert.equal(r.body.adoptedSharedPassword, true, 'there is no new password to read out');
  assert.equal(r.body.user.username, 'chair');
  assert.equal(r.body.user.role, 'owner');
  assert.equal(r.body.user.email, 'chair@riverside.example');
  assert.ok(!('passwordHash' in r.body.user), 'the hash never reaches the browser');
  assert.ok(auth.verifyPassword(SHARED, s.stored().users[0].passwordHash), 'written to disk straight away, not on a save timer');
  assert.equal(s.stored().assets.length, 1, 'the club’s content is left alone');

  // Signing in by name, with the password the club already knew.
  s.clearCookie();
  r = await s.call('POST', '/api/auth/login', { username: 'chair', password: SHARED });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, 'chair');
  // And the shared password still works for the volunteers who only know that.
  s.clearCookie();
  assert.equal((await s.call('POST', '/api/auth/login', { password: SHARED })).status, 200);

  r = await s.call('GET', '/api/setup/state');
  assert.deepEqual(r.body, { stage: 'users', setupRequired: false, migrationRequired: false, sharedPassword: true, users: 1, owners: 1 });
  assert.equal((await s.call('POST', '/api/setup/owner', { username: 'second' })).status, 409, 'only once');
  assert.equal((await s.call('POST', '/api/setup/owner', { username: 'second' }, { csrf: false })).status, 403, 'and not from a cross-site form');
});

test('setup API: retiring the shared password asks for it first, then ends its sessions', async (t) => {
  const s = await startMigratingServer(t);
  await s.call('POST', '/api/auth/login', { password: SHARED });
  const url = '/api/setup/retire-shared-password';

  assert.equal((await s.call('POST', url, { currentPassword: SHARED })).status, 400, 'nobody has their own login yet');

  await s.call('POST', '/api/setup/owner', { username: 'chair' });
  assert.equal((await s.call('POST', url, {}, { csrf: false })).status, 403, 'not from a cross-site form');
  let r = await s.call('POST', url, { currentPassword: 'not the club password' });
  assert.equal(r.status, 403);
  assert.ok(s.stored().settings.adminHash, 'a refused attempt changes nothing');

  r = await s.call('POST', url, { currentPassword: SHARED });
  assert.equal(r.status, 200);
  assert.equal(r.body.retired, true);
  assert.equal(r.body.sharedPassword, false);
  assert.equal(r.body.signedOut, true, 'this session was the shared one, so it goes too');
  assert.equal(s.stored().settings.adminHash, '');

  // The cookie the shared password issued is no longer a way in…
  assert.equal((await s.call('GET', '/api/setup/state')).status, 401);
  // …nor is the password itself, and nor is a second run of the setup wizard.
  s.clearCookie();
  assert.equal((await s.call('POST', '/api/auth/login', { password: SHARED })).status, 401);
  assert.equal((await s.call('POST', '/api/auth/setup', { clubName: 'Hijack FC', password: 'a good long passwordA1!' })).status, 409);

  assert.equal((await s.call('GET', '/api/auth/status')).body.setupRequired, false);

  // The owner signs in by name, with the password the club always used.
  r = await s.call('POST', '/api/auth/login', { username: 'chair', password: SHARED });
  assert.equal(r.status, 200);
  assert.equal((await s.call('POST', url, { currentPassword: SHARED })).body.retired, false, 'nothing left to retire');
});

test('setup API: only an owner may change how the club signs in', async (t) => {
  const dataDir = tempDir(t, 'pt-setup-role-');
  v1Database(path.join(dataDir, 'db.json'));
  let signedInAs = null;
  const ctx = createApp({ dataDir, sportsFetch: offline, feedsFetch: offline, log: () => {}, currentUser: () => signedInAs });
  const server = await new Promise((r) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => r(s));
  });
  t.after(() => {
    ctx.close();
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(cookie ? { cookie } : {}), 'x-pitchtribe': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  };

  await call('POST', '/api/auth/login', { password: SHARED });
  await call('POST', '/api/setup/owner', { username: 'chair' });
  await call('POST', '/api/users', { username: 'sam', role: 'editor', password: 'a good long passwordA1!' });
  const users = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')).users;

  signedInAs = users().find((u) => u.username === 'sam');
  let r = await call('POST', '/api/setup/retire-shared-password', { currentPassword: 'a good long passwordA1!' });

  assert.equal(r.status, 403);
  assert.match(r.body.error, /Only an owner/);

  signedInAs = users().find((u) => u.username === 'chair');
  // An owner is asked for their own password, which here is the one adopted
  // from the club's shared password.
  assert.equal((await call('POST', '/api/setup/retire-shared-password', { currentPassword: 'a good long passwordA1!' })).status, 403);

  r = await call('POST', '/api/setup/retire-shared-password', { currentPassword: SHARED });
  assert.equal(r.status, 200);
  assert.equal(r.body.retired, true);
  assert.equal(r.body.signedOut, false, 'a named session is not the shared one and survives');
});

// ------------------------------------------------------- bin/create-admin.js

const runCli = (args, { env = {} } = {}) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
};

test('create-admin: adopts the shared password for the club’s first login', (t) => {
  const dir = tempDir(t, 'pt-create-admin-');
  const file = path.join(dir, 'db.json');
  v1Database(file);

  const r = runCli(['--username', 'Chair', '--name', 'Club Chair', file]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Added chair \(owner\)/);
  assert.match(r.out, /existing shared dashboard password/);
  assert.match(r.out, /--retire-shared/, 'and says how to finish the job');

  const data = new Store(file).data;
  assert.equal(data.users.length, 1);
  assert.equal(data.users[0].role, 'owner');
  assert.equal(data.users[0].name, 'Club Chair');
  assert.ok(um.verifyUserPassword(data.users[0], SHARED));
  assert.equal(data.schemaVersion, 3, 'the file is written back at the current version');
  assert.equal(data.assets.length, 1, 'with the club’s content untouched');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'and still readable only by the service');
});

test('create-admin: a later login gets a generated password, printed once', (t) => {
  const dir = tempDir(t, 'pt-create-admin-more-');
  const file = path.join(dir, 'db.json');
  v1Database(file);
  assert.equal(runCli(['--username', 'chair', file]).code, 0);

  const r = runCli(['--username', 'sam', '--role', 'editor', '--email', 'sam@riverside.example', file]);
  assert.equal(r.code, 0, r.out);
  const password = (r.out.match(/^Password: (.+)$/m) || [])[1];
  assert.ok(password && password.length >= 12, `a usable password, got ${password}`);

  const sam = new Store(file).data.users.find((u) => u.username === 'sam');
  assert.equal(sam.role, 'editor');
  assert.ok(um.verifyUserPassword(sam, password));
  assert.equal(sam.mustChangePassword, true, 'a password this tool invented has to be replaced');

  // A password of the operator's choosing, from the environment.
  assert.equal(runCli(['--username', 'kit', file], { env: { PT_PASSWORD: 'a good long passwordA1!' } }).code, 0);
  const kit = new Store(file).data.users.find((u) => u.username === 'kit');
  assert.ok(um.verifyUserPassword(kit, 'a good long passwordA1!'));

  assert.equal(kit.mustChangePassword, false);
});

test('create-admin: --retire-shared finishes the move in one go', (t) => {
  const dir = tempDir(t, 'pt-create-admin-retire-');
  const file = path.join(dir, 'db.json');
  v1Database(file);

  const r = runCli(['--username', 'chair', '--password', 'a good long passwordA1!', '--retire-shared', file]);

  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /shared dashboard password is off/);
  const data = new Store(file).data;
  assert.equal(data.settings.adminHash, '');
  assert.ok(um.verifyUserPassword(data.users[0], 'a good long passwordA1!'));

});

test('create-admin: --list shows where the club has got to', (t) => {
  const dir = tempDir(t, 'pt-create-admin-list-');
  const file = path.join(dir, 'db.json');
  v1Database(file);

  let r = runCli(['--list', file]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Stage: shared/);
  assert.match(r.out, /nobody on the people list yet/);

  runCli(['--username', 'chair', file]);
  r = runCli(['--list', file]);
  assert.match(r.out, /Stage: users — 1 login\(s\), 1 owner\(s\), shared dashboard password on/);
  assert.match(r.out, /chair\s+owner\s+active/);
});

test('create-admin: says what it cannot do instead of writing something wrong', (t) => {
  const dir = tempDir(t, 'pt-create-admin-bad-');
  const file = path.join(dir, 'db.json');
  v1Database(file);

  assert.equal(runCli([]).code, 2, 'no database to work on');
  assert.equal(runCli(['--username', file]).code, 2, 'an option with no value');
  assert.equal(runCli(['--nonsense', file]).code, 2);
  assert.equal(runCli([file, file]).code, 2);
  assert.equal(runCli(['--help']).code, 0);

  const missing = runCli(['--username', 'chair', path.join(dir, 'nope.json')]);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /not found/);

  const asEditor = runCli(['--username', 'chair', '--role', 'editor', file]);
  assert.equal(asEditor.code, 1);
  assert.match(asEditor.out, /first login has to be an owner/);

  const short = runCli(['--username', 'chair', '--password', 'short', file]);
  assert.equal(short.code, 1);
  assert.match(short.out, /at least 12 characters/);

  assert.equal(runCli(['--username', 'chair', file]).code, 0);
  const clash = runCli(['--username', 'CHAIR', '--password', 'a good long passwordA1!', file]);
  assert.equal(clash.code, 1);
  assert.match(clash.out, /already taken/);

  const nameless = runCli(['--password', 'a good long passwordA1!', file]);

  assert.equal(nameless.code, 2);
  assert.match(nameless.out, /--username is needed/);

  assert.deepEqual(
    new Store(file).data.users.map((u) => u.username),
    ['chair'],
    'nothing from a refused run reached the file'
  );
});
