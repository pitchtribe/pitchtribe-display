import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchEspn, normalizeEspn, scoreboardMonths, scoreboardUrl } from '../src/sources/espn.js';
import { Store, sortEvents } from '../src/store.js';
import { renderDisplay } from '../src/render.js';
import { pushToTargets } from '../src/push.js';
import { createMcpHandler } from '../src/mcp.js';
import { createHttpServer } from '../src/http.js';

const here = dirname(fileURLToPath(import.meta.url));
const espnFixture = JSON.parse(readFileSync(resolve(here, 'fixtures/espn-eng1.json'), 'utf8'));
const quiet = () => {};

// The fixture is written around its live match (2026-11-03T20:00Z). Shift every date by the same
// amount so that match is "now": the store trims fixtures to config.daysBack/daysAhead, so a
// fixture pinned to fixed dates would fall out of the window as the real clock moves on.
function fixtureAroundNow(now = Date.now()) {
  const delta = now - Date.parse('2026-11-03T20:00Z');
  const shift = (iso) => new Date(Date.parse(iso) + delta).toISOString().replace('.000Z', 'Z');
  return {
    ...espnFixture,
    events: espnFixture.events.map((ev) => ({
      ...ev,
      date: shift(ev.date),
      competitions: (ev.competitions ?? []).map((c) => (c.date ? { ...c, date: shift(c.date) } : c)),
    })),
  };
}

const config = {
  title: 'Test Club', timezone: 'Europe/London', publicUrl: 'http://screen.test:8090',
  daysBack: 3, daysAhead: 7, rotateSeconds: 10, rowsPerPage: 10,
  refreshMinutes: 10, liveRefreshSeconds: 60, apiToken: 'sekrit',
  leagues: [
    { key: 'eng.1', source: 'espn', path: 'soccer/eng.1', name: 'Premier League' },
    { key: 'club', source: 'manual', file: resolve(here, '../data/club-fixtures.json'), name: 'Our Club' },
  ],
  pushTargets: [],
};

// Shifted once, so repeated refreshes see identical data and can detect "nothing changed".
const espnNow = fixtureAroundNow();

const fakeFetch = async (url) => {
  if (url.includes('/soccer/eng.1/')) return new Response(JSON.stringify(espnNow), { status: 200 });
  return new Response('nope', { status: 500 });
};

test('ESPN normalisation maps status, sides and scores', () => {
  const { events, name } = normalizeEspn(espnFixture, { key: 'eng.1', name: 'Premier League' });
  assert.equal(name, 'Premier League');
  const byId = Object.fromEntries(events.map((e) => [e.id, e]));
  assert.equal(byId['eng.1:1001'].status, 'final');
  assert.deepEqual([byId['eng.1:1001'].home.score, byId['eng.1:1001'].away.score], [2, 1]);
  assert.equal(byId['eng.1:1002'].status, 'live');
  assert.equal(byId['eng.1:1002'].home.name, 'Liverpool'); // home picked by homeAway, not order
  assert.equal(byId['eng.1:1003'].status, 'scheduled');
  assert.equal(byId['eng.1:1003'].home.score, null); // pre-match "0" hidden
  assert.equal(byId['eng.1:1004'].status, 'postponed');
});

test('scoreboard URL asks for a whole month (ESPN rejects day ranges)', () => {
  const url = scoreboardUrl({ path: 'soccer/eng.1' }, '202611');
  assert.match(url, /soccer\/eng\.1\/scoreboard\?dates=202611&limit=300$/);
});

test('scoreboard months cover the window, including across a month end', () => {
  const opts = { daysBack: 1, daysAhead: 2, now: new Date('2026-11-03T12:00Z') };
  assert.deepEqual(scoreboardMonths(opts), ['202611']);
  assert.deepEqual(scoreboardMonths({ ...opts, now: new Date('2026-11-30T12:00Z') }), ['202611', '202612']);
  assert.deepEqual(scoreboardMonths({ ...opts, now: new Date('2026-12-31T12:00Z') }), ['202612', '202701']);
});

