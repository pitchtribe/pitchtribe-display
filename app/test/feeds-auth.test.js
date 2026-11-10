'use strict';
/* The /feeds engine seen from the club's network, with no login.
 *
 * Football scores are public and screens open them directly, so those stay
 * open. Anything that makes the Pi fetch something does not: a Pi can reach the
 * club router's admin page, a till or a camera recorder, and whoever is asking
 * usually cannot. These tests pin that split, and that no request can choose
 * the address a widget fetches. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../lib/app');

const espnFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'signage-server', 'test', 'fixtures', 'espn-eng1.json'), 'utf8')
);

/** Stands in for something only the Pi can see — a router admin page. */
async function secretServer(t) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ title: 'INTERNAL-ROUTER-ADMIN', items: [{ title: 'admin password is hunter2' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { hits, url: `http://127.0.0.1:${server.address().port}/router-admin` };
}

async function start(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchtribe-feeds-'));
  const ctx = createApp({
    dataDir,
    maxUploadMb: 1,
    sportsFetch: async () => ({ ok: true, status: 200, json: async () => espnFixture }),
    log: () => {},
  });
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => {
    ctx.close();
    server.closeAllConnections();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pitchtribe': '1' },
    body: JSON.stringify({ clubName: 'Riverside FC', password: 'correct horse' }),
  });
  const cookie = (setup.headers.get('set-cookie') || '').split(';')[0];
  return { base, cookie };
}

test('the /feeds engine does not fetch an address a caller chose', async (t) => {
  const { base, cookie } = await start(t);
  const secret = await secretServer(t);

  // Unauthenticated: the route is closed outright.
  const anon = await fetch(`${base}/feeds/api/widgets/headlines?url=${encodeURIComponent(secret.url)}`);
  assert.equal(anon.status, 401, 'an open "fetch this for me" route turns the Pi into a way in');

  // The place search was an open outbound proxy too.
  assert.equal((await fetch(`${base}/feeds/api/geocode?q=Leeds`)).status, 401);

  // Logged in, the query parameter is still ignored rather than obeyed.
  const authed = await fetch(`${base}/feeds/api/widgets/headlines?url=${encodeURIComponent(secret.url)}`, {
    headers: { cookie, 'x-pitchtribe': '1' },
  });
  assert.equal(authed.status, 200);
  const body = await authed.json();
  assert.ok(!JSON.stringify(body).includes('hunter2'), 'the internal page must not come back in the response');

  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(secret.hits, [], 'the Pi made no request to the address in the query string');
});

test('public football stays open on the LAN, and carries no wildcard CORS header', async (t) => {
  const { base } = await start(t);

  const leagues = await fetch(`${base}/feeds/api/leagues`);
  assert.equal(leagues.status, 200, 'a club points a second screen at these');
  assert.equal(
    leagues.headers.get('access-control-allow-origin'),
    null,
    'otherwise any page open on the club network could read the API through a volunteer’s browser'
  );

  assert.equal((await fetch(`${base}/feeds/api/snapshot`)).status, 200);
  assert.equal((await fetch(`${base}/feeds/display`)).status, 200);
  assert.equal((await fetch(`${base}/feeds/api/widgets`)).status, 200, 'the widget catalogue is a static list');

  // Writes still need the token or a login.
  assert.equal((await fetch(`${base}/feeds/api/refresh`, { method: 'POST' })).status, 401);
});
