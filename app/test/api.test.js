'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');

const espnFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'signage-server', 'test', 'fixtures', 'espn-eng1.json'), 'utf8')
);
const fakeEspn = async (url) => {
  if (String(url).startsWith('https://api.open-meteo.com')) {
    return { ok: true, status: 200, json: async () => ({
      current: { temperature_2m: 8.4, weather_code: 2, wind_speed_10m: 12, is_day: 1 },
      daily: { time: ['2026-11-03', '2026-11-04'], weather_code: [2, 61], temperature_2m_max: [10, 9], temperature_2m_min: [4, 5], precipitation_probability_max: [10, 70] },
    }) };
  }
  return { ok: true, status: 200, json: async () => espnFixture };
};

async function startServer(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchtribe-test-'));
  const ctx = createApp({ dataDir, maxUploadMb: 1, sportsFetch: fakeEspn, log: () => {}, ...extra });
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function call(method, url, body, { headers = {}, raw = false } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        'x-pitchtribe': '1',
        ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  }
  const stop = () => {
    ctx.close();
    server.closeAllConnections();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { call, stop, ctx, base, dataDir, clearCookie: () => { cookie = ''; } };
}

test('first-run setup, login and auth guard', async (t) => {
  const s = await startServer();
  t.after(s.stop);

  let r = await s.call('GET', '/api/auth/status');
  assert.equal(r.body.setupRequired, true);

  r = await s.call('GET', '/api/state');
  assert.equal(r.status, 401);

  r = await s.call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'short' });
  assert.equal(r.status, 400);

  r = await s.call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });
  assert.equal(r.status, 200);

  r = await s.call('GET', '/api/state');
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.clubName, 'Riverside FC');
  assert.equal(r.body.playlists.length, 1, 'a starter playlist is created');
  assert.equal(r.body.assets[0].type, 'notice', 'with a welcome notice');
  assert.equal(r.body.settings.adminHash, undefined, 'secrets never leave the server');

  r = await s.call('POST', '/api/auth/setup', { clubName: 'Again', password: 'another password' });
  assert.equal(r.status, 409);

  // Mutations need the CSRF header.
  r = await s.call('POST', '/api/playlists', { name: 'X' }, { headers: { 'x-pitchtribe': '' } });
  assert.equal(r.status, 403);

  s.clearCookie();
  r = await s.call('POST', '/api/auth/login', { password: 'wrong password' });
  assert.equal(r.status, 401);
  r = await s.call('POST', '/api/auth/login', { password: 'correct horse' });
  assert.equal(r.status, 200);
  r = await s.call('GET', '/api/state');
  assert.equal(r.status, 200);
});

