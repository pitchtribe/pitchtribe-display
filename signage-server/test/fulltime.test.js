// The Full-Time source: the snippet feeds the club's own league issues to it.
//
// Nobody has handed us a real `lrcode` yet, so these tests cannot prove we parse the real
// feed. What they do prove is the part that does not depend on the payload format:
//
//   * one read a week per feed, and no more — the politeness the route decision was
//     bought with, enforced here rather than hoped for;
//   * a payload we do not recognise is refused outright, not half-read;
//   * British dates are read as British dates, and a row with no readable date is left
//     out and said out loud (trust rule 1);
//   * grassroots words — postponed, abandoned, waterlogged, walkover — land on the four
//     statuses the display sorts on, with the league's own wording kept (trust rule 3);
//   * a kick-off time the feed never published is never printed (trust rule 2);
//   * the table surviving a failed results feed, and vice versa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchFulltime, resetFulltimeCache, normalizeFeeds, feedUrl, parsePayload, tablesFromHtml,
  looksLikeStandings, rowsFrom, eventsFromRows, mergeEvents, standingsFromRows,
  parseFixtureDate, zonedToIso, readScore, pick,
} from '../src/sources/fulltime.js';
import { Store, sortEvents } from '../src/store.js';
import { buildClubhouse } from '../src/clubhouse.js';

const league = (over = {}) => ({
  key: 'club',
  name: 'Bedfordshire County League',
  source: 'fulltime',
  club: { name: 'Caldecote FC', aliases: [] },
  feeds: [{ code: '123457', kind: 'results', competition: 'Premier Division', team: 'First XI' }],
  ...over,
});

const feed = (over = {}) => ({ code: '1', kind: 'results', carries: 'events', team: '', competition: '', label: 'results/1', ...over });

/** A fetch that answers every request with one body, and counts the calls. */
function stubFetch(body, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'function' ? body(url) : body) };
  };
  impl.calls = calls;
  return impl;
}

// ------------------------------------------------------------------------- config → feeds

test('feeds: a snippet code and a kind, and a bad entry is named rather than guessed at', () => {
  const log = [];
  const feeds = normalizeFeeds({
    key: 'club',
    feeds: [
      { code: '123456', kind: 'table', competition: 'Premier Division' },
      { code: '', kind: 'results' },
      { code: '../etc/passwd', kind: 'results' },
      { code: '123459', kind: 'crystal-ball' },
      '123460',
    ],
  }, { log: (m) => log.push(m) });

  assert.deepEqual(feeds.map((f) => f.code), ['123456', '123460']);
  assert.equal(feeds[0].carries, 'standings');
  assert.equal(feeds[1].kind, 'results', 'a bare string is a results code');
  assert.equal(log.length, 3);
  assert.match(log[1], /not a snippet code/);
  assert.match(log[2], /unknown kind "crystal-ball"/);
});

test('the request is config, not a constant — a wrong guess is a config line, not a release', () => {
  assert.equal(feedUrl(feed({ code: '99' })), 'https://fulltime-league.thefa.com/client/api/cs1.js?lrcode=99');
  assert.equal(
    feedUrl(feed({ code: '99' }), { endpoint: 'https://example.test/feed?v=2', codeParam: 'id' }),
    'https://example.test/feed?v=2&id=99',
  );
  assert.equal(
    feedUrl(feed({ code: '99', kind: 'table' }), { urlTemplate: 'https://example.test/{kind}/{code}.json' }),
    'https://example.test/table/99.json',
  );
});

// ------------------------------------------------------------------------------- payloads

test('payloads: JSON, JSONP and an assignment all read; anything else is refused', () => {
  assert.equal(parsePayload('{"results":[]}').shape, 'json');
  assert.equal(parsePayload('[{"a":1}]').shape, 'json');
  assert.deepEqual(parsePayload('cb({"results":[{"a":1}]});').data, { results: [{ a: 1 }] });
  assert.equal(parsePayload('var lrfeed = {"results":[]};').shape, 'jsonp');
  assert.equal(parsePayload('<table><tr><th>Date</th></tr><tr><td>x</td></tr></table>').shape, 'html');

  // The one that matters: a login page, an error page or a changed format must not be
  // read as "no matches this week". It is an error, and the store keeps the last good data.
  assert.throws(() => parsePayload('<!DOCTYPE html><html><body>Sign in</body></html>'), /unrecognised payload/);
  assert.throws(() => parsePayload(''), /empty response/);
  assert.throws(() => parsePayload('{"results":'), /JSON/);
});

