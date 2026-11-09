'use strict';
/* The player API has no login — a screen is just a browser on the club's
   network. So anything it hands out without asking has to be bounded, or one
   script on that network leaves a clubhouse TV blank after the next reboot. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');
const { Hub } = require('../lib/hub');

const offline = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });

async function start(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-player-'));
  const ctx = createApp({ dataDir, sportsFetch: offline, feedsFetch: offline, log: () => {} });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { ctx.close(); server.closeAllConnections(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { ctx, base: `http://127.0.0.1:${server.address().port}` };
}

test('a flood of screen registrations cannot shut a real screen out', async (t) => {
  const { ctx, base } = await start(t);

  // 200 is the cap. Fill it with registrations that ask once and never return,
  // as a script would, and age them past the ten-minute grace period.
  const old = new Date(Date.now() - 20 * 60_000).toISOString();
  ctx.store.touch((d) => {
    for (let i = 0; i < 200; i += 1) {
      const id = `flood-${i}`;
      d.screens.push({ id, name: id, playlistId: null, rotation: 0, createdAt: old, lastSeen: Date.parse(old), fetches: 1 });
    }
  }, { immediate: true });
  assert.equal(ctx.store.data.screens.length, 200);

  // A genuine screen coming back after a reboot still gets in.
  const res = await fetch(`${base}/api/player/lounge-tv/manifest`);
  assert.equal(res.status, 200, 'without pruning this is 429 and the TV stays blank');
  assert.ok(ctx.store.data.screens.some((s) => s.id === 'lounge-tv'));
  assert.ok(ctx.store.data.screens.length < 200, 'the registrations that were never screens were dropped');
});

test('a screen the club is actually using is never pruned', async (t) => {
  const { ctx, base } = await start(t);
  const old = new Date(Date.now() - 20 * 60_000).toISOString();

  ctx.store.touch((d) => {
    // Renamed by a volunteer: adopted, however long it has been unplugged.
    d.screens.push({ id: 'bar-tv', name: 'Bar TV', playlistId: null, rotation: 0, createdAt: old, lastSeen: Date.parse(old), fetches: 1 });
    // Never renamed, but it has polled more than once: a real screen does.
    d.screens.push({ id: 'hall-tv', name: 'hall-tv', playlistId: null, rotation: 0, createdAt: old, lastSeen: Date.parse(old), fetches: 40 });
    for (let i = 0; i < 198; i += 1) {
      const id = `flood-${i}`;
      d.screens.push({ id, name: id, playlistId: null, rotation: 0, createdAt: old, lastSeen: Date.parse(old), fetches: 1 });
    }
  }, { immediate: true });

  assert.equal((await fetch(`${base}/api/player/new-tv/manifest`)).status, 200);
  const left = ctx.store.data.screens.map((s) => s.id);
  assert.ok(left.includes('bar-tv'), 'a renamed screen keeps its settings');
  assert.ok(left.includes('hall-tv'), 'so does one that has been polling');
  assert.ok(!left.includes('flood-0'));
});

test('SSE streams are capped per screen, per address and overall', () => {
  const hub = new Hub({ maxClients: 5, maxPerScreen: 2, maxPerIp: 3 });
  const fake = () => {
    const res = { writeHead() { return res; }, write() {}, end() {}, set() { return res; }, status() { return res; }, json() {} };
    return res;
  };
  const open = (screenId, ip) => hub.add({ ip, on() {} }, fake(), screenId);

  assert.ok(open('a', '10.0.0.1'));
  assert.ok(open('a', '10.0.0.1'));
  assert.equal(open('a', '10.0.0.1'), null, 'a third stream for one screen is refused');
  assert.ok(open('b', '10.0.0.1'));
  assert.equal(open('c', '10.0.0.1'), null, 'and a fourth from one address is refused');
  assert.ok(open('c', '10.0.0.2'), 'another screen on another address is fine');
  assert.ok(open('d', '10.0.0.3'));
  assert.equal(open('e', '10.0.0.4'), null, 'overall cap reached');
  hub.close();
});
