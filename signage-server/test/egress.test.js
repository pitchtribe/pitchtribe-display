// The Pi fetches feeds on the club's behalf, and it can see things the caller
// cannot: the router's admin page, a till, a camera recorder. These tests pin
// the two halves that stop that being a way in — no request may choose the
// address, and no address may point back into the club's own network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { blockedAddress, assertPublicUrl, createSafeFetch } from '../src/egress.js';
import { createWidgets } from '../src/widgets.js';
import { createRequestHandler } from '../src/http.js';

const quiet = () => {};
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const config = { timezone: 'Europe/London', weather: { place: 'Leeds', latitude: 53.8, longitude: -1.55 }, widgets: { wikipedia: false } };

test('private, loopback and metadata addresses are refused; public ones are not', () => {
  for (const ip of [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '172.16.5.4', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '192.0.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:192.168.0.1', '::ffff:127.0.0.1',
    'not-an-ip', '', null,
  ]) {
    assert.equal(blockedAddress(ip), true, `${ip} should be refused`);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.32.0.1', '192.167.1.1', '2606:4700::1111']) {
    assert.equal(blockedAddress(ip), false, `${ip} should be allowed`);
  }
});

test('assertPublicUrl: scheme, literal addresses, every DNS answer, and failure to resolve', async () => {
  await assert.rejects(() => assertPublicUrl('file:///etc/shadow', { lookup: publicLookup }), /not http or https/);
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1:35285/router-admin', { lookup: publicLookup }), /not a public address/);
  await assert.rejects(() => assertPublicUrl('http://[::1]/x', { lookup: publicLookup }), /not a public address/);

  // One private answer among several is enough to refuse the name.
  const mixed = async () => [{ address: '93.184.216.34' }, { address: '192.168.1.1' }];
  await assert.rejects(() => assertPublicUrl('https://sneaky.example/feed', { lookup: mixed }), /resolves to 192\.168\.1\.1/);

  // A name we cannot resolve is refused rather than handed to fetch unchecked.
  const nxdomain = async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }); };
  await assert.rejects(() => assertPublicUrl('https://gone.example/feed', { lookup: nxdomain }), /could not resolve/);

  const ok = await assertPublicUrl('https://club.example/news.rss', { lookup: publicLookup });
  assert.equal(ok.hostname, 'club.example');
});

test('safeFetch re-checks every redirect, so a public URL cannot bounce onto a private one', async () => {
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(url);
    if (url === 'https://club.example/feed') {
      return { ok: false, status: 302, headers: new Map([['location', 'http://192.168.1.1/admin']]) };
    }
    return { ok: true, status: 200, text: async () => 'body' };
  };
  const safeFetch = createSafeFetch({ fetchImpl, lookup: publicLookup });
  await assert.rejects(() => safeFetch('https://club.example/feed'), /192\.168\.1\.1 is not a public address/);
  assert.deepEqual(tried, ['https://club.example/feed'], 'the private hop was never fetched');

  // A redirect between public addresses is still followed.
  const hops = [];
  const twoStep = createSafeFetch({
    lookup: publicLookup,
    fetchImpl: async (url) => {
      hops.push(url);
      if (hops.length === 1) return { status: 301, headers: new Map([['location', '/moved']]) };
      return { ok: true, status: 200, text: async () => 'ok' };
    },
  });
  const res = await twoStep('https://club.example/feed');
  assert.equal(await res.text(), 'ok');
  assert.deepEqual(hops, ['https://club.example/feed', 'https://club.example/moved']);
});

test('a widget feed on the club network is refused even when an admin configured it', async () => {
  const w = createWidgets({
    config,
    fetchImpl: async () => { throw new Error('should never be fetched'); },
    log: quiet,
    lookup: publicLookup,
  });
  const out = await w.get('headlines', { url: 'http://192.168.1.1/feed.xml' });
  assert.match(out.error, /not a public address/, 'the admin-configured private address is refused, not fetched');
});

async function serve(t, { widgets, config: cfg }) {
  const store = { on() {}, snapshot: () => ({ leagues: [] }), updatedAt: null, hasLive: () => false, query: () => [] };
  const handler = createRequestHandler({ store, config: cfg, push: async () => [], mcp: async () => null, widgets, log: quiet });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { handler.close(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('a request cannot choose the address a widget fetches', async (t) => {
  const fetched = [];
  const widgets = createWidgets({
    config,
    log: quiet,
    lookup: publicLookup,
    fetchImpl: async (url) => { fetched.push(url); return { ok: true, status: 200, text: async () => '<rss><channel><title>X</title></channel></rss>' }; },
  });
  const base = await serve(t, { widgets, config: { ...config, apiToken: '' } });

  const res = await fetch(`${base}/api/widgets/headlines?url=http://127.0.0.1:35285/router-admin`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.error, /Add a feed address/, 'with no configured feed the widget asks for one instead of fetching');
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(fetched, [], 'nothing was fetched on the caller’s behalf');
});

test('widget and place-search routes need the token when one is set; the display page does not', async (t) => {
  const widgets = createWidgets({ config, log: quiet, lookup: publicLookup, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const base = await serve(t, { widgets, config: { ...config, apiToken: 'sports-token', title: 'Club', rotateSeconds: 10, rowsPerPage: 10 } });

  assert.equal((await fetch(`${base}/api/widgets/weather`)).status, 401);
  assert.equal((await fetch(`${base}/api/geocode?q=Leeds`)).status, 401);
  assert.equal((await fetch(`${base}/api/widgets/weather`, { headers: { authorization: 'Bearer sports-token' } })).status, 200);
  assert.equal((await fetch(`${base}/display`)).status, 200, 'screens still open the display page without a token');
  assert.equal((await fetch(`${base}/api/leagues`)).status, 200, 'public football scores stay open on the LAN');
});

test('responses carry no wildcard CORS header unless it is switched on', async (t) => {
  const widgets = createWidgets({ config, log: quiet, lookup: publicLookup, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const off = await serve(t, { widgets, config: { ...config, apiToken: '' } });
  const res = await fetch(`${off}/api/leagues`);
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'any page open on the club network could otherwise read this');

  const on = await serve(t, { widgets, config: { ...config, apiToken: '', cors: true } });
  assert.equal((await fetch(`${on}/api/leagues`)).headers.get('access-control-allow-origin'), '*');
});