test('content, playlists, timings and the screen manifest', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  await s.call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });
  const playlistId = (await s.call('GET', '/api/state')).body.playlists[0].id;

  // Upload an image (raw body).
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  let r = await s.call('POST', '/api/assets/upload', png, {
    raw: true,
    headers: { 'content-type': 'image/png', 'x-filename': encodeURIComponent('Club crest.png') },
  });
  assert.equal(r.status, 201);
  const image = r.body;
  assert.equal(image.type, 'image');
  assert.equal(image.name, 'Club crest');
  assert.equal(image.duration, 10);

  // Uploaded media is served with a sandboxing CSP.
  r = await s.call('GET', image.src);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /sandbox/);

  // Unsupported upload types are refused.
  r = await s.call('POST', '/api/assets/upload', 'hello', { raw: true, headers: { 'content-type': 'text/html' } });
  assert.equal(r.status, 415);

  // Oversized uploads are refused (limit is 1 MB in tests).
  r = await s.call('POST', '/api/assets/upload', Buffer.alloc(1024 * 1024 + 10), { raw: true, headers: { 'content-type': 'image/png' } });
  assert.equal(r.status, 413);

  // Text content types.
  r = await s.call('POST', '/api/assets', { type: 'menu', name: 'Bar menu', content: { title: 'Bar', text: '# Draught\nLager | £4.50' }, addToPlaylist: playlistId });
  assert.equal(r.status, 201);
  const menu = r.body;
  r = await s.call('POST', '/api/assets', { type: 'url', name: 'Bad', url: 'javascript:alert(1)' });
  assert.equal(r.status, 400);
  r = await s.call('POST', '/api/assets', { type: 'notice', name: 'Empty' });
  assert.equal(r.status, 400);

  // Build the playlist: image (lunchtime only), menu (disabled).
  r = await s.call('GET', '/api/state');
  const pl = r.body.playlists[0];
  assert.equal(pl.items.length, 2, 'menu was added to the playlist on create');
  r = await s.call('PUT', `/api/playlists/${pl.id}`, {
    ...pl,
    ticker: 'Bar open from 12:00',
    items: [
      ...pl.items,
      { assetId: image.id, enabled: true, duration: 7, schedule: { days: [1, 2, 3, 4, 5], startTime: '12:00', endTime: '14:00' } },
      { assetId: 'does-not-exist', enabled: true },
    ].map((it) => (it.assetId === menu.id ? { ...it, enabled: false } : it)),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 3, 'unknown assets are dropped');
  assert.deepEqual(r.body.items[2].schedule, { startDate: '', endDate: '', days: [1, 2, 3, 4, 5], startTime: '12:00', endTime: '14:00' });

  r = await s.call('PUT', `/api/playlists/${pl.id}`, { items: [{ assetId: image.id, schedule: { startDate: '2026-12-01', endDate: '2026-11-01' } }] });
  assert.equal(r.status, 400, 'end date before start date');

  // A screen registers itself on first contact and gets the default playlist.
  r = await s.call('GET', '/api/player/bar-tv/manifest?w=1920&h=1080');
  assert.equal(r.status, 200);
  assert.equal(r.body.screen.id, 'bar-tv');
  assert.equal(r.body.playlist.ticker, 'Bar open from 12:00');
  assert.deepEqual(r.body.items.map((i) => i.type), ['notice', 'image'], 'disabled items are not sent');
  assert.equal(r.body.items[1].duration, 7, 'per-item duration overrides the default');

  r = await s.call('GET', '/api/player/bad id!/manifest');
  assert.equal(r.status, 400);

  r = await s.call('GET', '/api/state');
  const screen = r.body.screens.find((x) => x.id === 'bar-tv');
  assert.equal(screen.resolution, '1920×1080');
  assert.equal(screen.online, true);

  // Rename + rotate the screen, unassign its playlist.
  r = await s.call('PATCH', '/api/screens/bar-tv', { name: 'Bar TV', rotation: 90, playlistId: '' });
  assert.equal(r.body.name, 'Bar TV');
  assert.equal(r.body.rotation, 90);
  r = await s.call('GET', '/api/player/bar-tv/manifest');
  assert.equal(r.body.playlist, null);
  assert.equal(r.body.items.length, 0);

  // Deleting content removes it from playlists and disk.
  const mediaFile = path.join(s.ctx.dataDir, 'media', path.basename(image.src));
  assert.ok(fs.existsSync(mediaFile));
  r = await s.call('DELETE', `/api/assets/${image.id}`);
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(mediaFile));
  r = await s.call('GET', '/api/state');
  assert.ok(r.body.playlists.every((p) => p.items.every((it) => it.assetId !== image.id)));

  // Preview needs a login.
  r = await s.call('GET', `/api/preview/${pl.id}/manifest`);
  assert.equal(r.status, 200);
  s.clearCookie();
  r = await s.call('GET', `/api/preview/${pl.id}/manifest`);
  assert.equal(r.status, 401);
});

