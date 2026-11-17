'use strict';
/* `/healthz` is read by three things that cannot be changed together: the kiosk
   script on every screen in every club, the installer, and whatever is watching
   the card from outside. These tests pin the parts that would break one of them
   silently — the two-field liveness contract, the 200 it has to keep returning,
   and the decision to keep apt's text off an open route. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');
const { createHealth, DISK_WARN_PERCENT } = require('../lib/health');

/** A statfs that reports a card of `totalGb` with `usedPercent` of it gone. */
const fakeStatfs = (totalGb, usedPercent) => () => {
  const bsize = 4096;
  const blocks = Math.round((totalGb * 1024 ** 3) / bsize);
  return { bsize, blocks, bavail: Math.round(blocks * (1 - usedPercent / 100)), bfree: 0 };
};

const base = (over = {}) => ({
  version: '9.9.9',
  dataDir: os.tmpdir(),
  screens: () => ({ total: 0, online: 0 }),
  osUpdate: () => ({ available: false }),
  cacheMs: 0,
  statfs: fakeStatfs(32, 10),
  ...over,
});

test('healthz: the liveness contract the kiosk depends on', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchtribe-health-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const ctx = createApp({ dataDir, log: () => {} });
  t.after(ctx.close);
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });

  const res = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();

  // deploy/kiosk.sh waits on this route before starting the browser and the
  // install docs tell people to curl it. Both only read these two fields.
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
  assert.match(body.version, /^\d+\.\d+\.\d+/);

  // A watcher that reads a cached body reports faults that are already fixed.
  assert.match(res.headers.get('cache-control') || '', /no-store/);

  // The metrics a monitor off the card actually needs.
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.warnings, []);
  assert.ok(body.uptime.hostSeconds >= 0);
  assert.ok(body.uptime.appSeconds >= 0);
  assert.ok(body.memory.totalBytes > 0);
  assert.ok(body.memory.usedPercent >= 0 && body.memory.usedPercent <= 100);
  assert.ok(body.load.cpus >= 1);
  assert.deepEqual(body.screens, { total: 0, online: 0 });
  assert.equal(body.osUpdate.available, false);
});

test('healthz: counts screens with the same rule as the dashboard', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchtribe-health-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const ctx = createApp({ dataDir, log: () => {} });
  t.after(ctx.close);

  ctx.store.mutate((d) => {
    d.screens.push({ id: 'a', name: 'Bar', lastSeen: Date.now() });
    d.screens.push({ id: 'b', name: 'Lounge', lastSeen: Date.now() - 60 * 60 * 1000 });
  });

  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/healthz`)).json();

  assert.deepEqual(body.screens, { total: 2, online: 1 });
  // Counts only: a screen name on an open route would tell anyone on the LAN
  // how the club is laid out, and a screen off at the wall is not a fault.
  assert.equal(JSON.stringify(body).includes('Lounge'), false);
  assert.equal(body.status, 'ok');
});

test('a nearly full card warns without failing the route', () => {
  const ok = createHealth(base({ statfs: fakeStatfs(32, DISK_WARN_PERCENT - 5) }))();
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.warnings, []);

  const full = createHealth(base({ statfs: fakeStatfs(32, DISK_WARN_PERCENT + 5) }))();
  assert.equal(full.status, 'warn');
  assert.deepEqual(full.warnings, ['disk-low']);
  // The point of the whole design: a full card must not stop screens booting.
  assert.equal(full.ok, true);
  assert.ok(full.disk.freeBytes > 0);
  assert.equal(full.disk.usedPercent, DISK_WARN_PERCENT + 5);
});

test('a card with no statfs reports no disk rather than guessing', () => {
  const view = createHealth(base({ statfs: () => { throw new Error('ENOSYS'); } }))();
  assert.equal(view.disk, null);
  assert.equal(view.status, 'ok'); // unknown is not a fault
  assert.equal(view.ok, true);
});

test('OS updates: warns when patching has stopped, without repeating apt', () => {
  const unpatched = {
    available: true, level: 'warn', result: 'offline', rebootRequired: false,
    daysSinceCheck: 0, daysSincePatched: 40, unpatched: true, silent: false,
    packages: ['openssl', 'libc6'], message: 'Could not resolve deb.debian.org',
    checkedAt: '2026-11-17T03:30:00.000Z', lastOkAt: '2026-10-08T03:30:00.000Z',
  };
  const view = createHealth(base({ osUpdate: () => unpatched }))();

  assert.equal(view.status, 'warn');
  assert.deepEqual(view.warnings, ['os-unpatched']);
  assert.equal(view.osUpdate.daysSincePatched, 40);

  // Package names and apt's message say which versions are on the card. They
  // stay on the dashboard, behind the login.
  assert.equal('packages' in view.osUpdate, false);
  assert.equal('message' in view.osUpdate, false);
  const json = JSON.stringify(view);
  assert.equal(json.includes('openssl'), false);
  assert.equal(json.includes('deb.debian.org'), false);
});

test('a silent nightly update is a warning too', () => {
  const view = createHealth(base({
    osUpdate: () => ({ available: true, level: 'warn', result: 'ok', silent: true, unpatched: false, daysSinceCheck: 9 }),
  }))();
  assert.deepEqual(view.warnings, ['os-unpatched']);
});

test('the view is cached, so an open route cannot be made to hammer the card', () => {
  let statfsCalls = 0;
  let screenCalls = 0;
  let clock = 1000;
  const health = createHealth(base({
    cacheMs: 5000,
    now: () => clock,
    statfs: (dir) => { statfsCalls += 1; return fakeStatfs(32, 10)(dir); },
    screens: () => { screenCalls += 1; return { total: 1, online: 1 }; },
  }));

  health(); health(); health();
  assert.equal(statfsCalls, 1);
  assert.equal(screenCalls, 1);

  clock += 5001;
  health();
  assert.equal(statfsCalls, 2);
  assert.equal(screenCalls, 2);
});
