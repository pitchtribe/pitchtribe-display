import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createWidgets, sample, describeWeather } from '../src/widgets.js';
import { createRequestHandler } from '../src/http.js';
import { createMcpHandler } from '../src/mcp.js';

const quiet = () => {};
const config = { timezone: 'Europe/London', weather: { place: 'Leeds', latitude: 53.8, longitude: -1.55, provider: 'openmeteo' }, widgets: { wikipedia: true } };
// Outbound widget fetches resolve the address and refuse private ones, so the
// stubbed network here needs a stub resolver too; otherwise these tests would
// depend on DNS.
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

const openMeteo = {
  current: { temperature_2m: 11.6, weather_code: 61, wind_speed_10m: 9.2, is_day: 1 },
  daily: {
    time: ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'],
    weather_code: [61, 3, 0, 80],
    temperature_2m_max: [12.1, 10.4, 9.8, 11],
    temperature_2m_min: [6.2, 4.9, 2.1, 5.5],
    precipitation_probability_max: [80, 20, 5, 60],
  },
};
const wiki = { selected: [{ text: 'Something happened.', year: 1903 }, { text: 'Another thing.', year: 1957 }] };
function fakeFetch(calls = []) {
  return async (url) => {
    calls.push(url);
    if (url.includes('geocoding-api')) return { ok: true, status: 200, json: async () => ({ results: [{ name: 'Leeds', admin1: 'England', country: 'United Kingdom', latitude: 53.8, longitude: -1.55 }] }) };
    if (url.startsWith('https://api.open-meteo.com')) return { ok: true, status: 200, json: async () => openMeteo };
    if (url.includes('onthisday')) return { ok: true, status: 200, json: async () => wiki };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('bundled packs: day-stable selection, club extras first', () => {
  const w = createWidgets({ config, fetchImpl: fakeFetch(), log: quiet, lookup });
  const now = new Date('2026-11-03T12:00:00Z');
  const a = w.peek('joke', {}, now);
  const b = w.peek('joke', {}, new Date('2026-11-03T20:00:00Z'));
  assert.equal(a.items.length, 20);
  assert.deepEqual(a.items, b.items, 'same jokes all day');
  assert.notDeepEqual(a.items, w.peek('joke', {}, new Date('2026-11-04T12:00:00Z')).items, 'new selection tomorrow');
  assert.ok(a.items.every((j) => j.q && j.a));

  const mine = w.peek('phrase', { extra: 'Up the Riversiders!\n\nBar open till late', only: true }, now);
  assert.deepEqual(mine.items, ['Up the Riversiders!', 'Bar open till late']);

  const quiz = w.peek('quiz', { extra: 'Club founded? | 1889 | 1901 | 1923 | 1950' }, now);
  const q0 = quiz.items[0];
  assert.equal(q0.q, 'Club founded?');
  assert.equal(q0.options[q0.answer], '1889');
  assert.ok(quiz.items.every((q) => q.options[q.answer] !== undefined));
});

test('sporting history: day, widening to week/month, Wikipedia extras', async () => {
  const calls = [];
  const w = createWidgets({ config, fetchImpl: fakeFetch(calls), log: quiet, lookup });
  // 30 July: England 1966.
  const d = w.peek('history', { scope: 'day' }, new Date('2026-07-30T12:00:00Z'));
  assert.equal(d.scopeUsed, 'day');
  assert.ok(d.items.some((i) => i.year === 1966));
  // 3 Jan has no entry: widens to the month (January), which has the first Super Bowl.
  const jan = w.peek('history', { scope: 'day' }, new Date('2026-01-03T12:00:00Z'));
  assert.equal(jan.scopeUsed, 'month');
  assert.ok(jan.items.some((i) => i.year === 1967));
  const month = w.peek('history', { scope: 'month', limit: 3 }, new Date('2026-07-10T12:00:00Z'));
  assert.equal(month.items.length, 3);
  assert.ok(month.items.every((i) => i.date.startsWith('07-')));

  const g = await w.get('history', { scope: 'day', general: true }, new Date('2026-07-30T12:00:00Z'));
  assert.ok(calls.some((u) => u.includes('/onthisday/selected/07/30')));
  assert.ok(g.items.some((i) => i.sport === false && i.text === 'Something happened.'));
});

test('weather: live fetch, caching, update event, offline fallback', async () => {
  const calls = [];
  const w = createWidgets({ config, fetchImpl: fakeFetch(calls), log: quiet, lookup });
  let updates = 0;
  w.on('update', () => { updates += 1; });
  assert.match(w.peek('weather', { days: 3 }).error, /Loading/);
  const data = await w.get('weather', { days: 3 });
  assert.equal(data.place, 'Leeds');
  assert.equal(data.current.temp, 12);
  assert.equal(data.current.text, 'Light rain');
  assert.equal(data.days.length, 4);
  assert.equal(data.units.wind, 'mph');
  assert.equal(updates, 1);
  await w.get('weather', { days: 3 });
  assert.equal(calls.filter((u) => u.includes('open-meteo')).length, 1, 'cached for 15 minutes');

  const none = createWidgets({ config: { timezone: 'Europe/London' }, fetchImpl: fakeFetch(), log: quiet, lookup });
  assert.match(none.peek('weather').error, /No location/);
  const down = createWidgets({ config, fetchImpl: async () => { throw new Error('offline'); }, log: quiet, lookup });
  assert.match((await down.get('weather')).error, /unavailable/);

  assert.deepEqual(describeWeather(0, false), { text: 'Clear sky', icon: '🌙', cond: 'clear' });
  assert.deepEqual(await w.geocode('Leeds'), [{ name: 'Leeds', region: 'England, United Kingdom', latitude: 53.8, longitude: -1.55 }]);
});

test('sample() is deterministic and unbiased enough', () => {
  const list = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(sample(list, 10, 'x'), sample(list, 10, 'x'));
  assert.equal(new Set(sample(list, 10, 'y')).size, 10);
});

test('widget HTTP routes and MCP tool', async (t) => {
  const widgets = createWidgets({ config, fetchImpl: fakeFetch(), log: quiet, lookup });
  const store = { on() {}, snapshot: () => ({ leagues: [] }), updatedAt: null, hasLive: () => false };
  const mcp = createMcpHandler({ store, config, push: async () => [], widgets });
  const handler = createRequestHandler({ store, config, push: async () => [], mcp, widgets, log: quiet });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { handler.close(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const kinds = await (await fetch(`${base}/api/widgets`)).json();
  assert.ok(kinds.some((k) => k.kind === 'quiz'));
  const weather = await (await fetch(`${base}/api/widgets/weather?days=2`)).json();
  assert.equal(weather.days.length, 3);
  assert.equal((await fetch(`${base}/api/widgets/nope`)).status, 404);
  const places = await (await fetch(`${base}/api/geocode?q=Leeds`)).json();
  assert.equal(places[0].name, 'Leeds');

  const reply = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_widget', arguments: { kind: 'weather' } } });
  assert.match(reply.result.content[0].text, /Leeds: 12°C, Light rain/);
});

test('topics: film & TV, music, geography, culture and mixed packs', () => {
  const w = createWidgets({ config, fetchImpl: fakeFetch(), log: quiet, lookup });
  const now = new Date('2026-11-03T12:00:00Z');
  for (const topic of ['sport', 'film-tv', 'music', 'geography', 'culture']) {
    const quiz = w.peek('quiz', { topic }, now);
    assert.equal(quiz.topic, topic);
    assert.equal(quiz.items.length, 20, `${topic} quiz`);
    assert.ok(quiz.items.every((q) => q.options.length === 4 && q.options[q.answer] !== undefined), `${topic} answers valid`);
    const facts = w.peek('trivia', { topic }, now);
    assert.ok(facts.items.length >= 13 && facts.items.every((f) => typeof f === 'string' && f.length > 20), `${topic} trivia`);
  }
  const mixed = w.peek('quiz', { topic: 'mixed' }, now);
  assert.ok(new Set(mixed.items.map((q) => q.topic)).size >= 3, 'mixed draws from several topics');
  assert.notDeepEqual(w.peek('quiz', { topic: 'music' }, now).items, w.peek('quiz', { topic: 'culture' }, now).items);
  assert.equal(w.peek('quiz', { topic: 'nonsense' }, now).topic, 'sport', 'unknown topic falls back to sport');
});

test('history topics: sport, TV/film/music and both', () => {
  const w = createWidgets({ config, fetchImpl: fakeFetch(), log: quiet, lookup });
  const nov23 = new Date('2026-11-23T12:00:00Z'); // Doctor Who 1963
  const ent = w.peek('history', { scope: 'day', topic: 'entertainment' }, nov23);
  assert.equal(ent.scopeUsed, 'day');
  assert.ok(ent.items.some((i) => i.year === 1963 && /Doctor Who/.test(i.text)));
  assert.ok(ent.items.every((i) => i.tag === 'entertainment'));
  const both = w.peek('history', { scope: 'month', topic: 'all', limit: 12 }, nov23);
  assert.equal(both.label, 'November in history');
  assert.ok(both.items.some((i) => i.tag === 'sport') && both.items.some((i) => i.tag === 'entertainment'));
  assert.equal(w.peek('history', { scope: 'week', topic: 'entertainment' }, nov23).label, 'This week in TV, film & music');
});

test('emoji quiz, flags & capitals, country of the day', () => {
  const w = createWidgets({ config, fetchImpl: fakeFetch(), log: quiet, lookup });
  const now = new Date('2026-11-03T12:00:00Z');
  const emoji = w.peek('emoji', {}, now);
  assert.equal(emoji.items.length, 20);
  assert.ok(emoji.items.every((e) => e.emoji && e.answer && ['Film', 'TV', 'Song'].includes(e.category)));
  assert.ok(w.peek('emoji', { category: 'Song' }, now).items.every((e) => e.category === 'Song'));
  const mine = w.peek('emoji', { extra: '🏉🏆 | Rugby World Cup | Sport', only: true }, now);
  assert.deepEqual(mine.items, [{ emoji: '🏉🏆', answer: 'Rugby World Cup', category: 'Sport' }]);

  for (const mode of ['flags', 'capitals', 'mixed']) {
    const geo = w.peek('geoquiz', { mode }, now);
    assert.equal(geo.items.length, 20);
    for (const q of geo.items) {
      assert.equal(new Set(q.options).size, 4, 'four different options');
      assert.ok(q.options[q.answer] !== undefined);
      assert.match(q.flag, /^[\u{1F1E6}-\u{1F1FF}]{2}$/u);
    }
  }
  const caps = w.peek('geoquiz', { mode: 'capitals' }, now).items.filter((q) => q.q.startsWith('What is the capital'));
  assert.ok(caps.length > 10);
  assert.ok(!caps.some((q) => /South Africa|Indonesia/.test(q.q)), 'ambiguous capitals are not asked');

  const country = w.peek('country', {}, now);
  assert.equal(country.items.length, 20);
  assert.ok(country.items.every((c) => c.name && c.flag && c.capital && c.continent && c.currency));
  assert.deepEqual(w.peek('country', {}, new Date('2026-11-03T22:00:00Z')).items, country.items, 'stable all day');
});