test('table markup: rows keyed by header, and a standings table told apart from a fixture list', () => {
  const html = `
    <table class="results">
      <tr><th>Date</th><th>Home</th><th>Score</th><th>Away</th></tr>
      <tr><td>07/11/2026</td><td>Caldecote FC</td><td>3 - 2</td><td>Cranfield United</td></tr>
      <tr><td></td><td></td><td></td><td></td></tr>
    </table>
    <table class="table">
      <tr><th>Pos</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>F</th><th>A</th><th>Pts</th></tr>
      <tr><td>3</td><td>Caldecote FC</td><td>11</td><td>7</td><td>2</td><td>2</td><td>25</td><td>14</td><td>23</td></tr>
    </table>`;
  const tables = tablesFromHtml(html);
  assert.equal(tables.length, 2, 'the empty row is dropped, both tables survive');
  assert.deepEqual(tables[0].rows[0], { date: '07/11/2026', home: 'Caldecote FC', score: '3 - 2', away: 'Cranfield United' });
  assert.equal(looksLikeStandings(tables[0].headers), false);
  assert.equal(looksLikeStandings(tables[1].headers), true);

  const parsed = parsePayload(html);
  assert.equal(rowsFrom(parsed, { standings: true })[0].pts, '23');
  assert.equal(rowsFrom(parsed, { standings: false })[0].away, 'Cranfield United');
});

test('rows come out of whatever the feed wrapped them in', () => {
  assert.equal(rowsFrom({ shape: 'json', data: { data: { results: [{ home: 'A' }] } } })[0].home, 'A');
  assert.equal(rowsFrom({ shape: 'json', data: [{ home: 'B' }] })[0].home, 'B');
  assert.deepEqual(rowsFrom({ shape: 'json', data: { meta: { count: 0 } } }), []);
  assert.equal(pick({ MatchDate: '07/11/2026' }, ['matchdate']), '07/11/2026');
  assert.equal(pick({ match_date: 'x', date: '' }, ['date', 'matchDate']), 'x', 'an empty field is not an answer');
});

// ----------------------------------------------------------------------------- the dates

test('07/11/2026 is the seventh of November — a British league writes the day first', () => {
  const { iso } = parseFixtureDate('07/11/2026', '14:00');
  assert.equal(iso, '2026-11-07T14:00:00.000Z');  // November: GMT, so the wall clock is UTC
  assert.equal(parseFixtureDate('7/3/26', '15:00').iso, '2026-03-07T15:00:00.000Z');
});

test('kick-off in British Summer Time is an hour earlier in UTC than it reads on the wall', () => {
  // A 15:00 August kick-off is 14:00Z. Get this wrong and every summer fixture is an hour out.
  assert.equal(parseFixtureDate('15/08/2026', '15:00').iso, '2026-08-15T14:00:00.000Z');
  assert.equal(zonedToIso({ year: 2026, month: 8, day: 15, hour: 15, minute: 0 }), '2026-08-15T14:00:00.000Z');
  assert.equal(zonedToIso({ year: 2026, month: 1, day: 15, hour: 15, minute: 0 }), '2026-01-15T15:00:00.000Z');
});

test('the shapes a league actually publishes, and the ones that are not a date at all', () => {
  assert.equal(parseFixtureDate('Sat 07/11/2026', '19.45').iso, '2026-11-07T19:45:00.000Z');
  assert.equal(parseFixtureDate('7 November 2026', '2.30pm').iso, '2026-11-07T14:30:00.000Z');
  assert.equal(parseFixtureDate('2026-11-07T14:00:00Z').iso, '2026-11-07T14:00:00.000Z');
  assert.equal(parseFixtureDate('2026-11-07 14:00').iso, '2026-11-07T14:00:00.000Z');
  assert.equal(parseFixtureDate('TBC', '14:00'), null);
  assert.equal(parseFixtureDate('32/13/2026', '14:00'), null);
  assert.equal(parseFixtureDate(''), null);
});

