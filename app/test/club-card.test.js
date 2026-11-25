'use strict';
/* deploy/club-content.sh — how one club's own content gets onto a card.

   These run the real script in a temporary directory, as an ordinary user, so
   what is tested is the behaviour rather than the wording of the file.

   Why they exist: a club card is flashed, carried to a building and switched on
   by somebody with no keyboard. If the content is not already on it, the card
   serves the right page with the wrong club on it — HTTP 200, deliberate
   looking, nobody notices in a screenshot. That shipped once. The other half is
   the opposite mistake: the first upgrade of a working club card must not throw
   away the season somebody typed in on a Saturday evening. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'deploy', 'club-content.sh');
const read = (p) => fs.readFileSync(p, 'utf8');
/** Without comment lines: these scripts explain in comments what they don't do. */
const code = (p) => read(path.join(ROOT, p)).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

const PLAYER_URL = 'PITCHTRIBE_URL=http://localhost/player/?screen=@HOSTNAME@';

/** A club directory, a data directory and a kiosk environment file, like an install. */
function rig({ cardFiles = { 'clubhouse.json': '{"clubhouse":{}}', 'season.json': '{"events":[]}' }, cardEnv = 'PITCHTRIBE_URL=/feeds/clubhouse\n', dataFiles = {}, kiosk = `# a comment\n${PLAYER_URL}\nCHROMIUM=/usr/bin/chromium\n` } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-club-'));
  const club = path.join(dir, 'caldecote');
  const card = path.join(club, 'card');
  fs.mkdirSync(card, { recursive: true });
  for (const [name, body] of Object.entries(cardFiles)) {
    fs.mkdirSync(path.dirname(path.join(card, name)), { recursive: true });
    fs.writeFileSync(path.join(card, name), body);
  }
  if (cardEnv !== null) fs.writeFileSync(path.join(club, 'card.env'), cardEnv);
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  for (const [name, body] of Object.entries(dataFiles)) fs.writeFileSync(path.join(data, name), body);
  const kioskEnv = kiosk === null ? '' : path.join(dir, 'pitchtribe-kiosk');
  if (kiosk !== null) fs.writeFileSync(kioskEnv, kiosk);
  return { dir, club, card, data, kioskEnv };
}

const run = (r, args = null) =>
  spawnSync('bash', args || [SCRIPT, r.club, r.data, r.kioskEnv], { encoding: 'utf8' });

