'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');
const { validatePassword } = require('../lib/password-policy');
const PASSWORD = 'Test-owner-password1!';
const offline = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-gate-'));
  const ctx = createApp({ dataDir: dir, feedsFetch: offline, log: () => {} });
  const server = await new Promise(resolve => { const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  function client() {
    let cookie = '';
    return async (method, url, body, headers = {}) => {
      const res = await fetch(base + url, { method, headers: { cookie, 'x-pitchtribe': '1', 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
      return { status: res.status, body: await res.json() };
    };
  }
  const owner = client();
  assert.equal((await owner('POST', '/api/auth/setup', { clubName: 'Gate test', password: PASSWORD })).status, 200);
  assert.equal((await owner('POST', '/api/setup/owner', { username: 'owner' })).status, 201);
  assert.equal((await owner('POST', '/api/auth/login', { username: 'owner', password: PASSWORD })).status, 200);
  return { ctx, dir, client, owner };
}
const privileged = [
  ['PUT', '/api/settings', { clubName: 'Taken over' }],
  ['PUT', '/api/SETTINGS/', { clubName: 'Taken over' }],
  ['PUT', '/api/settings/sports', {}], ['PUT', '/api/settings/widgets', {}],
  ['PUT', '/api/tls', {}], ['PUT', '/api/portal', {}],
  ['DELETE', '/api/portal/guests'], ['GET', '/api/portal/guests.csv'],
  ['GET', '/api/backup/download'], ['GET', '/api/backup/recovery'],
  ['POST', '/api/backup/request', {}], ['POST', '/api/backup/restore-file', {}],
  ['POST', '/api/remote-access', {}], ['GET', '/api/remote-access'],
  ['POST', '/api/settings/sports/token', {}], ['POST', '/api/sports/refresh', {}],
  ['POST', '/feeds/api/refresh', {}], ['GET', '/feeds/api/geocode?q=London'],
  ['POST', '/api/setup/retire-shared-password', { currentPassword: PASSWORD }],
];
for (const role of ['viewer', 'editor']) test('real ' + role + ' login cannot reach owner operations or feed bypasses', async t => {
  const s = await fixture(t);
  await s.owner('POST', '/api/users', { username: role, role, password: PASSWORD });
  const call = s.client();
  assert.equal((await call('POST', '/api/auth/login', { username: role, password: PASSWORD })).status, 200);
  for (const [method, url, body] of privileged) assert.equal((await call(method, url, body)).status, 403, method + ' ' + url);
  const state = await call('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.sports.apiToken, undefined);
  assert.equal(state.body.widgets.trains, undefined);
  assert.equal(state.body.widgets.bods, undefined);
  const add = await call('POST', '/api/assets', { type: 'notice', name: 'Test', content: { title: 'Hello' } });
  assert.equal(add.status, role === 'editor' ? 201 : 403);
  assert.equal((await call('POST', '/api/settings/password', { current: PASSWORD, next: 'Changed-password2!' })).status, 200);
  assert.equal(s.ctx.store.data.settings.clubName, 'Gate test');
});
test('forced replacement blocks ordinary operations until a policy-compliant password is saved', async t => {
  const s = await fixture(t);
  const added = await s.owner('POST', '/api/users', { username: 'starter', role: 'owner' });
  const temporary = added.body.temporaryPassword;
  assert.equal(validatePassword(temporary).valid, true);
  const call = s.client();
  assert.equal((await call('POST', '/api/auth/login', { username: 'starter', password: temporary })).status, 200);
  assert.equal((await call('GET', '/api/auth/me')).body.user.mustChangePassword, true);
  for (const [method, url, body] of [...privileged, ['GET', '/api/state'], ['GET', '/api/users'], ['POST', '/api/assets', {}]]) {
    assert.equal((await call(method, url, body)).status, 403, method + ' ' + url);
  }
  assert.equal((await call('POST', '/api/settings/password', { current: temporary, next: 'password' })).status, 400);
  assert.equal((await call('GET', '/api/state')).status, 403);
  assert.equal((await call('POST', '/api/settings/password', { current: temporary, next: 'Replacement-password2!' }, { 'x-pitchtribe': '' })).status, 403);
  assert.equal((await call('POST', '/api/settings/password', { current: temporary, next: 'Replacement-password2!' })).status, 200);
  assert.equal((await call('GET', '/api/auth/me')).body.user.mustChangePassword, false);
  assert.equal((await call('PUT', '/api/settings', { clubName: 'Allowed' })).status, 200);
});
test('production routes enforce policy and emit credential-free audit events; migration retirement keeps named login', async t => {
  const s = await fixture(t);
  assert.equal((await s.owner('POST', '/api/users', { username: 'weak', password: 'password' })).status, 400);
  const made = await s.owner('POST', '/api/users', { username: 'valid', password: PASSWORD });
  assert.equal(made.status, 201);
  assert.equal((await s.owner('POST', '/api/users/' + made.body.user.id + '/password-reset', { currentPassword: PASSWORD, password: 'password' })).status, 400);
  assert.equal((await s.owner('POST', '/api/users/' + made.body.user.id + '/password-reset', { currentPassword: PASSWORD })).status, 200);
  const failed = s.client();
  assert.equal((await failed('POST', '/api/auth/login', { username: 'owner', password: 'BAD-SECRET-NEVER-LOG' })).status, 401);
  assert.equal((await s.owner('POST', '/api/settings/password', { current: PASSWORD, next: 'New-owner-password2!' })).status, 200);
  assert.equal((await s.owner('POST', '/api/setup/retire-shared-password', { currentPassword: 'New-owner-password2!' })).status, 200);
  assert.equal((await failed('POST', '/api/auth/login', { password: PASSWORD })).status, 401);
  assert.equal((await failed('POST', '/api/auth/login', { username: 'owner', password: 'New-owner-password2!' })).status, 200);
  await failed('POST', '/api/auth/logout', {});
  await s.ctx.close();
  const raw = fs.readFileSync(path.join(s.dir, 'audit/security-audit.log'), 'utf8');
  for (const secret of [PASSWORD, 'New-owner-password2!', 'BAD-SECRET-NEVER-LOG', 'scrypt$', 'pt_session']) assert.ok(!raw.includes(secret));
  const events = raw.trim().split('\n').map(line => JSON.parse(line).eventType);
  for (const event of ['login_success', 'login_failure', 'password_change', 'password_reset', 'logout', 'admin_action']) assert.ok(events.includes(event), event);
});
