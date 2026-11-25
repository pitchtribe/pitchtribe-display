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
const { createHealth, DISK_WARN_PERCENT, MEMORY_WARN_PERCENT } = require('../lib/health');

/** A statfs that reports a card of `totalGb` with `usedPercent` of it gone. */
const fakeStatfs = (totalGb, usedPercent) => () => {
  const bsize = 4096;
  const blocks = Math.round((totalGb * 1024 ** 3) / bsize);
  return { bsize, blocks, bavail: Math.round(blocks * (1 - usedPercent / 100)), bfree: 0 };
};

/* Memory is injected for the same reason statfs is. Reading the real host's
   free memory here would make every assertion about `warnings` an assertion
   about the machine the suite runs on: empty on an idle CI runner, holding
   `memory-low` on a busy laptop, with nothing in this repo having changed. */
const fakeMeminfo = (totalGb, usedPercent) => () => {
  const totalBytes = totalGb * 1024 ** 3;
  return { totalBytes, availableBytes: Math.round(totalBytes * (1 - usedPercent / 100)) };
};

const base = (over = {}) => ({
  version: '9.9.9',
  dataDir: os.tmpdir(),
  screens: () => ({ total: 0, online: 0 }),
  osUpdate: () => ({ available: false }),
  cacheMs: 0,
  statfs: fakeStatfs(32, 10),
  meminfo: fakeMeminfo(4, 40),
  ...over,
});

/** createApp options for a card that is healthy in every way this route reads. */
const healthyCard = (over = {}) => ({
  log: () => {},
  statfs: fakeStatfs(32, 10),
  meminfo: fakeMeminfo(4, 40),
  ...over,
});

test('healthz: the liveness contract the kiosk depends on', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchtribe-health-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const ctx = createApp(healthyCard({ dataDir }));
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
  const ctx = createApp(healthyCard({ dataDir }));
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
  assert.equal(full.ok, true);
  assert.ok(full.disk.freeBytes > 0);
  assert.equal(full.disk.usedPercent, DISK_WARN_PERCENT + 5);
});

/* The one above proves the *body* is right on a full card. It cannot prove the
   route is, because it never goes through Express and so cannot see a status
   code at all — and the status code is the thing at risk. Making the route 503
   when degraded is a one-line change that looks like a fix, and with only the
   tests above it passes: the healthy-card test asserts 200 but never degrades,
   and this one degrades but never asks Express. So this test is the pin: the
   real route, a full card, and the status code asserted together. */
test('healthz: the route itself keeps its 200 on a card that is nearly full', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchtribe-health-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const ctx = createApp(healthyCard({ dataDir, statfs: fakeStatfs(32, DISK_WARN_PERCENT + 5) }));
  t.after(ctx.close);
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });

  const res = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
  const body = await res.json();

  // deploy/kiosk.sh gates the browser on `curl -fsS` of this route, which fails
  // on any non-2xx. It does carry on after ~60s regardless, so a 503 here is a
  // minute of black screen on every screen in the club after every power cut,
  // not a permanent blackout — still a warning causing its own small outage.
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);

  // The degradation is reported, just not by failing.
  assert.equal(body.status, 'warn');
  assert.deepEqual(body.warnings, ['disk-low']);
  assert.equal(body.disk.usedPercent, DISK_WARN_PERCENT + 5);
});

test('a card with no statfs reports no disk rather than guessing', () => {
  const view = createHealth(base({ statfs: () => { throw new Error('ENOSYS'); } }))();
  assert.equal(view.disk, null);
  assert.equal(view.status, 'ok'); // unknown is not a fault
  assert.equal(view.ok, true);
});

/* `memory-low` had no test of its own, which is how the ambient read above
   survived: every other test asserted `warnings` was empty, so on a roomy
   runner the warning simply never appeared and nothing noticed it could not be
   exercised. A leak over six days is the failure the soak exists to catch, so
   the threshold it fires at is worth pinning in both directions. */
test('memory: warns when a card can no longer allocate, and not before', () => {
  const roomy = createHealth(base({ meminfo: fakeMeminfo(4, MEMORY_WARN_PERCENT - 5) }))();
  assert.equal(roomy.status, 'ok');
  assert.deepEqual(roomy.warnings, []);

  const tight = createHealth(base({ meminfo: fakeMeminfo(4, MEMORY_WARN_PERCENT + 5) }))();
  assert.equal(tight.status, 'warn');
  assert.deepEqual(tight.warnings, ['memory-low']);
  // Degraded, never down: the kiosk gates the browser on this route.
  assert.equal(tight.ok, true);
  assert.equal(tight.memory.usedPercent, MEMORY_WARN_PERCENT + 5);
});

test('a card that cannot report its memory says nothing rather than guessing', () => {
  const view = createHealth(base({ meminfo: () => ({ totalBytes: 0, availableBytes: 0 }) }))();
  assert.equal(view.memory, null);
  assert.equal(view.status, 'ok'); // unknown is not a fault, as with disk
  assert.equal(view.ok, true);
});

test('OS updates: warns when patching has stopped, without saying how far behind', () => {
  const unpatched = {
    available: true, level: 'warn', result: 'offline', rebootRequired: false,
    daysSinceCheck: 0, daysSincePatched: 40, unpatched: true, silent: false,
    packages: ['openssl', 'libc6'], message: 'Could not resolve deb.debian.org',
    checkedAt: '2026-11-17T03:30:00.000Z', lastOkAt: '2026-10-08T03:30:00.000Z',
  };
  const view = createHealth(base({ osUpdate: () => unpatched }))();

  // A watcher learns that something is wrong...
  assert.equal(view.status, 'warn');
  assert.deepEqual(view.warnings, ['os-unpatched']);

  // ...and nothing more than that. This is an allowlist of two fields, so a
  // field added to os-update.js cannot start appearing here by itself.
  assert.deepEqual(view.osUpdate, { available: true, rebootRequired: false });

  // Package names and apt's message say which versions are on the card.
  // The day counts say which card in a fleet is worth an attacker's time.
  // Both stay on the dashboard, behind the login. health.js says why.
  // (Checked by name, not by value: a day count like `40` would match the
  // digits of some byte count or uptime and pass for the wrong reason.)
  for (const gone of ['packages', 'message', 'daysSincePatched', 'daysSinceCheck', 'unpatched', 'silent', 'result', 'level']) {
    assert.equal(gone in view.osUpdate, false, `/healthz must not carry osUpdate.${gone}`);
  }
  const json = JSON.stringify(view);
  for (const text of ['openssl', 'libc6', 'deb.debian.org', '2026-10-08']) {
    assert.equal(json.includes(text), false, `/healthz must not carry ${text}`);
  }
});

test('a pending reboot is reported, because an operator acts on it', () => {
  const view = createHealth(base({
    osUpdate: () => ({ available: true, level: 'due', result: 'ok', rebootRequired: true, unpatched: false, silent: false, daysSincePatched: 0 }),
  }))();
  assert.deepEqual(view.osUpdate, { available: true, rebootRequired: true });
  // Not a warning: a reboot pending since last night's update would otherwise
  // page somebody nightly, and `warnings` has to stay worth waking up for.
  assert.deepEqual(view.warnings, []);
  assert.equal(view.status, 'ok');
});

test('a silent nightly update is a warning too', () => {
  const view = createHealth(base({
    osUpdate: () => ({ available: true, level: 'warn', result: 'ok', silent: true, unpatched: false, daysSinceCheck: 9 }),
  }))();
  assert.deepEqual(view.warnings, ['os-unpatched']);
  assert.equal(JSON.stringify(view).includes('silent'), false);
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
