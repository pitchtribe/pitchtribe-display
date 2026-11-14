// The clubhouse wall: the manual club source, the slide selectors, the card's own
// opening hours, the photo pool and the page itself.
//
// The brief's trust rules and its design law are requirements, so they are tested like
// requirements: a result always carries its date, nothing is ever interpolated, the
// league's own wording survives, and five rows is the whole table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchManual, normalizeStatus, normalizeRow, normalizeClub } from '../src/sources/manual.js';
import { Store, sortEvents } from '../src/store.js';
import { createHttpServer } from '../src/http.js';
import { resolveConfig } from '../src/config.js';
import {
  clubMatcher, ourResults, ourNext, ourAwaiting, ourCalledOff, form, teams, tableWindow,
  divisionResults, daysToSaturday, countdownWords, isOpen, pickPhotos, seededShuffle,
  interleave, buildClubhouse, zoneParts,
} from '../src/clubhouse.js';
import { renderClubhouse } from '../src/clubhouse-render.js';
import { resolvePhoto, contentType } from '../src/photos.js';

const here = dirname(fileURLToPath(import.meta.url));
const quiet = () => {};
const DAY = 86_400_000;
const iso = (offsetDays, hour = 14) => {
  const d = new Date(Date.now() + offsetDays * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

/** A club file shaped like the real thing, dated around "now" so windows behave. */
function clubFile() {
  return {
    name: 'County League',
    club: { name: 'Our Club', aliases: ['OCFC'] },
    credit: "Results from the league's published results",
    events: [
      // Last Saturday: a win, a called-off reserves game, an unpublished 'A' team result.
      { id: 'w', start: iso(-5), status: 'final', competition: 'Premier Division', team: 'First XI', home: 'Our Club 1st XI', away: 'Riverside FC', homeScore: 3, awayScore: 2, venue: 'The Pavilion' },
      { id: 'pp', start: iso(-5), status: 'abandoned', statusText: 'Abandoned — floodlight failure', competition: 'Division One', team: 'Reserves', home: 'Brook End Reserves', away: 'Our Club Reserves' },
      { id: 'tbc', start: iso(-5), status: 'awaiting', competition: 'Division Two', team: "'A' Team", home: "Fenside 'A'", away: "Our Club 'A'" },
      // Other people's results — the only new thing midweek.
      { id: 'other1', start: iso(-5), status: 'final', competition: 'Premier Division', home: 'Hilltop Town', away: 'Oakfield United', homeScore: 2, awayScore: 2 },
      { id: 'other2', start: iso(-5), status: 'final', competition: 'Premier Division', home: 'Millfield', away: 'Fenside', homeScore: 1, awayScore: 0 },
      // The season behind us, for form.
      { id: 'f1', start: iso(-12), status: 'final', team: 'First XI', home: 'Our Club 1st XI', away: 'Marsh Rovers', homeScore: 2, awayScore: 0 },
      { id: 'f2', start: iso(-19), status: 'final', team: 'First XI', home: 'Oakfield United', away: 'Our Club 1st XI', homeScore: 1, awayScore: 1 },
      { id: 'f3', start: iso(-26), status: 'final', team: 'First XI', home: 'Weatherby Athletic', away: 'Our Club 1st XI', homeScore: 2, awayScore: 0 },
      { id: 'f4', start: iso(-33), status: 'final', team: 'First XI', home: 'Our Club 1st XI', away: 'Stonebridge', homeScore: 4, awayScore: 1 },
      { id: 'f5', start: iso(-40), status: 'final', team: 'First XI', home: 'Fenside', away: 'Our Club 1st XI', homeScore: 0, awayScore: 1 },
      // Next Saturday, one per side.
      { id: 'n1', start: iso(2), status: 'scheduled', competition: 'Premier Division', team: 'First XI', home: 'Hilltop Town', away: 'Our Club 1st XI', venue: 'Hilltop Park' },
      { id: 'n2', start: iso(2), status: 'scheduled', competition: 'Division One', team: 'Reserves', home: 'Our Club Reserves', away: 'Stonebridge Reserves' },
      { id: 'n3', start: iso(9), status: 'scheduled', competition: 'Premier Division', team: 'First XI', home: 'Our Club 1st XI', away: 'Marsh Rovers' },
    ],
    standings: {
      name: 'Premier Division',
      updated: iso(-4),
      rows: [
        { team: 'Weatherby Athletic', p: 10, w: 8, d: 1, l: 1, f: 24, a: 9, pts: 25 },
        { team: 'Millfield', p: 10, w: 7, d: 2, l: 1, f: 22, a: 11, pts: 23 },
        { team: 'Our Club 1st XI', p: 10, w: 6, d: 2, l: 2, f: 21, a: 13, pts: 20 },
        { team: 'Hilltop Town', p: 10, w: 5, d: 3, l: 2, f: 19, a: 14, pts: 18 },
        { team: 'Stonebridge', p: 10, w: 5, d: 1, l: 4, f: 18, a: 17, pts: 16 },
        { team: 'Church Lane Rangers', p: 10, w: 4, d: 2, l: 4, f: 15, a: 16, pts: 11, note: '−3 points deducted' },
        { team: 'Fenside', p: 10, w: 1, d: 1, l: 8, f: 8, a: 22, pts: 4 },
      ],
    },
  };
}

async function withClubFile(body, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'clubhouse-'));
  const file = join(dir, 'club.json');
  await writeFile(file, JSON.stringify(body));
  try {
    return await fn(file, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const league = { key: 'club', name: 'County League', source: 'manual' };

// ------------------------------------------------------------------ the manual source
test('grassroots statuses map onto the four the display sorts on', () => {
  // The league's own wording is what goes on the wall; the status is only for ordering.
  assert.deepEqual(
    normalizeStatus('abandoned', { statusText: 'Abandoned — floodlight failure' }),
    { status: 'postponed', statusText: 'Abandoned — floodlight failure', awaitingResult: false }
  );
  assert.deepEqual(normalizeStatus('waterlogged'), { status: 'postponed', statusText: 'Waterlogged', awaitingResult: false });
  assert.deepEqual(normalizeStatus('called off'), { status: 'postponed', statusText: 'Called off', awaitingResult: false });
  assert.deepEqual(normalizeStatus('played', { homeScore: 1, awayScore: 0 }), { status: 'final', statusText: 'FT', awaitingResult: false });
  assert.equal(normalizeStatus('walkover', { homeScore: 3, awayScore: 0 }).statusText, 'Walkover');
  assert.equal(normalizeStatus('in-progress').status, 'live');
  // Nothing invented: a "result" with no score is a result we do not have yet.
  assert.deepEqual(normalizeStatus('final'), { status: 'scheduled', statusText: 'Result to follow', awaitingResult: true });
  assert.deepEqual(normalizeStatus('awaiting'), { status: 'scheduled', statusText: 'Result to follow', awaitingResult: true });
  // A word nobody anticipated reads as a fixture rather than becoming a fifth status.
  assert.equal(normalizeStatus('mystery-word').status, 'scheduled');
});

test('a result with no readable date is left out and said out loud', async () => {
  const lines = [];
  await withClubFile({
    events: [
      { id: 'ok', start: iso(-1), status: 'final', home: 'Our Club', away: 'Riverside FC', homeScore: 1, awayScore: 0 },
      { id: 'undated', status: 'final', home: 'Our Club', away: 'Hilltop Town', homeScore: 2, awayScore: 2 },
      { id: 'nonsense', start: 'last Saturday', status: 'final', home: 'Our Club', away: 'Fenside', homeScore: 1, awayScore: 1 },
    ],
  }, async (file) => {
    const out = await fetchManual({ ...league, file }, { log: (l) => lines.push(l) });
    assert.deepEqual(out.events.map((e) => e.id), ['club:ok']);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /club:undated: skipped/);
    assert.match(lines[1], /every result carries its date/);
  });
});

test('the table is normalised from whatever column names the league published', () => {
  const row = normalizeRow({ team: 'Millfield', p: 10, w: 7, d: 2, l: 1, f: 22, a: 11, pts: 23 }, 1);
  assert.deepEqual(row, {
    position: 2, team: 'Millfield', played: 10, won: 7, drawn: 2, lost: 1,
    goalsFor: 22, goalsAgainst: 11, goalDifference: 11, points: 23, note: '',
  });
  // Missing numbers stay missing rather than becoming zeroes.
  assert.deepEqual(normalizeRow({ team: 'New Club' }, 0).played, null);
  assert.equal(normalizeRow({ team: 'X', goalDifference: -4 }, 0).goalDifference, -4);
  assert.deepEqual(normalizeClub('Our Club'), { name: 'Our Club', aliases: [] });
});

test('the manual source reads a whole season, a table and the club it belongs to', async () => {
  await withClubFile(clubFile(), async (file) => {
    const out = await fetchManual({ ...league, file }, { log: quiet });
    assert.equal(out.club.name, 'Our Club');
    assert.equal(out.credit, "Results from the league's published results");
    assert.equal(out.standings.rows.length, 7);
    assert.equal(out.standings.name, 'Premier Division');
    assert.equal(out.events.length, 13, 'no daysBack window: the file is the season');
    const tbc = out.events.find((e) => e.id === 'club:tbc');
    assert.equal(tbc.awaitingResult, true);
    assert.equal(tbc.statusText, 'Result to follow');
    assert.equal(tbc.home.score, null);
    assert.equal(out.events.find((e) => e.id === 'club:pp').statusText, 'Abandoned — floodlight failure');
  });
});

// -------------------------------------------------------------------------- the store
test('the store carries the table, hashes it, and keeps the last good one on failure', async () => {
  await withClubFile(clubFile(), async (file) => {
    const config = { title: 'Our Club', leagues: [{ ...league, file }], refreshMinutes: 30, liveRefreshSeconds: 300 };
    const store = new Store(config, { log: quiet });
    let updates = 0;
    store.on('update', () => { updates += 1; });
    await store.refresh();
    assert.equal(store.snapshot().leagues[0].standings.rows[0].team, 'Weatherby Athletic');
    assert.equal(updates, 1);
    assert.equal((await store.refresh()).changed, false, 'same file, no change');

    // Only the table moved: that is still a change worth redrawing the screen for.
    const moved = clubFile();
    moved.standings.rows[2].points = 23;
    await writeFile(file, JSON.stringify(moved));
    assert.equal((await store.refresh()).changed, true);
    assert.equal(updates, 2);

    // An unreadable file keeps last week's wall up rather than emptying it.
    await writeFile(file, 'not json');
    await store.refresh();
    const l = store.snapshot().leagues[0];
    assert.match(l.error, /JSON/);
    assert.equal(l.events.length, 13);
    assert.equal(l.standings.rows.length, 7);
  });
});

test('an unrecognised status cannot scramble the display order', () => {
  const ev = (id, status, start) => ({ id, status, start, home: { score: null }, away: { score: null } });
  const sorted = sortEvents([
    ev('a', 'scheduled', iso(3)), ev('b', 'surprise', iso(1)), ev('c', 'live', iso(0)), ev('d', 'final', iso(-1)),
  ]);
  assert.deepEqual(sorted.map((e) => e.id), ['c', 'd', 'a', 'b']);
});

// ---------------------------------------------------------------------- the selectors
test('selectors pick this week, the next game, the form and everyone else', async () => {
  await withClubFile(clubFile(), async (file) => {
    const { events, standings, club } = await fetchManual({ ...league, file }, { log: quiet });
    const isUs = clubMatcher(club);
    assert.ok(isUs('Our Club Reserves') && isUs("Our Club 'A'") && !isUs('Riverside FC'));

    const results = ourResults(events, isUs);
    assert.deepEqual(results.map((e) => e.id), ['club:w'], 'only the last nine days count as news');
    assert.deepEqual(ourCalledOff(events, isUs).map((e) => e.statusText), ['Abandoned — floodlight failure']);
    assert.deepEqual(ourAwaiting(events, isUs).map((e) => e.id), ['club:tbc']);

    // One fixture per side, soonest first — not three for the First XI.
    assert.deepEqual(ourNext(events, isUs).map((e) => e.id), ['club:n1', 'club:n2']);

    assert.deepEqual(teams(events, isUs), ['First XI', 'Reserves', "'A' Team"]);
    assert.deepEqual(form(events, isUs, { team: 'First XI' }).map((f) => f.mark), ['W', 'L', 'D', 'W', 'W'],
      'oldest to newest, five of them, from a season the window would have thrown away');

    const table = tableWindow(standings, isUs);
    assert.equal(table.rows.length, 5, 'our row and two either side — never a twenty-row grid');
    assert.deepEqual(table.rows.map((r) => r.us), [false, false, true, false, false]);
    assert.equal(table.rows[0].team, 'Weatherby Athletic');

    assert.deepEqual(divisionResults(events, isUs).map((e) => e.id), ['club:other1', 'club:other2']);
  });
});

test('the table still reads when we are bottom, or missing from it', () => {
  const rows = ['A', 'B', 'C', 'D', 'E', 'F'].map((team, i) => ({ team, position: i + 1, points: 10 - i }));
  const bottom = tableWindow({ name: 'Div', rows }, clubMatcher({ name: 'F' }));
  assert.deepEqual(bottom.rows.map((r) => r.team), ['B', 'C', 'D', 'E', 'F'], 'window slides up to stay full');
  const missing = tableWindow({ name: 'Div', rows }, clubMatcher({ name: 'Nobody' }));
  assert.equal(missing.found, false);
  assert.deepEqual(missing.rows.map((r) => r.team), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(tableWindow(null, clubMatcher({ name: 'F' })), null);
});

// ------------------------------------------------------------- hours and the countdown
test('the card keeps the opening hours, including past midnight', () => {
  const hours = { fri: [['18:00', '23:30']], sat: [['12:00', '01:00']], sun: [] };
  const at = (s) => new Date(s);
  // Saturday 2026-11-07, Sunday 2026-11-08 (GMT in November, so UTC is local).
  assert.equal(isOpen(hours, at('2026-11-07T13:00:00Z'), 'Europe/London'), true);
  assert.equal(isOpen(hours, at('2026-11-07T11:59:00Z'), 'Europe/London'), false);
  assert.equal(isOpen(hours, at('2026-11-08T00:30:00Z'), 'Europe/London'), true, "Saturday's window runs into Sunday");
  assert.equal(isOpen(hours, at('2026-11-08T13:00:00Z'), 'Europe/London'), false, 'Sunday is closed');
  assert.equal(isOpen(hours, at('2026-11-09T20:00:00Z'), 'Europe/London'), false, 'a day with no hours is closed');
  // A committee meeting on a Wednesday evening does not get a lit screen.
  assert.equal(isOpen(hours, at('2026-11-11T20:00:00Z'), 'Europe/London'), false);
  // Summer time: the hours are local, not UTC.
  assert.equal(isOpen({ sat: [['12:00', '23:00']] }, at('2026-07-04T11:30:00Z'), 'Europe/London'), true);
  assert.equal(isOpen(null, at('2026-11-09T04:00:00Z')), true, 'no hours configured = a test bench, always on');
});

test('the countdown changes face every day', () => {
  const tz = 'Europe/London';
  assert.equal(daysToSaturday(new Date('2026-11-07T18:00:00Z'), tz), 0);
  assert.equal(daysToSaturday(new Date('2026-11-08T18:00:00Z'), tz), 6);
  assert.equal(daysToSaturday(new Date('2026-11-13T18:00:00Z'), tz), 1);
  assert.deepEqual(countdownWords(0), { lead: 'Today', tail: 'is matchday' });
  assert.deepEqual(countdownWords(1), { lead: 'Tomorrow', tail: 'is matchday' });
  assert.deepEqual(countdownWords(4), { lead: '4', tail: 'days to Saturday' });
  // A clock just past midnight in London is still "today" in the zone, not yesterday in UTC.
  assert.equal(zoneParts(new Date('2026-07-04T23:30:00Z'), tz).dateKey, '2026-07-05');
});

// ------------------------------------------------------------------------- the photos
test('the photo pool is day-stable, reshuffled daily, and happy with twelve or four hundred', () => {
  const four_hundred = Array.from({ length: 400 }, (_, i) => `p${String(i).padStart(3, '0')}.jpg`);
  const sunday = pickPhotos(four_hundred, { dateKey: '2026-11-08', count: 12 });
  const again = pickPhotos(four_hundred, { dateKey: '2026-11-08', count: 12 });
  const wednesday = pickPhotos(four_hundred, { dateKey: '2026-11-11', count: 12 });
  assert.equal(sunday.length, 12);
  assert.deepEqual(sunday, again, 'the same day shows the same dozen all day');
  assert.notDeepEqual(sunday, wednesday, "Wednesday's screen is not Sunday's");
  assert.ok(sunday.every((f) => four_hundred.includes(f)));
  assert.equal(new Set(sunday).size, 12, 'no photograph twice in one loop');

  // Twelve photographs: same code, and all twelve get shown.
  const twelve = four_hundred.slice(0, 12);
  assert.equal(pickPhotos(twelve, { dateKey: '2026-11-08' }).length, 12);
  assert.equal(pickPhotos(['notes.txt', 'Thumbs.db', 'team.JPG'], { dateKey: 'x' }).length, 1);
  assert.deepEqual(pickPhotos([], { dateKey: 'x' }), []);
  assert.deepEqual(seededShuffle([1, 2, 3, 4, 5], 'seed'), seededShuffle([1, 2, 3, 4, 5], 'seed'));
});

test('a photograph is only ever served from the configured folder', () => {
  const dir = resolve(here, '../data/photos');
  assert.equal(resolvePhoto(dir, '../../config.json'), null);
  assert.equal(resolvePhoto(dir, '..%2Fconfig.json'), null);
  assert.equal(resolvePhoto(dir, '/etc/passwd'), null);
  assert.equal(resolvePhoto(dir, '.hidden.jpg'), null);
  assert.equal(resolvePhoto(dir, 'team.txt'), null);
  assert.equal(resolvePhoto(dir, 'team photo.jpg'), join(dir, 'team photo.jpg'));
  assert.equal(resolvePhoto('', 'team.jpg'), null);
  assert.equal(contentType('badge.svg'), 'image/svg+xml');
});

test('photographs are woven through the football, not bolted on the end', () => {
  assert.deepEqual(interleave(['a', 'b'], [1, 2, 3]), ['a', 1, 'b', 2, 3]);
  assert.deepEqual(interleave(['a', 'b', 'c'], []), ['a', 'b', 'c']);
});

// --------------------------------------------------------------------------- the loop
async function wall(opts = {}) {
  return withClubFile(clubFile(), async (file) => {
    const config = resolveConfig({
      title: 'Our Club',
      leagues: [{ ...league, file }],
      clubhouse: {
        league: 'club', name: 'Our Club FC', strapline: 'The Pavilion',
        badge: 'data/badge.example.svg', rhythm: ['Training — Tuesdays, 7pm'],
        openingHours: { sat: [['12:00', '23:30']] }, ...opts.clubhouse,
      },
    });
    const store = new Store(config, { log: quiet });
    await store.refresh();
    return {
      config,
      built: buildClubhouse(store.snapshot(), config, { photoFiles: opts.photoFiles ?? ['a.jpg', 'b.jpg'] }),
    };
  });
}

test('the loop is single-idea slides, every result dated, photographs between', async () => {
  const { built } = await wall();
  const kinds = built.slides.map((s) => s.kind);
  for (const want of ['result', 'awaiting', 'calledoff', 'next', 'table', 'form', 'division', 'identity', 'rhythm', 'countdown', 'photo']) {
    assert.ok(kinds.includes(want), `the loop is missing a ${want} slide`);
  }
  const result = built.slides.find((s) => s.kind === 'result');
  assert.match(result.date, /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d+ \w+$/, 'trust rule 1');
  assert.equal(result.ourScore, 3);
  assert.equal(result.theirScore, 2);
  assert.equal(result.them, 'Riverside FC');
  assert.equal(result.homeAway, 'home');
  assert.equal(result.mark, 'W');
  assert.equal(built.slides.find((s) => s.kind === 'form').marks.length, 5);
  assert.equal(built.slides.find((s) => s.kind === 'table').rows.length, 5);
  assert.equal(built.title, 'Our Club FC');
  assert.equal(built.credit, "Results from the league's published results");
  assert.equal(built.hours.sat[0][1], '23:30');
});

test('an empty card still shows the club, never a blank screen', async () => {
  const config = resolveConfig({ title: 'Our Club', leagues: [], clubhouse: { league: 'club' } });
  const built = buildClubhouse({ updatedAt: null, leagues: [] }, config, { photoFiles: [] });
  // No league, no photographs, no table: identity and the countdown still stand up.
  assert.deepEqual(built.slides.map((s) => s.kind), ['identity', 'countdown']);
  const html = renderClubhouse(built, { live: false });
  assert.ok(html.includes('Our Club'));
  assert.ok(!/undefined|NaN|\[object/.test(html));
});

// --------------------------------------------------------------------------- the page
test('the page escapes names, keeps the hours itself and never reloads into a dead server', async () => {
  const { built } = await wall();
  built.slides.unshift({
    kind: 'result', date: 'Saturday 7 November', competition: 'Premier <b>Division</b>', team: 'First XI',
    us: 'Our Club', them: 'Riverside <script>alert(1)</script>', homeAway: 'away',
    ourScore: 1, theirScore: 0, mark: 'W', statusText: 'FT',
  });
  const html = renderClubhouse(built, { rotateSeconds: 12 });
  assert.ok(html.includes('Riverside &lt;script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  // The rules the card has to keep offline are in the page, not fetched from anywhere.
  assert.ok(html.includes('function isOpen'), 'opening hours are evaluated on the card');
  assert.ok(html.includes('function daysToSaturday'));
  assert.ok(!/src="https?:/.test(html), 'no external assets: no internet is a normal condition');
  assert.ok(html.includes('reloadIfServed'));
  assert.match(html, /unplug the white cable/);
  assert.ok(html.includes('photos/a.jpg'));
  assert.ok(html.includes('EventSource'));
  assert.ok(!renderClubhouse(built, { live: false }).includes('EventSource'));
});

test('HTTP: the wall, the photographs, the badge and the redirect', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'clubhouse-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'team.jpg'), 'not-really-a-jpeg');
  await writeFile(join(dir, 'notes.txt'), 'ignore me');
  const clubJson = join(dir, 'club.json');
  await writeFile(clubJson, JSON.stringify(clubFile()));
  const config = resolveConfig({
    title: 'Our Club',
    leagues: [{ ...league, file: clubJson }],
    clubhouse: {
      league: 'club', name: 'Our Club FC', badge: 'data/badge.example.svg', photosDir: dir,
      openingHours: { sat: [['12:00', '23:30']] },
    },
  });
  const store = new Store(config, { log: quiet });
  await store.refresh();
  const server = createHttpServer({ store, config, push: async () => [], mcp: async () => null, log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(`${base}/clubhouse`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.ok(html.includes('photos/team.jpg'), 'the pool is read from disk');
  assert.ok(!html.includes('notes.txt'));

  const photo = await fetch(`${base}/photos/team.jpg`);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.match(photo.headers.get('cache-control'), /max-age=86400/, 'a cached photo is an SD-card read saved');
  assert.equal((await fetch(`${base}/photos/notes.txt`)).status, 404);
  assert.equal((await fetch(`${base}/photos/..%2F..%2Fconfig.json`)).status, 404);
  assert.equal((await fetch(`${base}/photos/%E0%A4%A`)).status, 404, 'a malformed name is a 404, not a 500');

  const badge = await fetch(`${base}/badge`);
  assert.equal(badge.status, 200);
  assert.equal(badge.headers.get('content-type'), 'image/svg+xml');

  const root = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(root.headers.get('location'), '/clubhouse', 'a club card opens on the club wall');

  const leagues = await (await fetch(`${base}/api/leagues`)).json();
  assert.equal(leagues[0].standings, 7);
});
