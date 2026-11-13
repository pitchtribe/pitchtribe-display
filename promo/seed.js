#!/usr/bin/env node
'use strict';
/* Builds the "Promo reel" demo content for the fictional club named in club.js
   (Upper Caldecote FC) on a running PitchTribe instance, through the same HTTP
   API the dashboard uses.

   Usage:
     cd app && DATA_DIR=/tmp/promo-data PORT=8090 npm start     (in another shell)
     cd promo && BASE=http://127.0.0.1:8090 node seed.js

   Env:
     BASE       instance URL                      default http://127.0.0.1:8090
     PASSWORD   dashboard password (created on first run)   default promo-reel-2026

   Idempotent: re-running updates the same named items instead of duplicating
   them. Writes out/seed.json with the ids the capture script needs. */

const fs = require('node:fs');
const path = require('node:path');

const BASE = (process.env.BASE || 'http://127.0.0.1:8090').replace(/\/$/, '');
const PASSWORD = process.env.PASSWORD || 'promo-reel-2026';
const { CLUB, SHORT, CREST_FILE, crestSvg } = require('./club');
const OUT_DIR = path.join(__dirname, 'out');
const CREST_PATH = path.join(__dirname, 'crest', CREST_FILE);

// ------------------------------------------------------------------ content
// Everything below is invented for the film. No real club, player or venue.

const NOTICES = {
  'Promo — Opening': {
    style: 'default', // "Navy" in the dashboard
    title: 'Your club’s screens, working for you.',
    body: '',
  },
  'Promo — Quiz night': {
    style: 'accent', // "Pitch green"
    title: 'QUIZ NIGHT',
    body: 'Thursday 8pm. Teams of six.\n£2 a head, all to the junior section.',
  },
  'Promo — Promise': {
    style: 'accent',
    title: 'Open source. Free forever.',
    body: 'No monthly fees.',
  },
  'Promo — Get started': {
    style: 'light',
    title: 'pitchtribe.media',
    body: 'Get started free.',
  },
};

// Four fixtures: two already played (they hide themselves on screen), then the
// next match with the countdown, then one more. Saturdays in 2026.
const FIXTURES = [
  `2026-10-31 15:00 | ${SHORT} v Netherby Athletic | League | Home`,
  `2026-11-07 14:00 | Carrow Heath v ${SHORT} | County Cup | Away`,
  `2026-11-14 15:00 | ${SHORT} v Hollin Moor Town | League | Home`,
  `2026-11-21 14:30 | Ravensmere United v ${SHORT} | League | Away`,
].join('\n');

const MENU = [
  '# BAR',
  'Pint | £4.20',
  'Half | £2.20',
  'Soft drinks | £1.50',
  '# KITCHEN',
  'Pie and peas | £5.00',
  'Chips | £2.50',
  'Hot dog | £3.50 | | sold out',
].join('\n');

const TICKER = 'PitchTribe runs on a £175 Raspberry Pi 5. Manage it from any phone. pitchtribe.media';

// Silent loop running order and per-item seconds (storyboard, "Silent loop").
const REEL = [
  ['Promo — Opening', 4],
  ['Promo — Quiz night', 4],
  ['Promo — Fixtures', 4],
  ['Promo — Bar & Kitchen', 4],
  ['Promo — Live scores', 4],
  ['Promo — Weather', 4],
  ['Promo — Promise', 3],
  ['Promo — Get started', 3],
];

// A second, everyday playlist for the "phone" act: explicit 10 s items so the
// seconds field reads "10" before it is changed to "15".
const CLUBHOUSE = [
  ['Promo — Bar & Kitchen', 10],
  ['Promo — Quiz night', 10],
  ['Promo — Fixtures', 10],
  ['Promo — Weather', 10],
  ['Promo — Live scores', 10],
];

// A real TfL bus stop (Brixton area) so the arrivals board is live without a
// key. The heading shown on screen is the custom one below.
const BUS_STOP = { id: '490000266G', name: 'Buses from the ground' };

