'use strict';
/* The clubhouse wall as a card actually serves it.
 *
 * The wall is built and tested inside signage-server, where it is configured from
 * `clubhouse.example.json` and served at `/clubhouse`. On a Pi there is no such
 * process: install.sh runs the app, which embeds the engine at `/feeds`, and tells
 * the installer to point the kiosk at `/feeds/clubhouse`. That URL answered 200 with
 * PitchTribe's name on it and no football, because nothing passed the club's config
 * to the embedded engine — so the only documented way to put this on a television
 * put the wrong screen on it. These tests are about the join, not about the slides.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');

const offline = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });

/** Last Saturday, so the result slide is inside the window that counts as news. */
function lastSaturday() {
  const d = new Date();
  d.setUTCHours(14, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7));
  return d;
}

function clubFixture(dir, { seasonFile = 'season.json', badge = 'badge.svg' } = {}) {
  const sat = lastSaturday();
  fs.writeFileSync(
    path.join(dir, seasonFile),
    JSON.stringify({
      name: 'Bedfordshire County League',
      club: { name: 'Caldecote FC', aliases: ['Caldecote'] },
      events: [
        {
          id: '1xi-result',
          start: sat.toISOString(),
          status: 'final',
          competition: 'Premier Division',
          team: 'First XI',
          home: 'Caldecote FC',
          away: 'Cranfield United',
          homeScore: 3,
          awayScore: 2,
        },
      ],
      standings: {
        name: 'Premier Division',
        rows: [
          { position: 1, team: 'Caldecote FC', played: 11, points: 26 },
          { position: 2, team: 'Riverside FC', played: 11, points: 22 },
        ],
      },
    }),
  );
  fs.writeFileSync(path.join(dir, badge), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>');
  fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'photos', 'team.jpg'), Buffer.from('\xff\xd8\xff\xe0', 'binary'));
  return {
    title: 'Caldecote FC',
    timezone: 'Europe/London',
    leagues: [{ key: 'club', source: 'manual', file: seasonFile, name: 'Bedfordshire County League' }],
    clubhouse: {
      league: 'club',
      club: 'Caldecote FC',
      name: 'Caldecote FC',
      strapline: 'The Pavilion · Saturdays, 16+',
      badge,
      photosDir: 'photos',
      openingHours: { sat: [['12:00', '23:30']] },
    },
  };
}

