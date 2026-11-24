'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');
const { Store } = require('../lib/store');

test('old database loads with an empty music list collection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchtribe-music-migration-'));
  try {
    const file = path.join(dir, 'db.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, settings: {}, assets: [], playlists: [], screens: [] }));
    const store = new Store(file);
    assert.deepEqual(store.data.musicLists, []);
    assert.equal(store.data.schemaVersion, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('music lists persist, validate tracks, and appear in screen and preview manifests', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchtribe-music-api-'));
  const ctx = createApp({ dataDir: dir, log: () => {} });
  const server = await new Promise((resolve) => {
    const value = ctx.app.listen(0, '127.0.0.1', () => resolve(value));
  });
  t.after(() => { ctx.close(); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function call(method, url, body, type = 'application/json') {
    const response = await fetch(base + url, {
      method,
      headers: { 'x-pitchtribe': '1', ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': type }),
        ...(type === 'audio/mpeg' ? { 'x-filename': 'Track.mp3' } : {}) },
      body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body,
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: await response.json() };
  }
  await call('POST', '/api/auth/setup', { clubName: 'Test', password: 'correct horse' });
  const playlistId = (await call('GET', '/api/state')).body.playlists[0].id;
  const track = (await call('POST', '/api/assets/upload', Buffer.from('ID3\x04\x00\x00fake-mp3-data'), 'audio/mpeg')).body;
  const list = await call('POST', '/api/music-lists', { name: 'Matchday', tracks: [track.id], repeat: 'one' });
  assert.equal(list.status, 201);
  assert.equal((await call('PUT', `/api/music-lists/${list.body.id}`, { tracks: ['missing'] })).status, 400);
  assert.equal((await call('GET', '/api/state')).body.musicLists[0].tracks[0], track.id);
  assert.equal((await call('GET', `/api/preview/${playlistId}/manifest`)).body.music.tracks[0].src, track.src);
  await call('GET', '/api/player/bar/manifest');
  const screen = await call('PATCH', '/api/screens/bar', {
    musicListId: list.body.id, musicVolume: 35, musicEnabled: true,
    musicSchedule: { days: [1, 2], startTime: '09:00', endTime: '18:00' },
  });
  assert.equal(screen.status, 200);
  const manifest = (await call('GET', '/api/player/bar/manifest')).body;
  assert.equal(manifest.music.name, 'Matchday');
  assert.equal(manifest.music.volume, 35);
  assert.deepEqual(manifest.music.schedule.days, [1, 2]);
  assert.equal((await call('POST', '/api/screens/bar/command', { command: 'music', action: 'bad' })).status, 400);
  assert.equal((await call('POST', '/api/screens/bar/command', { command: 'music', action: 'next' })).status, 200);
  assert.equal((await call('GET', '/api/state')).body.musicLists[0].name, 'Matchday');
  await call('DELETE', `/api/assets/${track.id}`);
  assert.deepEqual((await call('GET', '/api/state')).body.musicLists[0].tracks, []);
  await call('DELETE', `/api/music-lists/${list.body.id}`);
  assert.equal((await call('GET', '/api/state')).body.screens[0].musicListId, null);
});