test('screens receive a push when content changes', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  await s.call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });
  await s.call('GET', '/api/player/lounge/manifest');

  const ac = new AbortController();
  t.after(() => ac.abort());
  const res = await fetch(`${s.base}/api/player/lounge/events`, { signal: ac.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let r = await s.call('GET', '/api/state');
  assert.equal(r.body.screens[0].online, true);

  await s.call('POST', '/api/assets', { type: 'notice', name: 'Hello', content: { title: 'Hello' } });
  let text = '';
  while (!text.includes('event: changed')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  assert.match(text, /event: changed/);

  r = await s.call('POST', '/api/screens/lounge/command', { command: 'identify' });
  assert.equal(r.body.delivered, 1);
  r = await s.call('POST', '/api/screens/lounge/command', { command: 'format-disk' });
  assert.equal(r.status, 400);
});

test('sports engine runs inside the app: settings, /feeds routes, MCP auth, live-score slides', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  await s.call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });
  await s.ctx.sports.ready;

  let r = await s.call('GET', '/api/state');
  assert.equal(r.body.sports.enabled, false);
  assert.ok(r.body.sports.catalog.some((l) => l.key === 'eng.1'), 'league catalogue comes from signage-server');
  assert.ok(!r.body.sports.catalog.some((l) => l.key === 'club'), 'manual club league is not offered');
  const token = r.body.sports.apiToken;
  assert.ok(token.length >= 24);

  r = await s.call('GET', '/feeds/api/leagues');
  assert.deepEqual(r.body, [], 'no leagues until sports are switched on');

  r = await s.call('PUT', '/api/settings/sports', { enabled: true, leagues: ['eng.1', 'not-a-league'], timezone: 'Europe/London' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.leagues, ['eng.1']);
  assert.equal(r.body.running, true);
  r = await s.call('PUT', '/api/settings/sports', { enabled: true, leagues: ['eng.1'], timezone: 'Mars/Olympus' });
  assert.equal(r.status, 400);

  r = await s.call('POST', '/api/sports/refresh', {});
  assert.equal(r.status, 200);
  assert.ok(r.body.status[0].events > 0);

  // The engine's own routes, served by the app.
  r = await s.call('GET', '/feeds/api/health');
  assert.equal(r.body.ok, true);
  r = await s.call('GET', '/feeds/display');
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.body, /new EventSource\('api\/stream'\)/, 'stream URL is relative so it works under /feeds');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self' 'unsafe-inline'/);

  // MCP needs the token (or a dashboard session).
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  s.clearCookie();
  r = await s.call('POST', '/feeds/mcp', rpc, { headers: { 'x-pitchtribe': '' } });
  assert.equal(r.status, 401);
  r = await s.call('POST', '/feeds/mcp', rpc, { headers: { authorization: `Bearer ${token}`, 'x-pitchtribe': '' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.result.tools.some((tool) => tool.name === 'get_live_scores'));
  await s.call('POST', '/api/auth/login', { password: 'correct horse' });

  // A "Live scores" slide carries the data in the screen manifest.
  r = await s.call('POST', '/api/assets', {
    type: 'scores', name: 'Premier League', content: { title: 'Premier League', leagues: ['eng.1', '<bad>'], show: 'all', limit: 5 },
    addToPlaylist: (await s.call('GET', '/api/state')).body.playlists[0].id,
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.content.leagues, ['eng.1']);
  r = await s.call('GET', '/api/player/bar-tv/manifest');
  const slide = r.body.items.find((i) => i.type === 'scores');
  assert.ok(slide.data.length > 0 && slide.data.length <= 5);
  assert.ok(slide.data[0].home.name && 'score' in slide.data[0].home);

  // Score changes are pushed to screens.
  let pushed = 0;
  const orig = s.ctx.hub.broadcast.bind(s.ctx.hub);
  s.ctx.hub.broadcast = (event, data) => { if (data && data.feeds) pushed += 1; return orig(event, data); };
  s.ctx.feeds.emit('update', 'sports');
  assert.equal(pushed, 1);

  // Switching off removes the data and the routes.
  await s.call('PUT', '/api/settings/sports', { enabled: false, leagues: ['eng.1'] });
  r = await s.call('GET', '/api/player/bar-tv/manifest');
  assert.equal(r.body.items.find((i) => i.type === 'scores').data, null);
  r = await s.call('GET', '/feeds/api/leagues');
  assert.deepEqual(r.body, []);
});

test('widgets: settings, every kind in manifests, spot-the-ball answer stays secret until reveal', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  await s.call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });
  await s.ctx.feeds.ready;
  const playlistId = (await s.call('GET', '/api/state')).body.playlists[0].id;

  let r = await s.call('GET', '/api/state');
  assert.ok(r.body.widgets.kinds.some((k) => k.kind === 'quiz'));
  assert.equal(r.body.widgets.weather, null);

  r = await s.call('PUT', '/api/settings/widgets', { weather: { place: 'Leeds', latitude: 53.8, longitude: 'x' } });
  assert.equal(r.status, 400);
  r = await s.call('PUT', '/api/settings/widgets', { weather: { place: 'Leeds', latitude: 53.8, longitude: -1.55, provider: 'openmeteo' }, wikipedia: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.weather.windUnit, 'mph');

  const add = (content, extra = {}) => s.call('POST', '/api/assets', { type: 'widget', name: content.kind, content, addToPlaylist: playlistId, ...extra });
  for (const content of [
    { kind: 'clock', mode: 'analog' },
    { kind: 'weather', days: 2 },
    { kind: 'joke' },
    { kind: 'phrase', extra: 'Up the Riversiders!', only: true },
    { kind: 'trivia' },
    { kind: 'quiz' },
    { kind: 'history', scope: 'week' },
  ]) {
    r = await add(content);
    assert.equal(r.status, 201, `${content.kind}: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await add({ kind: 'clock', mode: 'countdown' })).status, 400, 'countdown needs a target');
  assert.equal((await add({ kind: 'phrase', only: true })).status, 400);
  assert.equal((await add({ kind: 'lottery' })).status, 400);
  r = await add({ kind: 'quiz' });
  assert.equal(r.body.duration, 20, 'per-widget default duration');

  // Spot the ball needs a photo from the library.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const photo = (await s.call('POST', '/api/assets/upload', png, { raw: true, headers: { 'content-type': 'image/png' } })).body;
  assert.equal((await add({ kind: 'spotball', imageId: photo.id })).status, 400, 'ball position required');
  const later = (await add({ kind: 'spotball', imageId: photo.id, x: 42.5, y: 61, revealAt: '2099-01-01T12:00', prize: '£20 bar tab' })).body;
  const past = (await add({ kind: 'spotball', imageId: photo.id, x: 95, y: 99, revealAt: '2020-01-01T12:00', cover: false })).body;

  // Manifest: every widget carries its data.
  await s.ctx.feeds.service.widgets.get('weather', { days: 2 });
  r = await s.call('GET', '/api/player/bar-tv/manifest');
  const byName = (n) => r.body.items.filter((i) => i.type === 'widget' && i.content.kind === n);
  assert.equal(byName('clock')[0].data, undefined);
  assert.equal(byName('weather')[0].data.place, 'Leeds');
  assert.equal(byName('weather')[0].data.days.length, 2, 'as many days as the forecast returned');
  assert.ok(byName('joke')[0].data.items[0].a);
  assert.deepEqual(byName('phrase')[0].data.items, ['Up the Riversiders!']);
  assert.ok(byName('quiz')[0].data.items.length >= 20);
  assert.ok(byName('history')[0].data.items.length > 0);

  const hidden = r.body.items.find((i) => i.assetId === later.id).data;
  assert.equal(hidden.revealed, false);
  assert.equal(hidden.answer, null);
  assert.ok(!JSON.stringify(hidden).includes('42.5'), 'exact answer not sent before reveal');
  assert.ok(hidden.patch && Math.abs(hidden.patch.x - 42.5) <= 6 * 0.4 && hidden.patch.r > 6, 'blur patch covers the ball area');
  assert.equal(hidden.src, photo.src);
  const shown = r.body.items.find((i) => i.assetId === past.id).data;
  assert.deepEqual(shown.answer, { x: 95, y: 99, cell: 'J8' });
  assert.equal(shown.patch, null);

  // Deleting the photo leaves a clear message instead of a broken slide.
  await s.call('DELETE', `/api/assets/${photo.id}`);
  r = await s.call('GET', '/api/player/bar-tv/manifest');
  assert.match(r.body.items.find((i) => i.assetId === later.id).data.error, /deleted/);

  // Widget data is also on the engine's public API.
  r = await s.call('GET', '/feeds/api/widgets/trivia');
  assert.equal(r.body.items.length, 20);
});

test('culture widgets: topics, emoji quiz, flags & capitals, country of the day, world clocks', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  await s.call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });
  await s.ctx.feeds.ready;
  const playlistId = (await s.call('GET', '/api/state')).body.playlists[0].id;
  const add = (content) => s.call('POST', '/api/assets', { type: 'widget', name: content.kind, content, addToPlaylist: playlistId });

  let r = await add({ kind: 'quiz', topic: 'music' });
  assert.equal(r.body.content.topic, 'music');
  r = await add({ kind: 'trivia', topic: 'nonsense' });
  assert.equal(r.body.content.topic, 'sport', 'unknown topic falls back');
  r = await add({ kind: 'history', scope: 'month', topic: 'entertainment' });
  assert.equal(r.body.content.topic, 'entertainment');
  assert.equal((await add({ kind: 'emoji', category: 'Film' })).status, 201);
  assert.equal((await add({ kind: 'geoquiz', mode: 'flags' })).status, 201);
  assert.equal((await add({ kind: 'country' })).status, 201);
  r = await add({ kind: 'worldclock', zones: [{ label: 'Tokyo', tz: 'Asia/Tokyo' }, { label: 'New York', tz: 'America/New_York' }] });
  assert.equal(r.status, 201);
  assert.equal((await add({ kind: 'worldclock', zones: [{ label: 'Nowhere', tz: 'Mars/Base' }] })).status, 400);
  assert.equal((await add({ kind: 'worldclock', zones: [] })).status, 400);

  r = await s.call('GET', '/api/player/bar-tv/manifest');
  const w = (kind) => r.body.items.find((i) => i.type === 'widget' && i.content.kind === kind);
  assert.equal(w('quiz').data.topic, 'music');
  assert.ok(w('quiz').data.items.every((q) => q.topic === 'music'));
  assert.ok(w('history').data.items.every((i) => i.tag === 'entertainment'));
  assert.ok(w('emoji').data.items.every((e) => e.category === 'Film'));
  assert.ok(w('geoquiz').data.items.every((q) => q.flag && q.q.includes('flag')));
  assert.ok(w('country').data.items[0].capital);
  assert.equal(w('worldclock').data, undefined, 'world clocks are drawn by the screen');
  assert.deepEqual(w('worldclock').content.zones.map((z) => z.tz), ['Asia/Tokyo', 'America/New_York']);
});

test('data-source widgets and transport hub: validation, options reach the engine, keys stay server-side', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  await s.call('POST', '/api/auth/setup', { clubName: 'Biggleswade Town', password: 'correct horse' });
  await s.ctx.feeds.ready;
  const playlistId = (await s.call('GET', '/api/state')).body.playlists[0].id;
  const add = (content) => s.call('POST', '/api/assets', { type: 'widget', name: content.kind, content, addToPlaylist: playlistId });

  let r = await s.call('PUT', '/api/settings/widgets', {
    weather: { place: 'Biggleswade', latitude: 52.087, longitude: -0.264 },
    trains: { url: 'https://rail.example', token: 'rail-secret' },
    bods: { apiKey: 'bods-secret' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.weather.provider, 'metno', 'MET Norway is the default (commercial use allowed)');
  assert.equal(r.body.bods.apiKey, 'bods-secret', 'admins can see their keys');

  // Transport hub validation
  assert.equal((await add({ kind: 'transport', sections: [] })).status, 400);
  assert.equal((await add({ kind: 'transport', sections: ['trains'] })).status, 400, 'station code needed');
  assert.equal((await add({ kind: 'transport', sections: ['tracker'] })).status, 400, 'route numbers needed');
  r = await add({ kind: 'transport', sections: ['tracker', 'trains', 'planes'], station: 'biw', trackLines: '73, 74 188', trackTitle: 'Buses to Bedford' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.content.trackLines, ['73', '74', '188']);
  assert.equal(r.body.content.station, 'BIW');

  for (const content of [
    { kind: 'bankholiday', division: 'scotland' },
    { kind: 'floods', radius: 10 },
    { kind: 'carbon', postcode: 'sg18' },
    { kind: 'quakes', feed: 'significant_week' },
    { kind: 'currency', base: 'GBP', symbols: ['EUR', 'USD', 'GBP', 'XXX'] },
    { kind: 'potd' },
    { kind: 'births' },
    { kind: 'sky' },
    { kind: 'headlines', url: 'https://club.example/news.rss' },
    { kind: 'events', url: 'webcal://club.example/fixtures.ics' },
    { kind: 'quiz', topic: 'music', source: 'opentdb' },
  ]) {
    r = await add(content);
    assert.equal(r.status, 201, `${content.kind}: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await add({ kind: 'carbon', postcode: 'not a postcode' })).status, 400);
  assert.equal((await add({ kind: 'headlines', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await add({ kind: 'currency', symbols: ['XXX'] })).status, 400);

  const st = (await s.call('GET', '/api/state')).body;
  const byKind = (k) => st.assets.find((a) => a.content?.kind === k).content;
  assert.deepEqual(byKind('currency').symbols, ['EUR', 'USD']);
  assert.equal(byKind('carbon').postcode, 'SG18');
  assert.equal(byKind('events').url, 'https://club.example/fixtures.ics');

  r = await s.call('GET', '/api/player/clubhouse/manifest');
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes('rail-secret') && !raw.includes('bods-secret'), 'API keys never reach screens');
  const w = (k) => r.body.items.find((i) => i.type === 'widget' && i.content.kind === k);
  assert.equal(w('sky').data.place, 'Biggleswade');
  assert.match(w('sky').data.sunrise, /^\d\d:\d\d$/);
  assert.deepEqual(w('transport').data.sections.map((x) => x.key), ['tracker', 'trains', 'planes']);
  assert.equal(w('transport').data.sections[0].title, 'Bus tracker');
});

