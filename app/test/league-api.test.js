'use strict';
/* League slides embed someone else's HTML, pasted by a volunteer, and serve it
   from the Pi's own origin for a screen that has no login. These tests pin the
   two things that makes safe: the dashboard refuses a paste that is not a
   Full-Time snippet, and the panel route re-checks the stored snippet and sends
   it sandboxed rather than trusting db.json. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');

const offline = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });

const SNIPPET = '<div id="lrep567300589"></div><script src="https://fulltime.thefa.com/client/api/cs1/567300589.js"></script>';

async function start(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-league-'));
  const ctx = createApp({ dataDir, sportsFetch: offline, feedsFetch: offline, log: () => {} });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { ctx.close(); server.closeAllConnections(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { 'x-pitchtribe': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  }
  await call('POST', '/api/auth/setup', { clubName: 'Riverside FC', password: 'correct horse' });
  return { ctx, base, call };
}

test('a league slide takes Full-Time snippets and refuses anything else', async (t) => {
  const { call } = await start(t);

  let r = await call('POST', '/api/assets', {
    type: 'league',
    name: 'County League',
    content: {
      title: 'Bedfordshire County League',
      panels: [{ label: 'Table', snippet: SNIPPET }, { label: 'Results', snippet: SNIPPET }],
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.content.panels.length, 2);
  assert.equal(r.body.content.zoom, 0, 'fit the panel by default');
  assert.equal(r.body.content.credit, 'Data from The FA Full-Time');
  assert.equal(r.body.duration, 25);

  // Another origin, an event handler, and a paste with nothing to load.
  for (const snippet of [
    '<script src="https://evil.test/x.js"></script>',
    '<div id="a" onclick="fetch(\'/api/state\')"></div><script src="https://fulltime.thefa.com/x.js"></script>',
    '<div id="lrep1"></div>',
  ]) {
    r = await call('POST', '/api/assets', { type: 'league', name: 'Bad', content: { panels: [{ label: 'Table', snippet }] } });
    assert.equal(r.status, 400, snippet);
  }

  // A slide with no snippet at all is not a slide.
  r = await call('POST', '/api/assets', { type: 'league', name: 'Empty', content: { panels: [] } });
  assert.equal(r.status, 400);
});

test('a panel is served sandboxed, with no login, and only for a panel that exists', async (t) => {
  const { call, base } = await start(t);
  const created = await call('POST', '/api/assets', {
    type: 'league',
    name: 'County League',
    content: { panels: [{ label: 'Table', snippet: SNIPPET }] },
  });
  const id = created.body.id;

  // No cookie: a screen is just a browser on the club network.
  const res = await fetch(`${base}/league/${id}/0`);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /sandbox allow-scripts/, 'Full-Time runs in an opaque origin');
  assert.ok(!/allow-same-origin/.test(csp), 'and never reaches the dashboard cookie');
  assert.match(csp, /script-src https:\/\/thefa\.com https:\/\/\*\.thefa\.com/);
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.text();
  assert.match(body, /fulltime\.thefa\.com\/client\/api\/cs1\/567300589\.js/);

  for (const url of [`/league/${id}/1`, `/league/${id}/-1`, `/league/${id}/x`, '/league/nope/0']) {
    assert.equal((await fetch(base + url)).status, 404, url);
  }
});

test('a snippet smuggled into db.json by hand is still not served', async (t) => {
  const { ctx, call, base } = await start(t);
  const created = await call('POST', '/api/assets', {
    type: 'league',
    name: 'County League',
    content: { panels: [{ label: 'Table', snippet: SNIPPET }] },
  });
  const id = created.body.id;

  ctx.store.mutate((d) => {
    d.assets.find((a) => a.id === id).content.panels[0].snippet = '<script src="https://evil.test/steal.js"></script>';
  });

  const res = await fetch(`${base}/league/${id}/0`);
  assert.equal(res.status, 422, 'the route parses the snippet again rather than trusting the file');
  assert.ok(!(await res.text()).includes('evil.test'));
});

test('a league slide reaches a screen with the panels it needs to build', async (t) => {
  const { ctx, call, base } = await start(t);
  const created = await call('POST', '/api/assets', {
    type: 'league',
    name: 'County League',
    content: { title: 'Bedfordshire County League', panels: [{ label: 'Table', snippet: SNIPPET }] },
  });
  const playlist = ctx.store.data.playlists[0];
  await call('PUT', `/api/playlists/${playlist.id}`, {
    name: playlist.name,
    items: [{ assetId: created.body.id, enabled: true }],
  });

  const manifest = await (await fetch(`${base}/api/player/bar-tv/manifest`)).json();
  const item = manifest.items.find((i) => i.type === 'league');
  assert.ok(item, 'the slide is in the manifest');
  assert.equal(item.content.panels.length, 1);
  assert.equal(item.content.title, 'Bedfordshire County League');
  assert.ok(item.assetId, 'the player builds /league/<assetId>/<n> from this');
});