/** Start a card. `club` is written to the data directory as a real install's would be. */
async function start(t, { club = null, log } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-wall-'));
  if (club) fs.writeFileSync(path.join(dataDir, 'clubhouse.json'), JSON.stringify(club(dataDir)));
  const ctx = createApp({ dataDir, sportsFetch: offline, feedsFetch: offline, log: log || (() => {}) });
  await ctx.feeds.ready;
  const server = await new Promise((r) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => r(s));
  });
  t.after(() => {
    ctx.close();
    server.closeAllConnections();
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { ctx, dataDir, base: `http://127.0.0.1:${server.address().port}` };
}

/**
 * The page, once the club's season file has actually been read.
 *
 * `configure()` starts the refresh loop without awaiting its first tick — the right
 * thing on a card, where nothing is waiting — so the wall is briefly served with the
 * club's name and colours on it and no football in it yet. This awaits one read
 * instead of polling for a string: the club's name is on the identity slide from the
 * first byte, so "is the name there?" is a question that answers itself and would have
 * let a wall with no results pass.
 */
async function wall(base, ctx) {
  await ctx.feeds.refresh();
  return (await fetch(`${base}/feeds/clubhouse`)).text();
}

test('a card with a club file shows the club, not PitchTribe', async (t) => {
  const { ctx, base } = await start(t, { club: clubFixture });
  assert.equal(ctx.feeds.clubhouseOn, true);

  const html = await wall(base, ctx);
  assert.match(html, /Caldecote FC/, 'the club owns the screen; its name has to be on it');
  assert.doesNotMatch(html, /<title>PitchTribe<\/title>/, 'our name is not what the room came to read');

  // Trust rule 1: the result is on screen and it carries its date.
  assert.match(html, /3–2|3-2/, 'the result the club played');
  assert.match(html, /Saturday \d/, 'and the date it was played on');
  // The table is the slide that needed a second payload threaded through the store.
  assert.match(html, /Premier Division/);

  // The badge is a relative path in the club file; the kiosk asks for it relative
  // to the page, which under the /feeds mount is /feeds/badge.
  const badge = await fetch(`${base}/feeds/badge`);
  assert.equal(badge.status, 200, 'the badge resolves against the club file, not the package');
});

test('a card with no club file is the playlist player it was before', async (t) => {
  const { ctx, base } = await start(t);
  assert.equal(ctx.feeds.clubhouseOn, false);
  // The route still answers — it is the engine's, not ours to remove — but nothing
  // about a playlist card changes, and no club content is invented.
  const r = await fetch(`${base}/feeds/clubhouse`);
  assert.equal(r.status, 200);
  assert.doesNotMatch(await r.text(), /Caldecote/);
  const player = await fetch(`${base}/player/`);
  assert.equal(player.status, 200, 'the base system is untouched');
});

test('a broken club file is said out loud and the dashboard still starts', async (t) => {
  const lines = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-wall-bad-'));
  fs.writeFileSync(path.join(dataDir, 'clubhouse.json'), '{ "clubhouse": { oops');
  const ctx = createApp({ dataDir, sportsFetch: offline, feedsFetch: offline, log: (...a) => lines.push(a.join(' ')) });
  await ctx.feeds.ready;
  t.after(() => {
    ctx.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  assert.equal(ctx.feeds.clubhouseOn, false);
  assert.ok(
    lines.some((l) => /not valid JSON/.test(l)),
    'a club file nobody can parse has to name itself in the log, or the volunteer gets a blank wall and no reason',
  );
  // A card that will not boot is worse than a wall that is not configured.
  assert.equal(typeof ctx.app, 'function');
});

test('a club file with no clubhouse section does not half-configure the wall', async (t) => {
  const lines = [];
  const { ctx } = await start(t, {
    club: (dir) => {
      const c = clubFixture(dir);
      delete c.clubhouse;
      return c;
    },
    log: (...a) => lines.push(a.join(' ')),
  });
  assert.equal(ctx.feeds.clubhouseOn, false);
  assert.ok(lines.some((l) => /no "clubhouse" section/.test(l)));
});

test('a league key the rest of the subsystem could not address is dropped', async (t) => {
  const { ctx } = await start(t, {
    club: (dir) => {
      const c = clubFixture(dir);
      c.leagues.push({ key: 'club/../../etc', source: 'manual', file: 'season.json' });
      return c;
    },
  });
  const keys = ctx.feeds.service.config.leagues.map((l) => l.key);
  assert.deepEqual(keys, ['club'], 'league keys are addressable in URLs, so they are checked like the rest');
});

test("the club file's own leagues reach the engine and win a key collision", async (t) => {
  const { ctx } = await start(t, {
    club: (dir) => {
      const c = clubFixture(dir);
      c.leagues[0].key = 'eng.1'; // the key the dashboard uses for the Premier League
      c.clubhouse.league = 'eng.1';
      return c;
    },
  });
  ctx.store.touch((d) => {
    d.settings.sports = { enabled: true, leagues: ['eng.1'], timezone: 'Europe/London' };
  });
  ctx.feeds.configure({ sports: ctx.store.data.settings.sports, widgets: {}, title: 'PitchTribe' });

  const leagues = ctx.feeds.service.config.leagues.filter((l) => l.key === 'eng.1');
  assert.equal(leagues.length, 1, 'one key, one league — a duplicate would show the division twice');
  assert.equal(leagues[0].source, 'manual', "it is this club's screen, so the card's own file wins");
});

test("the wall's own sub-resources are reachable with no credentials", async (t) => {
  // The page asks for `api/health`, `api/stream`, `badge` and `photos/…` *relative to
  // itself*, so under the /feeds mount they are /feeds/api/health and friends. The card
  // has no login and no token, and nobody is standing at it to type one.
  //
  // The health check is the one that would fail loudly in the wrong way: three misses
  // and the wall puts "No internet connection — unplug the white cable" across the top.
  // A 401 counts as a miss, so putting /feeds behind the dashboard login would hang a
  // permanent outage notice on a card whose broadband is perfectly fine.
  const { base } = await start(t, { club: clubFixture });
  for (const p of ['/feeds/clubhouse', '/feeds/api/health', '/feeds/badge', '/feeds/photos/team.jpg']) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 200, `${p} must answer a card that cannot authenticate`);
  }
  // The stream is held open, so it is read for its headers and dropped.
  const ac = new AbortController();
  const stream = await fetch(`${base}/feeds/api/stream`, { signal: ac.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') || '', /event-stream/);
  ac.abort();
});

test('a photograph is woven into the loop, served from the pool beside the club file', async (t) => {
  const { ctx, base } = await start(t, { club: clubFixture });
  const html = await wall(base, ctx);
  // Relative, because the page is mounted under /feeds on a card and absolute would
  // point at a path the app does not serve.
  assert.match(html, /src="photos\/team\.jpg"/, 'the photo pool resolves against the club file');
  assert.doesNotMatch(html, /src="\/photos\//, 'an absolute photo path is the standalone server, not a card');
});