test('a flashed club card comes up as the club: content placed, kiosk pointed at the wall', () => {
  const r = rig();
  const out = run(r);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(read(path.join(r.data, 'clubhouse.json')), '{"clubhouse":{}}');
  assert.equal(read(path.join(r.data, 'season.json')), '{"events":[]}');
  const env = read(r.kioskEnv);
  // The whole point: without this line the card serves /player and the wall is
  // a page nobody ever opens.
  assert.match(env, /^PITCHTRIBE_URL=http:\/\/localhost\/feeds\/clubhouse$/m);
  assert.ok(!env.includes('/player/'), `the player URL was left behind:\n${env}`);
  // Everything else the installer wrote stays: the kiosk cannot start without it.
  assert.match(env, /^CHROMIUM=\/usr\/bin\/chromium$/m);
  assert.match(env, /^# a comment$/m);
});

test('a relative URL hangs off the origin the installer wrote, so a hub-served card stays on its hub', () => {
  const r = rig({ kiosk: 'PITCHTRIBE_URL=http://hub.local:8080/player/?screen=@HOSTNAME@\n' });
  assert.equal(run(r).status, 0);
  assert.match(read(r.kioskEnv), /^PITCHTRIBE_URL=http:\/\/hub\.local:8080\/feeds\/clubhouse$/m);
});

test('an upgrade never overwrites what is already on the card', () => {
  // The season is typed in on the card, on a Saturday evening, by a volunteer.
  // Replacing it with the empty file from the build is losing their week.
  const season = '{"events":[{"id":"real","start":"2026-11-14T15:00:00Z"}]}';
  const r = rig({ dataFiles: { 'season.json': season } });
  const out = run(r);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(read(path.join(r.data, 'season.json')), season);
  assert.match(out.stdout, /kept this card's own season\.json/);
  // …and the file that was missing is still placed.
  assert.equal(read(path.join(r.data, 'clubhouse.json')), '{"clubhouse":{}}');
});

test('running it twice changes nothing the second time', () => {
  const r = rig();
  assert.equal(run(r).status, 0);
  const first = read(r.kioskEnv);
  assert.equal(run(r).status, 0);
  assert.equal(read(r.kioskEnv), first, 'the kiosk file grew a second PITCHTRIBE_URL line');
  assert.equal(read(r.kioskEnv).match(/^PITCHTRIBE_URL=/gm).length, 1);
});

test('the photo pool arrives as a directory, not as a file', () => {
  const r = rig({ cardFiles: { 'clubhouse.json': '{}', 'photos/README.md': 'drop pictures here' } });
  assert.equal(run(r).status, 0);
  assert.ok(fs.statSync(path.join(r.data, 'photos')).isDirectory());
  assert.equal(read(path.join(r.data, 'photos', 'README.md')), 'drop pictures here');
});

test('a named club directory that is missing or empty fails the install rather than passing quietly', () => {
  const r = rig();
  // Missing: the one thing that must never read as "fine, carry on".
  const gone = run(r, [SCRIPT, path.join(r.dir, 'nosuchclub'), r.data, r.kioskEnv]);
  assert.notEqual(gone.status, 0);
  assert.match(gone.stderr, /no club directory/);
  // Named but with nothing in it: the card would boot as a playlist player.
  const empty = rig({ cardFiles: {} });
  const out = run(empty);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /playlist player/);
  // And a club directory with no card/ at all.
  fs.rmSync(path.join(empty.club, 'card'), { recursive: true });
  assert.notEqual(run(empty).status, 0);
});

test('a card with no screen of its own still gets its content, and says why card.env was skipped', () => {
  // PITCHTRIBE_NO_KIOSK=1 — a server-only Pi. install.sh passes no kiosk file.
  const r = rig({ kiosk: null });
  const out = spawnSync('bash', [SCRIPT, r.club, r.data, ''], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(read(path.join(r.data, 'clubhouse.json')), '{"clubhouse":{}}');
  assert.match(out.stdout, /no kiosk environment file/);
});

test('a club directory with no card.env leaves the kiosk pointed where it is', () => {
  const r = rig({ cardEnv: null });
  assert.equal(run(r).status, 0);
  assert.match(read(r.kioskEnv), /\/player\//);
});

test('card.env is read strictly: a line that is not KEY=value stops the install', () => {
  const r = rig({ cardEnv: 'PITCHTRIBE_URL=/feeds/clubhouse\nthis is not a setting\n' });
  const out = run(r);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /card\.env/);
});

test('install.sh and the image build find a club line by its marker file, and refuse a path for one', () => {
  const install = code('deploy/install.sh');
  const build = code('image/build.sh');
  for (const [name, src] of [['install.sh', install], ['image/build.sh', build]]) {
    assert.match(src, /\.pitchtribe-club/, `${name} does not look for the club-line marker`);
    // The marker is joined onto a path. "caldecote/../.." names somebody else's
    // directory, and a leading dot is how you name the checkout itself.
    assert.match(src, /\^\[A-Za-z0-9\._-\]\+\$/, `${name} does not restrict what the marker may name`);
  }
  // The content must go into the chroot, or the image is built without it and
  // the card boots as a playlist player — which is exactly caldecote-0.0.1.
  assert.match(build, /cp -a "\$ROOT\/\$CLUB" "\$ROOT\/\.pitchtribe-club" "\$MNT\/tmp\/pitchtribe\/"/);
  assert.match(install, /deploy\/club-content\.sh" "\$CLUB_DIR" "\$DATA_DIR"/);
  // Not `|| true`: see club-content.sh's header.
  assert.ok(
    !/club-content\.sh".*\|\| true/.test(install),
    'a failing club-content.sh must fail the install, not be swallowed',
  );
});

test('the kiosk waits on the origin, not on a path under the player page', () => {
  // A club card points at /feeds/clubhouse. Deriving the health URL by cutting
  // the string at "/player" leaves it polling a path that cannot exist, so the
  // kiosk waits its full minute on every boot and then opens anyway.
  const kiosk = code('deploy/kiosk.sh');
  assert.match(kiosk, /origin=/);
  assert.ok(!/URL%%\/player/.test(kiosk), 'the health URL is still derived from "/player"');
  assert.match(kiosk, /\$\{origin\}\/healthz/);
});