test('screen language: club default, per-screen override, validation', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  await s.call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });
  let r = await s.call('GET', '/api/state');
  assert.equal(r.body.settings.language, 'en');
  assert.ok(r.body.languages.some((l) => l.code === 'ja' && l.name === '日本語'));
  r = await s.call('GET', '/api/player/bar-tv/manifest');
  assert.equal(r.body.language, 'en');

  await s.call('PUT', '/api/settings', { clubName: 'Riverside FC', language: 'fr' });
  r = await s.call('GET', '/api/player/bar-tv/manifest');
  assert.equal(r.body.language, 'fr', 'club default');
  await s.call('PATCH', '/api/screens/bar-tv', { language: 'pl' });
  r = await s.call('GET', '/api/player/bar-tv/manifest');
  assert.equal(r.body.language, 'pl', 'per-screen override');
  await s.call('PATCH', '/api/screens/bar-tv', { language: '' });
  assert.equal((await s.call('GET', '/api/player/bar-tv/manifest')).body.language, 'fr', 'back to club default');
  await s.call('PUT', '/api/settings', { clubName: 'Riverside FC', language: 'klingon' });
  assert.equal((await s.call('GET', '/api/state')).body.settings.language, 'en', 'unknown codes fall back to English');
});

test('Settings → About: the nightly OS update reaches the dashboard', async (t) => {
  // The root helper's status file is the only record of whether the card is
  // patched, and it took SSH to read it. The judgements it carries are tested
  // in os-updates.test.js; this is the wire between the two.
  const s = await startServer();
  t.after(s.stop);
  await s.call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });

  // A dashboard that isn't on a Pi (or a card whose first night hasn't come
  // round) says nothing rather than looking broken.
  assert.deepEqual((await s.call('GET', '/api/state')).body.osUpdate, { available: false });

  fs.writeFileSync(path.join(s.dataDir, 'os-update-status.json'), JSON.stringify({
    checkedAt: new Date(Date.now() - 3600_000).toISOString(),
    lastOkAt: new Date(Date.now() - 3600_000).toISOString(),
    result: 'ok',
    upgraded: 1,
    packages: ['linux-image-rpi-v8'],
    rebootRequired: true,
    message: 'installed 1 update(s)',
  }));
  const u = (await s.call('GET', '/api/state')).body.osUpdate;
  assert.equal(u.available, true);
  assert.equal(u.upgraded, 1);
  assert.equal(u.rebootRequired, true, 'the restart nobody would otherwise hear about');
  assert.equal(u.level, 'due');
  assert.equal(u.silent, false);
});

