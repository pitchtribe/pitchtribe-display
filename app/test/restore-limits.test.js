'use strict';
/* Restoring unpacks an archive onto the SD card, and on a freshly flashed card
   it needs no password. A .tar.gz of photos and video barely compresses; a file
   of zeros compresses a thousandfold. So without a bound a small upload fills
   the card — and a Pi behind a bar with a full root filesystem does not
   recover on its own. These tests pin the bound and, more importantly, that
   peak bytes written stay bounded however big the upload claims to be. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { tarChunks } = require('../lib/tar');
const { createApp } = require('../lib/app');

const offline = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });

async function start(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-restore-'));
  const ctx = createApp({ dataDir, sportsFetch: offline, feedsFetch: offline, log: () => {}, ...extra });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { ctx.close(); server.closeAllConnections(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, base: `http://127.0.0.1:${server.address().port}` };
}

/** A believable PitchTribe backup, except one entry is `mb` MiB of zeros. */
async function bomb(mb, { entry = 'media/filler.jpg' } = {}) {
  const db = { settings: { clubName: 'Attacker' }, assets: [], playlists: [], screens: [], revision: 1 };
  const chunks = [];
  const source = Readable.from(tarChunks([
    { name: 'manifest.json', buffer: Buffer.from('{"format":1}\n') },
    { name: 'db.json', buffer: Buffer.from(JSON.stringify(db)) },
    { name: entry, buffer: Buffer.alloc(mb * 1024 * 1024) },
  ]));
  const gzip = zlib.createGzip({ level: 9 });
  source.pipe(gzip);
  for await (const c of gzip) chunks.push(c);
  return Buffer.concat(chunks);
}

function bytesUnder(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += bytesUnder(p);
      else total += fs.statSync(p).size;
    } catch { /* being written or removed under us */ }
  }
  return total;
}

test('a gzip bomb is refused, and peak bytes written stay bounded', async (t) => {
  const cap = 2 * 1024 * 1024;
  const s = await start(t, { maxRestoreBytes: cap });
  const body = await bomb(48); // 48 MiB of zeros, about 48 KiB on the wire

  assert.ok(body.length < 256 * 1024, `the upload is small: ${body.length} bytes`);

  // Watch the data directory while the restore is in flight.
  let peak = 0;
  const watch = setInterval(() => { peak = Math.max(peak, bytesUnder(s.dataDir)); }, 4);
  const res = await fetch(`${s.base}/api/setup/restore-file`, {
    method: 'POST',
    headers: { 'x-pitchtribe': '1', 'content-type': 'application/gzip' },
    body,
  });
  clearInterval(watch);

  assert.equal(res.status, 413, 'refused at the cap');
  assert.match((await res.json()).error, /hasn’t room for it/);
  assert.ok(peak < cap + 1024 * 1024, `peak bytes written ${peak} stayed near the ${cap}-byte cap, not the 48 MiB the archive declared`);
  assert.deepEqual(
    fs.readdirSync(s.dataDir).filter((f) => f.startsWith('.restore-')),
    [],
    'and the half-unpacked attempt is cleaned up'
  );
});

test('an absurd expansion ratio is refused even when the card has room', async (t) => {
  const s = await start(t, { maxRestoreBytes: Infinity });
  const res = await fetch(`${s.base}/api/setup/restore-file`, {
    method: 'POST',
    headers: { 'x-pitchtribe': '1', 'content-type': 'application/gzip' },
    body: await bomb(80), // 80 MiB of zeros: past the floor, ~1000:1
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /isn’t a PitchTribe backup file/);
});

test('a single entry larger than an upload is refused from its tar header', async (t) => {
  const s = await start(t, { maxUploadMb: 1, maxRestoreBytes: Infinity });
  const res = await fetch(`${s.base}/api/setup/restore-file`, {
    method: 'POST',
    headers: { 'x-pitchtribe': '1', 'content-type': 'application/gzip' },
    body: await bomb(4),
  });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /photo or video in it that is too large/);
});

test('a real backup still restores, bounds and all', async (t) => {
  const from = await start(t);
  await fetch(`${from.base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pitchtribe': '1' },
    body: JSON.stringify({ clubName: 'Riverside FC', password: 'correct horse' }),
  });
  const authed = await fetch(`${from.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pitchtribe': '1' },
    body: JSON.stringify({ password: 'correct horse' }),
  });
  const session = (authed.headers.get('set-cookie') || '').split(';')[0];
  const file = await fetch(`${from.base}/api/backup/download`, { headers: { 'x-pitchtribe': '1', cookie: session } });
  assert.equal(file.status, 200);
  const archive = Buffer.from(await file.arrayBuffer());

  const onto = await start(t);
  const res = await fetch(`${onto.base}/api/setup/restore-file`, {
    method: 'POST',
    headers: { 'x-pitchtribe': '1', 'content-type': 'application/gzip' },
    body: archive,
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal((await res.json()).club, 'Riverside FC');
});