test('fetchEspn trims a month of fixtures back to the configured window', async () => {
  const now = new Date('2026-11-15T12:00Z');
  const month = {
    leagues: [{ name: 'Premier League' }],
    events: [
      { id: '1', date: '2026-11-02T15:00Z', competitions: [{ competitors: [] }] }, // before the window
      { id: '2', date: '2026-11-14T15:00Z', competitions: [{ competitors: [] }] }, // inside
      { id: '3', date: '2026-11-20T15:00Z', competitions: [{ competitors: [] }] }, // inside
      { id: '4', date: '2026-11-29T15:00Z', competitions: [{ competitors: [] }] }, // after the window
    ],
  };
  const urls = [];
  const fetchImpl = (u) => {
    urls.push(u);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(month) });
  };
  const out = await fetchEspn({ key: 'eng.1', path: 'soccer/eng.1' }, { fetchImpl, daysBack: 3, daysAhead: 7, now });
  assert.deepEqual(urls, ['https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=202611&limit=300']);
  assert.deepEqual(out.events.map((e) => e.id), ['eng.1:2', 'eng.1:3']);
  assert.equal(out.name, 'Premier League');
});

test('fetchEspn fails the league when a month request fails', async () => {
  const fetchImpl = () => Promise.resolve({ ok: false, status: 400 });
  await assert.rejects(
    fetchEspn({ key: 'eng.1', path: 'soccer/eng.1' }, { fetchImpl, now: new Date('2026-11-15T12:00Z') }),
    /ESPN soccer\/eng\.1: HTTP 400/
  );
});

test('store refreshes, sorts, filters, keeps last good data on failure', async () => {
  let fail = false;
  const store = new Store(config, { fetchImpl: (u) => (fail ? Promise.reject(new Error('down')) : fakeFetch(u)), log: quiet });
  let updates = 0;
  store.on('update', () => updates++);
  const first = await store.refresh();
  assert.equal(first.changed, true);
  assert.equal(updates, 1);
  assert.equal(store.query({ status: 'live' }).length, 1);
  assert.equal(store.query({ team: 'arsenal' })[0].home.name, 'Arsenal');
  assert.equal(store.query({ league: 'club' }).length, 2);
  assert.deepEqual(store.snapshot().leagues[0].events.map((e) => e.status), ['live', 'final', 'scheduled', 'postponed']);
  assert.ok(store.hasLive());

  assert.equal((await store.refresh()).changed, false);
  fail = true;
  await store.refresh();
  const eng = store.snapshot().leagues.find((l) => l.key === 'eng.1');
  assert.equal(eng.error, 'down');
  assert.equal(eng.events.length, 4);
  assert.equal(updates, 1);
});

// Every ordering of the same events, so the assertion is about the order being total
// rather than about where one event landed from one starting arrangement.
function* permutations(items) {
  if (items.length <= 1) return yield items;
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

test('an unrecognised status cannot scramble the display order', () => {
  // STATUS_ORDER has four keys, so a fifth status value made one side of the subtraction
  // undefined — and a comparator that answers NaN leaves the whole order meaningless, not
  // just the one event misplaced. No source on main can emit a fifth value today; the next
  // source adapter is one typo away from it.
  const at = (hours) => new Date(Date.parse('2026-11-07T15:00:00Z') + hours * 3_600_000).toISOString();
  const events = [
    { id: 'live', status: 'live', start: at(0) },
    { id: 'result', status: 'final', start: at(-48) },
    { id: 'older-result', status: 'final', start: at(-72) },
    { id: 'fixture', status: 'scheduled', start: at(24) },
    { id: 'off', status: 'postponed', start: at(48) },
    { id: 'mystery', status: 'abandoned', start: at(-24) },
  ];
  const expected = ['live', 'result', 'older-result', 'fixture', 'off', 'mystery'];

  for (const input of permutations(events)) {
    assert.deepEqual(
      sortEvents(input).map((e) => e.id), expected,
      `order came out of the comparator differently for input ${input.map((e) => e.id).join(',')}`,
    );
  }
});

test('display page escapes team names and paginates', async () => {
  const store = new Store(config, { fetchImpl: fakeFetch, log: quiet });
  await store.refresh();
  const html = renderDisplay(store.snapshot(), { ...config, rowsPerPage: 2 });
  assert.ok(html.includes('Newcastle &lt;b&gt;'));
  assert.ok(!html.includes('Newcastle <b>'));
  assert.equal((html.match(/class="page"/g) || []).length, 3); // eng.1: 4 rows / 2 = 2 pages, club: 1
  assert.ok(html.includes('EventSource'));
  assert.ok(!renderDisplay(store.snapshot(), { live: false }).includes('EventSource'));
});

test('push posts JSON and HTML to targets and reports failures', async () => {
  const store = new Store(config, { fetchImpl: fakeFetch, log: quiet });
  await store.refresh();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response('', { status: url.includes('bad') ? 503 : 200 });
  };
  const results = await pushToTargets([
    { name: 'cms', url: 'https://cms.test/hook', format: 'json', leagues: ['club'], headers: { authorization: 'Bearer x' } },
    { name: 'html', url: 'https://screen.test/upload', format: 'html' },
    { name: 'broken', url: 'https://bad.test/' },
  ], store.snapshot(), config, { fetchImpl, log: quiet });
  assert.deepEqual(results.map((r) => r.ok), [true, true, false]);
  const json = JSON.parse(seen[0].init.body);
  assert.deepEqual(json.leagues.map((l) => l.key), ['club']);
  assert.equal(json.displayUrl, 'http://screen.test:8090/display?leagues=club');
  assert.equal(seen[0].init.headers.authorization, 'Bearer x');
  assert.match(seen[1].init.headers['content-type'], /text\/html/);
  assert.ok(seen[1].init.body.includes('Arsenal') && !seen[1].init.body.includes('EventSource'));
});