test('guest wi-fi: the dashboard says whether this Pi can actually broadcast it', async (t) => {
  // Saving guest Wi-Fi settings on a Pi without the helper looks exactly like
  // success, and the club waits for a network that never appears. The settings
  // still save — they are kept for when it is installed — but the dashboard has
  // to be able to tell the difference, so it reports it.
  const missing = await startServer({ portalApplyBin: path.join(os.tmpdir(), 'pitchtribe-no-such-helper') });
  t.after(missing.stop);
  await missing.call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });

  let r = await missing.call('GET', '/api/portal');
  assert.equal(r.status, 200);
  assert.equal(r.body.installed, false);
  assert.equal(r.body.settings.enabled, false, 'guest Wi-Fi is off until the club switches it on');

  r = await missing.call('PUT', '/api/portal', { enabled: true, ssid: 'Riverside Guest', radio: 'builtin' });
  assert.equal(r.status, 200, 'the settings are still saved, ready for the helper');
  assert.equal(r.body.settings.radio, 'builtin');
  assert.equal((await missing.call('GET', '/api/portal')).body.installed, false);

  // The helper writes the settings file this hands it; it must appear, or
  // nothing applies them even once the helper is there.
  const net = JSON.parse(fs.readFileSync(path.join(missing.dataDir, 'portal-network.json'), 'utf8'));
  assert.equal(net.enabled, true);
  assert.equal(net.radio, 'builtin');
  assert.equal(net.ssid, 'Riverside Guest');

  const present = await startServer({ portalApplyBin: __filename }); // any file that exists
  t.after(present.stop);
  await present.call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });
  assert.equal((await present.call('GET', '/api/portal')).body.installed, true);
});

test('every language has every label', () => {
  const { STRINGS, LANGUAGES } = require('../public/shared/i18n.js');
  const keys = Object.keys(STRINGS.en);
  for (const { code } of LANGUAGES) {
    const missing = keys.filter((k) => !(k in STRINGS[code]));
    assert.deepEqual(missing, [], `${code} is missing labels`);
    for (const k of keys) {
      const placeholders = (STRINGS.en[k].match(/\{\w+\}/g) || []).sort();
      assert.deepEqual((STRINGS[code][k].match(/\{\w+\}/g) || []).sort(), placeholders, `${code}.${k} keeps its placeholders`);
    }
  }
});