test('a kick-off nobody published is parked at midday and never printed as a time', () => {
  const when = parseFixtureDate('07/11/2026', '');
  assert.equal(when.kickoffKnown, false);
  assert.equal(when.iso, '2026-11-07T12:00:00.000Z', 'midday local, so no timezone can move the calendar day');
  assert.equal(parseFixtureDate('07/11/2026', '14:00').kickoffKnown, true);

  // Trust rule 2, all the way to the slide: the "next Saturday" card prints no time
  // rather than inventing 12:00.
  const events = eventsFromRows(
    [{ date: '14/11/2026', home: 'Shefford Town', away: 'Caldecote FC' }],
    feed({ kind: 'fixtures' }), league(),
  );
  const snapshot = { updatedAt: null, leagues: [{ key: 'club', name: 'L', events, standings: null, club: { name: 'Caldecote FC', aliases: [] } }] };
  const wall = buildClubhouse(snapshot, { clubhouse: { league: 'club', club: 'Caldecote FC' }, timezone: 'Europe/London' }, {
    now: new Date('2026-11-10T12:00:00Z'), photoFiles: [],
  });
  const next = wall.slides.find((s) => s.kind === 'next');
  assert.ok(next, 'the fixture is on the wall');
  assert.equal(next.kickoff, '', 'no kick-off was published, so none is shown');
});

// ---------------------------------------------------------------------------- the events

test('a row with no readable date is left out, and the reason is logged', () => {
  const log = [];
  const events = eventsFromRows([
    { date: '07/11/2026', home: 'Caldecote FC', away: 'Cranfield United', score: '3 - 2' },
    { date: 'TBC', home: 'Caldecote FC', away: 'Wootton Blue Cross', score: '1 - 1' },
    { date: '21/11/2026', home: '', away: 'Someone' },
  ], feed(), league(), { log: (m) => log.push(m) });

  assert.equal(events.length, 1, 'undated and team-less rows cannot be shown');
  assert.equal(events[0].home.score, 3);
  assert.equal(events[0].away.score, 2);
  assert.equal(log.length, 2);
  assert.match(log[0], /no readable date/);
  assert.match(log[1], /no two teams/);
});

test('grassroots words land on the four statuses the display sorts on, in the league\'s own wording', () => {
  const rows = [
    { date: '07/11/2026', home: 'Caldecote FC', away: 'A', status: 'Postponed — pitch unplayable' },
    { date: '07/11/2026', home: 'Caldecote FC', away: 'B', status: 'Abandoned', note: 'Abandoned 70 mins — floodlight failure' },
    { date: '07/11/2026', home: 'Caldecote FC', away: 'C', status: 'Walkover', score: '3 - 0' },
    { date: '07/11/2026', home: 'Caldecote FC', away: 'D', status: 'Played' },        // no score published yet
    { date: '14/11/2026', home: 'Caldecote FC', away: 'E', status: 'Fixture' },
  ];
  const events = eventsFromRows(rows, feed(), league());
  assert.deepEqual(events.map((e) => e.status), ['postponed', 'postponed', 'final', 'scheduled', 'scheduled']);

  assert.equal(events[0].statusText, 'Postponed — pitch unplayable', 'kept as written');
  assert.equal(events[1].statusText, 'Abandoned 70 mins — floodlight failure');
  assert.equal(events[3].awaitingResult, true, 'played with no score is "result to follow", never a 0–0');
  assert.equal(events[3].statusText, 'Result to follow');
  assert.equal(events[3].home.score, null);

  // No fifth status value: one unknown status is enough to make the comparator NaN and
  // scramble the whole display order.
  const statuses = new Set(events.map((e) => e.status));
  assert.deepEqual([...statuses].filter((s) => !['scheduled', 'live', 'final', 'postponed'].includes(s)), []);
  assert.doesNotThrow(() => sortEvents(events));
});

test('a score field or a score cell, and a fixture carries no score at all', () => {
  assert.deepEqual(readScore({ score: '3 - 2' }), { home: 3, away: 2 });
  assert.deepEqual(readScore({ score: '3–2' }), { home: 3, away: 2 });
  assert.deepEqual(readScore({ homeGoals: '0', awayGoals: 4 }), { home: 0, away: 4 });
  assert.deepEqual(readScore({ score: 'v' }), { home: null, away: null });
  assert.deepEqual(readScore({}), { home: null, away: null });
});