test('MCP handshake, tool listing and calls', async () => {
  const store = new Store(config, { fetchImpl: fakeFetch, log: quiet });
  const mcp = createMcpHandler({ store, config, push: async () => [] });
  const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.result.tools.some((t) => t.name === 'get_live_scores'));
  const live = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_live_scores', arguments: {} } });
  assert.match(live.result.content[0].text, /Liverpool 1-0 Manchester City/);
  const res = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_results', arguments: { team: 'chelsea' } } });
  assert.match(res.result.content[0].text, /Arsenal 2-1 Chelsea/);
  const url = await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_display_url', arguments: { leagues: 'eng.1', theme: 'light' } } });
  assert.equal(url.result.structuredContent.url, 'http://screen.test:8090/display?leagues=eng.1&theme=light');
  const bad = await mcp({ jsonrpc: '2.0', id: 6, method: 'nope' });
  assert.equal(bad.error.code, -32601);
});

test('HTTP API end-to-end', async (t) => {
  const store = new Store(config, { fetchImpl: fakeFetch, log: quiet });
  await store.refresh();
  const mcp = createMcpHandler({ store, config, push: async () => [] });
  const server = createHttpServer({ store, config, push: async () => [{ target: 'x', ok: true }], mcp, log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const display = await fetch(`${base}/display?leagues=eng.1&theme=light`);
  assert.equal(display.status, 200);
  const html = await display.text();
  assert.ok(html.includes('data-theme="light"') && html.includes('Premier League') && !html.includes('Our Club'));

  const events = await (await fetch(`${base}/api/events?status=final`)).json();
  assert.ok(events.every((e) => e.status === 'final') && events.length === 2);

  assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST' })).status, 401);
  const auth = { authorization: 'Bearer sekrit', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers: auth })).status, 200);

  const rpc = await fetch(`${base}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await rpc.json()).result.tools.length, 8);
  const note = await fetch(`${base}/mcp`, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);

  // SSE: an update event reaches connected screens.
  const ctrl = new AbortController();
  const stream = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  assert.match(text, /event: hello/);
  store.emit('update', store.snapshot());
  text = decoder.decode((await reader.read()).value);
  assert.match(text, /event: update/);
  ctrl.abort();
});

test('stdio MCP transport speaks line-delimited JSON-RPC', async () => {
  const child = spawn(process.execPath, [resolve(here, '../src/mcp-stdio.js')], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = [];
  const got = new Promise((ok) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const parts = buf.split('\n'); buf = parts.pop();
      lines.push(...parts.filter(Boolean).map((l) => JSON.parse(l)));
      if (lines.length >= 2) ok();
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  await got;
  child.kill();
  assert.equal(lines[0].result.serverInfo.name, 'pitchtribe-signage');
  assert.equal(lines[1].id, 2);
  assert.ok(lines[1].result.tools.length > 0);
});