// Weather for "the ground": Open-Meteo, no key. Upper Caldecote, Bedfordshire.
const WEATHER = { place: SHORT, latitude: 52.08, longitude: -0.29, windUnit: 'mph', provider: 'openmeteo' };

const PORTAL = {
  ssid: `${SHORT} Guest`,
  headline: 'Welcome to {club}',
  message: 'Free Wi-Fi for members, players and visitors.\n\nEnjoy the game, and mind the language near the junior section.',
  accent: '#157a3b',
  sessionMinutes: 120,
  collectEmail: 'off',
  enabled: false, // branding only; the radio needs the Pi add-on
};

// ------------------------------------------------------------------- client
let cookie = '';

async function call(method, url, body, extraHeaders = {}) {
  const headers = { 'x-pitchtribe': '1', cookie, ...extraHeaders };
  let payload = body;
  if (body && !(body instanceof Uint8Array) && typeof body !== 'string') {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${json && json.error ? json.error : text.slice(0, 200)}`);
  return json;
}
const get = (u) => call('GET', u);
const post = (u, b) => call('POST', u, b);
const put = (u, b) => call('PUT', u, b);
const patch = (u, b) => call('PATCH', u, b);

async function signIn() {
  const status = await get('/api/auth/status');
  if (status.setupRequired) {
    await post('/api/auth/setup', { clubName: CLUB, password: PASSWORD });
    console.log(`Created the dashboard for ${CLUB}`);
  } else {
    await post('/api/auth/login', { password: PASSWORD });
  }
  if (!cookie) throw new Error('No session cookie after sign-in');
}

/** Create or update a text asset by name. */
async function upsertAsset(state, type, name, fields) {
  const existing = state.assets.find((a) => a.name === name && a.type === type);
  if (existing) {
    const a = await patch(`/api/assets/${existing.id}`, { name, ...fields });
    return a;
  }
  return post('/api/assets', { type, name, ...fields });
}

async function upsertPlaylist(state, name, fields) {
  const existing = state.playlists.find((p) => p.name === name);
  if (existing) return put(`/api/playlists/${existing.id}`, { name, ...fields });
  const created = await post('/api/playlists', { name, showClock: fields.showClock, ticker: fields.ticker });
  return put(`/api/playlists/${created.id}`, { name, ...fields });
}

/** Write the crest from club.js (so its text follows CLUB) and upload it. */
async function uploadCrest(state) {
  const svg = crestSvg();
  fs.mkdirSync(path.dirname(CREST_PATH), { recursive: true });
  if (!fs.existsSync(CREST_PATH) || fs.readFileSync(CREST_PATH, 'utf8') !== svg) {
    fs.writeFileSync(CREST_PATH, svg);
    console.log(`Wrote ${path.relative(process.cwd(), CREST_PATH)}`);
  }
  const name = `${SHORT} crest`;
  const existing = state.assets.find((a) => a.name === name && a.type === 'image');
  if (existing) return existing;
  return call('POST', '/api/assets/upload', new Uint8Array(Buffer.from(svg)), {
    'content-type': 'image/svg+xml',
    'x-filename': encodeURIComponent(`${name}.svg`),
  });
}

/** Register a screen the way a TV does (first manifest fetch), then name it. */
async function ensureScreen(id, { name, playlistId, rotation }) {
  await fetch(`${BASE}/api/player/${id}/manifest?w=1920&h=1080`);
  return patch(`/api/screens/${id}`, { name, playlistId, rotation });
}

async function main() {
  await signIn();
  let state = await get('/api/state');

  // Settings: club name, sports feeds, weather.
  await put('/api/settings', { clubName: CLUB, defaultPlaylistId: state.settings.defaultPlaylistId, language: 'en' });
  const catalog = state.sports.catalog.map((l) => l.key);
  const leagues = ['eng.1', 'eng.2', 'sco.1'].filter((k) => catalog.includes(k));
  await put('/api/settings/sports', { enabled: true, leagues, timezone: 'Europe/London' });
  await put('/api/settings/widgets', { weather: WEATHER, wikipedia: true, trains: {}, bods: {} });
  console.log(`Sports feeds on: ${leagues.join(', ')}. Weather: ${WEATHER.place}.`);

  const crest = await uploadCrest(state);

  // Content library.
  const assets = {};
  for (const [name, n] of Object.entries(NOTICES)) {
    assets[name] = await upsertAsset(state, 'notice', name, { content: { title: n.title, body: n.body, style: n.style } });
  }
  assets['Promo — Fixtures'] = await upsertAsset(state, 'fixtures', 'Promo — Fixtures', {
    content: { title: 'Fixtures', text: FIXTURES, limit: 8 },
  });
  assets['Promo — Bar & Kitchen'] = await upsertAsset(state, 'menu', 'Promo — Bar & Kitchen', {
    content: { title: 'Bar & Kitchen', text: MENU },
  });
  assets['Promo — Live scores'] = await upsertAsset(state, 'scores', 'Promo — Live scores', {
    content: { title: 'Live scores', leagues: [], show: 'all', limit: 8 },
  });
  assets['Promo — Weather'] = await upsertAsset(state, 'widget', 'Promo — Weather', {
    content: { kind: 'weather', title: '', days: 3 },
  });
  assets['Promo — Buses'] = await upsertAsset(state, 'widget', 'Promo — Buses', {
    content: { kind: 'transport', title: 'Getting home', sections: ['buses'], busStop: BUS_STOP.id, busStopName: BUS_STOP.name },
  });
  assets['Promo — Quiz'] = await upsertAsset(state, 'widget', 'Promo — Quiz', {
    content: { kind: 'quiz', title: '', topic: 'sport', source: 'bundled' },
  });
  console.log(`Content: ${Object.keys(assets).length} items + crest`);

  const items = (rows) => rows.map(([name, duration]) => ({ assetId: assets[name].id, enabled: true, duration }));
  const reel = await upsertPlaylist(state, 'Promo reel', { showClock: true, ticker: TICKER, items: items(REEL) });
  const clubhouse = await upsertPlaylist(state, 'Clubhouse TV', { showClock: true, ticker: '', items: items(CLUBHOUSE) });
  await put('/api/settings', { clubName: CLUB, defaultPlaylistId: reel.id, language: 'en' });
  console.log(`Playlists: "Promo reel" ${reel.id} (default), "Clubhouse TV" ${clubhouse.id}`);

  // Screens: a landscape bar TV and the portrait screen for the vertical cut.
  await ensureScreen('bar-tv', { name: 'Bar TV', playlistId: clubhouse.id, rotation: 0 });
  await ensureScreen('promo-portrait', { name: 'Entrance (portrait)', playlistId: reel.id, rotation: 90 });

  // Guest Wi-Fi branding.
  await put('/api/portal', { ...PORTAL, logoAssetId: crest.id });
  console.log('Wi-Fi portal branded with the crest');

  // Ask the engine for scores now rather than at its next tick.
  await post('/api/sports/refresh').catch((err) => console.warn('Sports refresh:', err.message));

  state = await get('/api/state');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = {
    base: BASE,
    club: CLUB,
    playlists: { reel: reel.id, clubhouse: clubhouse.id },
    screens: { landscape: 'bar-tv', portrait: 'promo-portrait' },
    assets: Object.fromEntries(Object.entries(assets).map(([k, a]) => [k, a.id])),
    crestAssetId: crest.id,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'seed.json'), JSON.stringify(out, null, 2));
  console.log(`Wrote ${path.relative(process.cwd(), path.join(OUT_DIR, 'seed.json'))}`);
  console.log(`Dashboard: ${BASE}/admin/  password: ${PASSWORD}`);
  console.log(`Preview:   ${BASE}/player/?preview=${reel.id}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