test('the same match from two feeds is one match, and the side\'s own feed says whose it was', () => {
  const team = eventsFromRows(
    [{ date: '07/11/2026', home: 'Caldecote FC', away: 'Cranfield United', score: '3 - 2', venue: 'Harvey Close' }],
    feed({ code: '2', team: 'First XI', competition: 'Premier Division' }), league(),
  );
  const division = eventsFromRows(
    [{ date: '07/11/2026', home: 'Caldecote FC', away: 'Cranfield United' }],
    feed({ code: '3' }), league(),
  );
  const merged = mergeEvents([...division, ...team]);
  assert.equal(merged.length, 1, 'one match, not two — it would count twice towards form');
  assert.equal(merged[0].team, 'First XI');
  assert.equal(merged[0].home.score, 3, 'the played result beats the bare listing');
  assert.equal(merged[0].venue, 'Harvey Close');
});

test('the table: the league\'s own footnote survives, a junk row does not', () => {
  const rows = [
    { pos: '1', team: 'Shefford Town', p: '11', w: '8', d: '2', l: '1', f: '29', a: '12', pts: '26' },
    { pos: '2', team: 'Caldecote FC', p: '11', w: '7', d: '2', l: '2', f: '25', a: '14', pts: '23', note: '−3 points deducted' },
    { pos: '', team: '', p: '', pts: '' },
  ];
  const standings = standingsFromRows(rows, feed({ kind: 'table', competition: 'Premier Division' }), league());
  assert.equal(standings.name, 'Premier Division');
  assert.equal(standings.rows.length, 2);
  assert.equal(standings.rows[1].note, '−3 points deducted');
  assert.equal(standings.rows[1].goalDifference, 11);
  assert.equal(standingsFromRows([], feed({ kind: 'table' }), league()), null);
});

// ------------------------------------------------------------------------------ the read

const RESULTS = JSON.stringify({ results: [
  { date: '07/11/2026', time: '14:00', home: 'Caldecote FC', away: 'Cranfield United', score: '3 - 2' },
  { date: '31/08/2026', time: '15:00', home: 'Caldecote FC', away: 'Wootton Blue Cross', score: '2 - 1' },
] });

test('one read a week per feed, and no more — this is the deal the route was bought with', async () => {
  resetFulltimeCache();
  const fetchImpl = stubFetch(RESULTS);
  const now = new Date('2026-11-08T18:00:00Z');
  const first = await fetchFulltime(league(), { fetchImpl, now });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(first.events.length, 2);
  assert.equal(first.credit, 'Results from The FA Full-Time');
  assert.equal(first.club.name, 'Caldecote FC');

  // The store's own loop comes round every ten minutes. It must not reach the feed.
  for (const minutes of [10, 60, 60 * 24, 60 * 24 * 6]) {
    const again = await fetchFulltime(league(), { fetchImpl, now: new Date(now.getTime() + minutes * 60_000) });
    assert.equal(fetchImpl.calls.length, 1, `still one request after ${minutes} minutes`);
    assert.equal(again.events.length, 2, 'and the cached payload is still what is on screen');
  }
  await fetchFulltime(league(), { fetchImpl, now: new Date(now.getTime() + 7 * 86_400_000 + 1000) });
  assert.equal(fetchImpl.calls.length, 2, 'a week later, one more read');
});

test('a whole season is kept, because last-five form needs more than three days of it', async () => {
  resetFulltimeCache();
  const read = await fetchFulltime(league(), {
    fetchImpl: stubFetch(RESULTS), now: new Date('2026-11-08T18:00:00Z'), daysBack: 3,
  });
  // `daysBack: 3` is ESPN's window and it is applied inside espn.js, not in the store —
  // so an August result is still here in November, which is what the form slide needs.
  assert.ok(read.events.some((e) => e.start.startsWith('2026-08-31')), 'August survived November');
});

test('no codes yet is an error with the answer in it, not an empty screen', async () => {
  resetFulltimeCache();
  await assert.rejects(
    () => fetchFulltime(league({ feeds: [] }), { fetchImpl: stubFetch(RESULTS) }),
    /no snippet codes configured.*Code snippets/s,
  );
});

