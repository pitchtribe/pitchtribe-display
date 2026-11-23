'use strict';
/* The rules behind the club's people list: who may sign in, who may change
   what, and what a user record is allowed to look like. These run against the
   model directly — no HTTP, no database file. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const um = require('../lib/user-model');
const auth = require('../lib/auth');
const { Store } = require('../lib/store');

const owner = (over = {}) => um.createUser({ username: 'chair', password: 'a good passwordA1!', role: 'owner', ...over });
const rejects = (fn, re) => assert.throws(fn, (err) => err.status === 400 && re.test(err.message), `expected 400 matching ${re}`);

test('a new record carries everything the dashboard needs, and the password only as a hash', () => {
  const user = um.createUser({ username: 'Jane.Smith', name: 'Jane Smith', email: 'Jane@Club.Example', password: 'correct horseA1!' });


  assert.equal(user.username, 'jane.smith', 'stored lower-case');
  assert.equal(user.email, 'jane@club.example');
  assert.equal(user.role, 'editor', 'the safe default: content, not settings or people');
  assert.equal(user.active, true);
  assert.equal(user.mustChangePassword, false);
  assert.ok(user.id && user.createdAt && user.updatedAt);
  assert.equal(user.lastLoginAt, null);
  assert.equal(user.password, undefined, 'the clear password is never kept');
  assert.ok(user.passwordHash.startsWith('scrypt$'));
  assert.ok(auth.verifyPassword('correct horseA1!', user.passwordHash));
});

test('a missing name falls back to the username rather than blocking the invite', () => {
  assert.equal(um.createUser({ username: 'bar.rota', password: 'a good passwordA1!' }).name, 'bar.rota');
});

test('usernames are unique however they are typed', () => {
  const users = [um.createUser({ username: 'jane', password: 'a good passwordA1!' })];
  rejects(() => um.createUser({ username: 'JANE', password: 'another passwordA1!' }, { users }), /already taken/);
  rejects(() => um.createUser({ username: '  jane  ', password: 'another passwordA1!' }, { users }), /already taken/);
  assert.ok(um.createUser({ username: 'jane2', password: 'another passwordA1!' }, { users }));
});

test('email addresses are unique too, but staying blank is fine', () => {
  const users = [um.createUser({ username: 'jane', email: 'jane@club.example', password: 'a good passwordA1!' })];
  rejects(() => um.createUser({ username: 'jim', email: 'JANE@club.example', password: 'a good passwordA1!' }, { users }), /already in use/);
  assert.equal(um.createUser({ username: 'jim', password: 'a good passwordA1!' }, { users }).email, '');
  assert.equal(um.createUser({ username: 'jonty', email: '  ', password: 'a good passwordA1!' }, { users }).email, '');
  rejects(() => um.createUser({ username: 'jonty', email: 'not-an-address', password: 'a good passwordA1!' }), /valid email/);
});

test('a username has to be something a volunteer can read off a note and type', () => {
  rejects(() => um.createUser({ password: 'a good passwordA1!' }), /required/);
  rejects(() => um.createUser({ username: 'jo', password: 'a good passwordA1!' }), /at least 3 characters/);
  rejects(() => um.createUser({ username: 'jane smith', password: 'a good passwordA1!' }), /lower-case letters/);
  rejects(() => um.createUser({ username: '_jane', password: 'a good passwordA1!' }), /lower-case letters/);
  rejects(() => um.createUser({ username: 'jane@club', password: 'a good passwordA1!' }), /lower-case letters/);
  rejects(() => um.createUser({ username: 'j'.repeat(33), password: 'a good passwordA1!' }), /too long/);
  assert.ok(um.createUser({ username: 'jane_smith-2.0', password: 'a good passwordA1!' }));
});

test('the password rules live in one place', () => {
  rejects(() => um.createUser({ username: 'jane', password: 'short' }), /at least 12 characters/);
  rejects(() => um.createUser({ username: 'jane', password: '' }), /at least 12 characters/);
  rejects(() => um.createUser({ username: 'jane', password: 'x'.repeat(201) }), /too long/);
  rejects(() => um.createUser({ username: 'groundsmanlong', password: 'Groundsmanlong' }), /same as the username/);
});

test('an unknown role is not a way to grant one', () => {
  assert.equal(um.createUser({ username: 'jane', role: 'superuser', password: 'a good passwordA1!' }).role, 'editor');
  assert.equal(um.createUser({ username: 'jane', role: 'owner', password: 'a good passwordA1!' }).role, 'owner');
});

test('what each role may do', () => {
  const by = (role) => um.createUser({ username: 'someone', role, password: 'a good passwordA1!' });


  for (const capability of ['view', 'content', 'settings', 'users']) assert.ok(um.can(by('owner'), capability), `owner: ${capability}`);
  assert.ok(um.can(by('editor'), 'content'), 'an editor puts things on the screens');
  assert.ok(!um.can(by('editor'), 'settings'));
  assert.ok(!um.can(by('editor'), 'users'));
  assert.ok(um.can(by('viewer'), 'view'));
  assert.ok(!um.can(by('viewer'), 'content'), 'a viewer changes nothing');

  assert.ok(!um.can(null, 'view'), 'nobody signed in');
  assert.ok(!um.can(by('owner'), 'restore-backups'), 'capabilities are not open-ended');
  assert.ok(!um.can({ ...by('owner'), active: false }, 'view'), 'a suspended owner is still suspended');
});

test('a suspended account cannot sign in, and neither can a record with no hash', () => {
  const user = um.createUser({ username: 'jane', password: 'correct horseA1!' });
  assert.ok(um.verifyUserPassword(user, 'correct horseA1!'));
  assert.ok(!um.verifyUserPassword(user, 'wrong horse'));
  assert.ok(!um.verifyUserPassword({ ...user, active: false }, 'correct horseA1!'));
  assert.ok(!um.verifyUserPassword({ ...user, passwordHash: '' }, 'correct horseA1!'));
  assert.ok(!um.verifyUserPassword(null, 'correct horseA1!'));
});

test('an edit keeps the fields the form left out', () => {
  const user = um.createUser({ username: 'jane', name: 'Jane Smith', email: 'jane@club.example', role: 'owner', password: 'a good passwordA1!' });
  const users = [user, um.createUser({ username: 'jim', role: 'owner', password: 'a good passwordA1!' })];

  const hash = user.passwordHash;

  um.applyUpdate(user, { name: 'Jane S' }, { users });

  assert.equal(user.name, 'Jane S');
  assert.equal(user.username, 'jane', 'untouched');
  assert.equal(user.email, 'jane@club.example', 'untouched');
  assert.equal(user.role, 'owner', 'an edit elsewhere does not demote anyone');
  assert.equal(user.active, true, 'nor suspend them');
  assert.equal(user.passwordHash, hash, 'nor change their password');
  assert.notEqual(user.updatedAt, user.createdAt);
});

test('an edit cannot take a username another volunteer already has', () => {
  const users = [um.createUser({ username: 'jane', password: 'a good passwordA1!' }), um.createUser({ username: 'jim', password: 'a good passwordA1!' })];

  rejects(() => um.applyUpdate(users[1], { username: 'Jane' }, { users }), /already taken/);
  assert.ok(um.applyUpdate(users[1], { username: 'jim', name: 'Jim' }, { users }), 'keeping your own username is not a clash');
});

test('the last owner cannot be demoted, suspended or removed', () => {
  const chair = owner();
  const users = [chair, um.createUser({ username: 'helper', password: 'a good passwordA1!' })];


  rejects(() => um.applyUpdate(chair, { role: 'editor' }, { users }), /at least one owner/);
  rejects(() => um.applyUpdate(chair, { active: false }, { users }), /at least one owner/);
  rejects(() => um.assertRemovable(chair, users), /at least one owner/);

  // With a second owner in place, the first may stand down.
  const treasurer = um.createUser({ username: 'treasurer', role: 'owner', password: 'a good passwordA1!' }, { users });

  users.push(treasurer);
  assert.ok(um.assertRemovable(chair, users));
  um.applyUpdate(chair, { role: 'editor' }, { users });
  assert.equal(chair.role, 'editor');

  // And now the treasurer is the one who has to stay.
  rejects(() => um.assertRemovable(treasurer, users), /at least one owner/);
});

test('a suspended owner does not count as the owner who has to stay', () => {
  const chair = owner({ username: 'chair' });
  const retired = um.createUser({ username: 'retired', role: 'owner', password: 'a good passwordA1!' });

  retired.active = false;
  const users = [chair, retired];
  rejects(() => um.applyUpdate(chair, { role: 'editor' }, { users }), /at least one owner/);
  assert.ok(um.assertRemovable(retired, users), 'the suspended one can go');
});

test('removing someone who is not there is a 404, not a 400', () => {
  assert.throws(() => um.assertRemovable(null, []), (err) => err.status === 404);
});

test('setting a new password clears the starter-password flag', () => {
  const user = um.createUser({ username: 'jane', password: 'a good passwordA1!', mustChangePassword: true });
  assert.equal(user.mustChangePassword, true);

  um.setPassword(user, 'a better passwordA1!');

  assert.ok(um.verifyUserPassword(user, 'a better passwordA1!'));
  assert.ok(!um.verifyUserPassword(user, 'a good passwordA1!'));
  assert.equal(user.mustChangePassword, false);
  rejects(() => um.setPassword(user, 'short'), /at least 12 characters/);
});

test('lookups find people by id, username and email, whatever the case', () => {
  const jane = um.createUser({ username: 'jane', email: 'jane@club.example', password: 'a good passwordA1!' });

  const users = [jane];

  assert.equal(um.findById(users, jane.id), jane);
  assert.equal(um.findByUsername(users, 'JANE'), jane);
  assert.equal(um.findByEmail(users, ' Jane@Club.Example '), jane);
  assert.equal(um.findById(users, 'nope'), null);
  assert.equal(um.findByUsername(users, ''), null, 'a blank username matches nobody');
  assert.equal(um.findByEmail(users, ''), null, 'and so does a blank email, including records with none');
  assert.equal(um.findByUsername(undefined, 'jane'), null);
});

test('a user never reaches the browser with its password hash', () => {
  const user = um.createUser({ username: 'jane', password: 'a good passwordA1!', role: 'owner' });

  user.lastLoginAt = '2026-11-20T10:00:00.000Z';

  const view = um.publicUser(user);

  assert.equal(view.passwordHash, undefined);
  assert.ok(!JSON.stringify(view).includes('scrypt'));
  assert.deepEqual(Object.keys(view).sort(), ['active', 'can', 'createdAt', 'email', 'id', 'lastLoginAt', 'mustChangePassword', 'name', 'role', 'username']);
  assert.deepEqual(view.can, ['view', 'content', 'settings', 'users'], 'so the dashboard can hide what this person cannot do');
  assert.equal(um.publicUser(null), null);
});

test('the people list reads owners first, then alphabetically', () => {
  const users = [
    um.createUser({ username: 'zoe', password: 'a good passwordA1!' }),
    um.createUser({ username: 'adam', role: 'viewer', password: 'a good passwordA1!' }),
    um.createUser({ username: 'chair', role: 'owner', password: 'a good passwordA1!' }),
    um.createUser({ username: 'amy', password: 'a good passwordA1!' }),

  ];
  assert.deepEqual(um.usersView(users).map((u) => u.username), ['chair', 'amy', 'zoe', 'adam']);
  assert.deepEqual(um.usersView([]), []);
  assert.deepEqual(um.usersView(undefined), []);
});

test('the store starts with an empty people list and keeps it across a save', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-users-'));
  const file = path.join(dir, 'db.json');
  try {
    const store = new Store(file);
    assert.deepEqual(store.data.users, []);
    assert.equal(store.data.schemaVersion, 2);

    const jane = um.createUser({ username: 'jane', password: 'a good passwordA1!', role: 'owner' });

    store.mutate((d) => d.users.push(jane));

    const reopened = new Store(file);
    assert.equal(reopened.data.users.length, 1);
    assert.ok(um.verifyUserPassword(reopened.data.users[0], 'a good passwordA1!'), 'the hash survives the round trip');

  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a database written before user logins still opens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-users-old-'));
  const file = path.join(dir, 'db.json');
  try {
    const shared = auth.hashPassword('the shared password');
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, settings: { clubName: 'Riverside FC', adminHash: shared }, assets: [{ id: 'x' }], playlists: [], screens: [] })
    );

    const store = new Store(file);

    assert.deepEqual(store.data.users, [], 'no users key on disk, an empty list in memory');
    assert.equal(store.data.assets.length, 1, 'content is left alone');
    assert.equal(store.data.settings.adminHash, shared, 'the shared password is still there to migrate from');
    assert.ok(um.needsUserMigration(store.data), 'and the club is told it has an owner account to create');

    store.mutate((d) => d.users.push(um.createUser({ username: 'chair', password: 'a good passwordA1!', role: 'owner' })));

    assert.ok(!um.needsUserMigration(store.data), 'once somebody is on the list, there is nothing to migrate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a half-restored database with a null users list does not crash the first lookup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-users-null-'));
  const file = path.join(dir, 'db.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ users: null, assets: null, settings: {} }));
    const store = new Store(file);
    assert.deepEqual(store.data.users, []);
    assert.deepEqual(store.data.assets, []);
    assert.equal(um.findByUsername(store.data.users, 'jane'), null);
    assert.equal(um.needsUserMigration(store.data), false, 'no shared password either, so this is a fresh card');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
