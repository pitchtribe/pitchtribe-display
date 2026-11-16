'use strict';
/* This line's own club directory, put on a card the way an install does it.
 *
 * Every other test of the wall supplies its own fixture. That is what let the same
 * fault ship twice: the engine was configured directly (#34), then the app was
 * handed a club file directly (#43), and both times the thing nobody exercised was
 * the path a flashed card actually takes. `caldecote-0.0.1` served the wall with our
 * name on it; `0.0.2` fixed that and still needed four commands typed on a Pi in a
 * pavilion. Each was a green suite around a card that could not show the club.
 *
 * So these tests take no fixture. They run the real deploy/club-content.sh against
 * the real caldecote/ directory in this checkout, then boot the app on whatever
 * landed and ask it for the page the kiosk opens. If Caldecote's content stops being
 * installable — a renamed file, a season file that stops being JSON, a card.env that
 * points somewhere else — this fails here rather than on a wall in Upper Caldecote.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');

const ROOT = path.join(__dirname, '..', '..');
const MARKER = path.join(ROOT, '.pitchtribe-club');
const offline = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });

/** The club this line is for, as the installer and the image build work it out. */
function clubDir() {
  assert.ok(
    fs.existsSync(MARKER),
    'this is a club line, so .pitchtribe-club must name its club directory — without it install.sh and image/build.sh place no club content and a flashed card boots as a playlist player',
  );
  const name = fs.readFileSync(MARKER, 'utf8').trim();
  assert.match(name, /^[A-Za-z0-9._-]+$/, 'the marker is joined onto a path, so it names one directory and nothing else');
  return path.join(ROOT, name);
}