test('a failed feed keeps its last good read, and never invents a replacement', async () => {
  resetFulltimeCache();
  let body = RESULTS;
  let status = 200;
  const fetchImpl = stubFetch(() => body, {});
  // One stub whose status we can flip mid-test.
  const flipping = async (url) => {
    fetchImpl.calls.push(url);
    return { ok: status === 200, status, text: async () => body };
  };
  flipping.calls = fetchImpl.calls;

  const now = new Date('2026-11-08T18:00:00Z');
  const good = await fetchFulltime(league(), { fetchImpl: flipping, now });
  assert.equal(good.events.length, 2);

  // A week later the code has been revoked. The screen keeps Saturday's result, dated.
  status = 403;
  const log = [];
  const week = new Date(now.getTime() + 7 * 86_400_000 + 1000);
  const after = await fetchFulltime(league(), { fetchImpl: flipping, now: week, log: (m) => log.push(m) });
  assert.equal(after.events.length, 2, 'last good read, still on screen');
  assert.equal(after.readAt, good.readAt, 'and still carrying the date it was read');
  assert.equal(after.feeds[0].error, 'HTTP 403');
  assert.match(log[0], /keeping the last good read/);

  // And it retries hourly rather than weekly after a failure, but not every ten minutes.
  const calls = flipping.calls.length;
  await fetchFulltime(league(), { fetchImpl: flipping, now: new Date(week.getTime() + 10 * 60_000) });
  assert.equal(flipping.calls.length, calls, 'ten minutes later: no retry');
  await fetchFulltime(league(), { fetchImpl: flipping, now: new Date(week.getTime() + 61 * 60_000) });
  assert.equal(flipping.calls.length, calls + 1, 'an hour later: one retry');
});

test('a dead results feed does not take the table down with it', async () => {
  resetFulltimeCache();
  const table = JSON.stringify({ standings: [
    { pos: 1, team: 'Shefford Town', p: 11, w: 8, d: 2, l: 1, f: 29, a: 12, pts: 26 },
    { pos: 2, team: 'Caldecote FC', p: 11, w: 7, d: 2, l: 2, f: 25, a: 14, pts: 23 },
  ] });
  const fetchImpl = async (url) => ({
    ok: !url.includes('lrcode=999'),
    status: url.includes('lrcode=999') ? 500 : 200,
    text: async () => table,
  });

  const log = [];
  const read = await fetchFulltime(league({
    feeds: [
      { code: '123456', kind: 'table', competition: 'Premier Division' },
      { code: '999', kind: 'results', competition: 'Premier Division', team: 'First XI' },
    ],
  }), { fetchImpl, now: new Date('2026-11-08T18:00:00Z'), log: (m) => log.push(m) });

  assert.equal(read.standings.rows.length, 2, 'the table read fine and is on screen');
  assert.deepEqual(read.events, []);
  assert.equal(read.partial, true, 'and the payload says it is incomplete rather than looking whole');
  assert.equal(read.feeds[1].error, 'HTTP 500');
});

test('every feed dead and none ever good is a league error, so the store keeps the screen it had', async () => {
  resetFulltimeCache();
  const store = new Store(
    { leagues: [league()], title: 'Caldecote FC', refreshMinutes: 10, timezone: 'Europe/London' },
    { fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }), log: () => {} },
  );
  await store.refresh();
  const [snap] = store.snapshot().leagues;
  assert.match(snap.error, /no feed could be read/);
  assert.deepEqual(snap.events, [], 'no data, and nothing invented to fill the hole');
});

test('the source is wired into the store under its own name', async () => {
  resetFulltimeCache();
  const store = new Store(
    { leagues: [league()], title: 'Caldecote FC', refreshMinutes: 10, timezone: 'Europe/London' },
    { fetchImpl: stubFetch(RESULTS), log: () => {} },
  );
  const { changed, snapshot } = await store.refresh();
  assert.equal(changed, true);
  const [l] = snapshot.leagues;
  assert.equal(l.error, null);
  assert.equal(l.events.length, 2);
  assert.equal(l.credit, 'Results from The FA Full-Time');
});