/** Flash a card: run the real script against the real club directory. */
function install(t, { dataFiles = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-caldecote-'));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  for (const [name, body] of Object.entries(dataFiles)) fs.writeFileSync(path.join(data, name), body);
  // What install.sh has already written by the time club content goes on, including
  // the origin a relative value in card.env is hung off.
  const kioskEnv = path.join(dir, 'pitchtribe-kiosk');
  fs.writeFileSync(kioskEnv, 'PITCHTRIBE_URL=http://localhost/player/?screen=@HOSTNAME@\nCHROMIUM=/usr/bin/chromium\n');
  const out = spawnSync('bash', [path.join(ROOT, 'deploy', 'club-content.sh'), clubDir(), data, kioskEnv], {
    encoding: 'utf8',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { data, kioskEnv, out };
}

/** Start the app on a data directory, as install.sh does on the card. */
async function start(t, data) {
  const ctx = createApp({ dataDir: data, sportsFetch: offline, feedsFetch: offline, log: () => {} });
  await ctx.feeds.ready;
  const server = await new Promise((r) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => r(s));
  });
  t.after(() => {
    ctx.close();
    server.closeAllConnections();
    server.close();
  });
  return { ctx, base: `http://127.0.0.1:${server.address().port}` };
}

test('the club directory this line names is one the installer can actually place', (t) => {
  const club = clubDir();
  const { out } = install(t);
  assert.equal(out.status, 0, `putting ${path.basename(club)} on a card failed:\n${out.stderr}`);
  // Not a no-op that passes: the script refuses a missing or empty card/ directory,
  // so a zero exit here means content genuinely went on.
  assert.ok(fs.existsSync(path.join(club, 'card')), 'a club directory holds card/');
});

test('a flashed card comes up as Caldecote, with nobody typing anything on the Pi', async (t) => {
  const { data, kioskEnv } = install(t);

  // The three things the wall reads, in the data directory, placed by the install.
  assert.ok(fs.existsSync(path.join(data, 'clubhouse.json')), 'the club file is what turns the wall on at all');
  assert.ok(fs.existsSync(path.join(data, 'season.json')), 'the season file the club file points at');
  assert.ok(fs.statSync(path.join(data, 'photos')).isDirectory(), 'the photo pool arrives as a directory, empty or not');

  // Without this the card serves the wall correctly and opens /player, which on a
  // card with no playlist is an empty screen in a building.
  assert.match(
    fs.readFileSync(kioskEnv, 'utf8'),
    /^PITCHTRIBE_URL=http:\/\/localhost\/feeds\/clubhouse$/m,
    'card.env must point the kiosk at the wall, relative to the origin the installer wrote',
  );

  const { ctx, base } = await start(t, data);
  assert.equal(ctx.feeds.clubhouseOn, true, 'the app read the club file and turned the wall on');
  await ctx.feeds.refresh();
  const html = await (await fetch(`${base}/feeds/clubhouse`)).text();
  assert.match(html, /Caldecote FC/, 'it is their screen and their name goes on it');
  assert.doesNotMatch(html, /<title>PitchTribe<\/title>/, 'our name is not what the room came to read');
  assert.match(html, /Harvey Close/, 'the building, from the strapline the club file carries');
});

test('an empty season puts no football on the wall rather than inventing some', async (t) => {
  // season.json ships empty on purpose: it is where the week's results are typed in.
  // A card flashed before anybody has done that is correct, not broken — it shows the
  // club, the countdown and the photographs. What it must never do is show a score.
  const { data } = install(t);
  const season = JSON.parse(fs.readFileSync(path.join(data, 'season.json'), 'utf8'));
  assert.deepEqual(season.events, [], 'the shipped season is empty');

  const { ctx, base } = await start(t, data);
  await ctx.feeds.refresh();
  const html = await (await fetch(`${base}/feeds/clubhouse`)).text();

  // The slides themselves, not the stylesheet or the script — both of those carry
  // digits and dates of their own, and scanning the whole document would make this
  // pass or fail for reasons that have nothing to do with football.
  const wall = /<div class="wall">([\s\S]*?)\n<\/div>/.exec(html);
  assert.ok(wall, 'the page renders a wall');
  const kinds = [...wall[1].matchAll(/<section class="slide ([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    kinds.sort(),
    ['countdown', 'identity'],
    'with no results typed in and no photographs, the only honest slides are who the club is and how long until Saturday',
  );
  assert.doesNotMatch(wall[1], /class="[^"]*\bscore\b/, 'no score can appear when no match has been typed in');
  assert.match(wall[1], /Caldecote FC/, 'and the wall is still the club’s, not a blank screen');
});

test('the club file and the season file are both readable, and point at each other correctly', (t) => {
  const { data } = install(t);
  // A hand-edited JSON file on a club line is the likeliest thing to break, and the
  // app's answer to unreadable JSON is to leave the wall unconfigured — a card that
  // shows our name again. Cheaper to fail here.
  const club = JSON.parse(fs.readFileSync(path.join(data, 'clubhouse.json'), 'utf8'));
  JSON.parse(fs.readFileSync(path.join(data, 'season.json'), 'utf8'));

  assert.ok(club.clubhouse, 'no "clubhouse" section means the wall stays off and the card shows a playlist');
  // Relative paths resolve against the club file, so every one of them has to have
  // landed in the same directory. A rename that misses one is silent on screen.
  for (const league of club.leagues || []) {
    if (!league.file) continue;
    assert.ok(
      fs.existsSync(path.join(data, league.file)),
      `league "${league.key}" reads ${league.file}, which did not arrive on the card`,
    );
  }
  if (club.clubhouse.photosDir) {
    assert.ok(fs.existsSync(path.join(data, club.clubhouse.photosDir)), 'the photo pool the club file names');
  }
  if (club.clubhouse.badge) {
    assert.ok(fs.existsSync(path.join(data, club.clubhouse.badge)), 'the badge the club file names');
  }
  // Saturday is the one thing about this club's week the brief establishes: 16+,
  // Saturdays, a bar. The other days are deliberately closed rather than guessed, so
  // they are not pinned here — they change when somebody asks the club.
  assert.ok(
    (club.clubhouse.openingHours?.sat || []).length > 0,
    'a wall that is dark on a Saturday is dark when the room is full',
  );
});

test('upgrading a working club card keeps the season somebody typed in', async (t) => {
  // The failure this guards is losing a volunteer's Saturday evening to an upgrade.
  // The empty season.json in the build must not replace a filled-in one.
  const typedIn = JSON.stringify({
    name: 'Bedfordshire County League',
    club: { name: 'Caldecote FC', aliases: ['Caldecote'] },
    events: [{ id: 'typed', start: '2026-11-14T15:00:00Z', status: 'final', home: 'Caldecote FC', away: 'Cranfield United', homeScore: 3, awayScore: 2 }],
  });
  const { data } = install(t, { dataFiles: { 'season.json': typedIn } });
  assert.equal(fs.readFileSync(path.join(data, 'season.json'), 'utf8'), typedIn);
});
