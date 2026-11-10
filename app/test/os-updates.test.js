'use strict';
/* The nightly Raspberry Pi OS update (deploy/update/) runs at half past three
   on a Pi nobody is watching, so every way it can go wrong is a silent one: an
   apt that stops to ask a question, an upgrade that removes Chromium, a reboot
   in the middle of a match day, or a failed update taking the club's backup
   down with it. These tests pin those decisions, and run the helper itself
   against a stub apt-get. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Without comment lines — these files explain in comments what they don't do,
    so "is this setting absent?" has to be asked of the instructions only. */
const code = (p) => read(p).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

const HELPER = path.join(ROOT, 'deploy', 'update', 'os-update.sh');

/** Runs the helper with a stub apt-get on PATH.
    @param apt   shell body for the stub; apt's arguments arrive in "$@"
    @param env   extra environment for the helper
    @returns { exit, stdout, stderr, status (the status file, parsed), calls } */
function runHelper(apt, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-os-update-'));
  const bin = path.join(dir, 'bin');
  const dataDir = path.join(dir, 'data');
  const calls = path.join(dir, 'calls');
  fs.mkdirSync(bin);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(bin, 'apt-get'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"$CALLS"\n${apt}\n`, { mode: 0o755 });
  const r = spawnSync('bash', [HELPER], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      // A BASH_ENV startup file (some sandboxes set one) rewrites PATH out from
      // under the stub before the helper's first line runs.
      BASH_ENV: '',
      CALLS: calls,
      DATA_DIR: dataDir,
      PITCHTRIBE_OS_UPDATE_REBOOT_FLAG: path.join(dir, 'reboot-required'),
      ...env,
    },
  });
  // env.DATA_DIR wins, so a test can run the helper twice over one data
  // directory and see what it carried forward.
  const statusFile = path.join(env.DATA_DIR || dataDir, 'os-update-status.json');
  return {
    exit: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    status: fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : null,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [],
    dir,
  };
}

/** A stub that answers every apt-get call the helper makes: `update` succeeds,
    the simulation offers `upgradable`, and the real upgrade succeeds unless
    `failUpgrade`. */
const stubApt = (upgradable = [], { failUpgrade = false } = {}) => `
simulate=
for a in "$@"; do [[ "$a" == --simulate ]] && simulate=1; done
case " $* " in
  *" update "*) exit 0 ;;
esac
if [[ -n "$simulate" ]]; then
${upgradable.map((p) => `  echo "Inst ${p} [1.0] (1.1 Raspbian:stable [arm64])"`).join('\n')}
  exit 0
fi
case " $* " in
  *" upgrade "*) exit ${failUpgrade ? 1 : 0} ;;
esac
exit 0
`;

const realUpgrades = (calls) => calls.filter((c) => / upgrade$| upgrade /.test(c) && !c.includes('--simulate'));

test('installs what is waiting, and records it for the dashboard', () => {
  const r = runHelper(stubApt(['chromium', 'openssl']));
  assert.equal(r.exit, 0, r.stderr);
  const upgrades = realUpgrades(r.calls);
  assert.equal(upgrades.length, 1, `expected one upgrade, got: ${r.calls.join(' | ')}`);
  assert.match(upgrades[0], /--with-new-pkgs upgrade/);
  // The dashboard's half of this: what ran, when, and whether a reboot is due.
  assert.equal(r.status.result, 'ok');
  assert.equal(r.status.upgraded, 2);
  assert.deepEqual(r.status.packages, ['chromium', 'openssl']);
  assert.equal(r.status.rebootRequired, false);
  assert.match(r.status.checkedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  // The .debs are no use once installed and an SD card has no room to spare.
  assert.ok(r.calls.some((c) => c.endsWith(' clean')), r.calls.join(' | '));
});

test('nothing waiting: the lists are refreshed, no upgrade is run', () => {
  const r = runHelper(stubApt([]));
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(realUpgrades(r.calls), []);
  assert.equal(r.status.result, 'ok');
  assert.equal(r.status.upgraded, 0);
  assert.deepEqual(r.status.packages, []);
});

test('offline is a quiet skip, not a failure — a club Pi is not always online', () => {
  // `apt-get update` fails when the club's connection is down or behind a
  // captive portal. Exiting non-zero would leave a failed unit on every card
  // that spends a week offline — and, through the drop-in, one every night.
  const r = runHelper('[[ " $* " == *" update "* ]] && { echo "Could not resolve host" >&2; exit 100; }\nexit 0');
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(realUpgrades(r.calls), []);
  assert.equal(r.status.result, 'offline');
  assert.equal(r.status.upgraded, 0);
});

test('an upgrade that stops half way says so instead of claiming success', () => {
  const r = runHelper(stubApt(['openssl'], { failUpgrade: true }));
  assert.notEqual(r.exit, 0);
  assert.equal(r.status.result, 'error');
  assert.match(r.status.message, /journalctl/);
});

test('apt output can never break the status file', () => {
  // The status file is written by a shell script, and apt's messages are the
  // one thing in it that PitchTribe didn't write.
  const r = runHelper(stubApt(['a-package" , "injected": [}']));
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(Object.keys(r.status).sort(),
    ['checkedAt', 'lastOkAt', 'message', 'packages', 'rebootRequired', 'result', 'upgraded']);
});

const OFFLINE_APT = '[[ " $* " == *" update "* ]] && { echo "Could not resolve host" >&2; exit 100; }\nexit 0';

test('a night that fails keeps the date of the last night that worked', () => {
  // `result` only says how tonight went. A Pi behind a captive guest network
  // reports `offline` every morning with a fresh `checkedAt` and installs
  // nothing for a month, so the dashboard needs the date of the last night
  // something was installed to be able to say that out loud.
  const first = runHelper(stubApt(['openssl']));
  assert.equal(first.status.result, 'ok');
  assert.equal(first.status.lastOkAt, first.status.checkedAt, 'a good night is its own lastOkAt');

  const dataDir = path.join(first.dir, 'data');
  const offline = runHelper(OFFLINE_APT, { DATA_DIR: dataDir });
  assert.equal(offline.status.result, 'offline');
  assert.equal(offline.status.lastOkAt, first.status.checkedAt);

  // And a second bad night carries the same date on, rather than the date of
  // the failure before it.
  const failed = runHelper(stubApt(['openssl'], { failUpgrade: true }), { DATA_DIR: dataDir });
  assert.equal(failed.status.result, 'error');
  assert.equal(failed.status.lastOkAt, first.status.checkedAt);
});

test('a card that has never managed an update says so instead of inventing a date', () => {
  const r = runHelper(OFFLINE_APT);
  assert.equal(r.status.result, 'offline');
  assert.equal(r.status.lastOkAt, null);
});

test('the previous status file cannot break the next one either', () => {
  // lastOkAt is the one value copied out of a file and back into JSON. The file
  // is root-owned, but it is still the only input here that this script didn't
  // write itself, so only timestamp characters are taken out of it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-os-prev-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'os-update-status.json'),
    '{\n  "checkedAt": "nonsense",\n  "lastOkAt": "x\\" , \\"injected\\": [}",\n  "result": "offline"\n}\n');
  const r = runHelper(OFFLINE_APT, { DATA_DIR: dataDir });
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(Object.keys(r.status).sort(),
    ['checkedAt', 'lastOkAt', 'message', 'packages', 'rebootRequired', 'result', 'upgraded']);
  assert.equal(r.status.lastOkAt, null);
});

test('no data directory yet (the installer runs this first) is not an error', () => {
  const r = runHelper(stubApt(['openssl']), { DATA_DIR: path.join(os.tmpdir(), 'pt-no-such-dir') });
  assert.equal(r.exit, 0, r.stderr);
});

test('a reboot-required flag reaches the dashboard, and nothing reboots', () => {
  const flag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-os-reboot-')), 'reboot-required');
  fs.writeFileSync(flag, '');
  const r = runHelper(stubApt(['linux-image-rpi-v8']), { PITCHTRIBE_OS_UPDATE_REBOOT_FLAG: flag });
  assert.equal(r.status.rebootRequired, true);
  assert.match(r.stdout, /needs a restart/);
  // The screen is the product: a Pi that restarts itself at 03:30 in the middle
  // of a tournament weekend is worse than a kernel update that waits.
  assert.doesNotMatch(code('deploy/update/os-update.sh'), /shutdown -r|systemctl reboot|\breboot now\b/);
});

test('the upgrade never removes packages and never asks a question', () => {
  const body = code('deploy/update/os-update.sh');
  // full-upgrade/dist-upgrade and autoremove may uninstall things to resolve a
  // change — at 03:30, with nobody in the building, that could take Chromium
  // or the kiosk off the card.
  assert.doesNotMatch(body, /full-upgrade|dist-upgrade|autoremove/);
  // There is no terminal to answer a config-file prompt, and PitchTribe edits
  // /etc/dnsmasq.conf and sshd_config — a package's own config must not win.
  assert.match(body, /DEBIAN_FRONTEND=noninteractive/);
  assert.match(body, /--force-confold/);
  assert.match(body, /--force-confdef/);
  // Another apt (a volunteer over SSH) should delay the run, not fail it.
  assert.match(body, /DPkg::Lock::Timeout/);
});

test("the nightly run is the backup's schedule, so it cannot drift from it", () => {
  // One schedule, not two: the drop-in makes the nightly backup pull the update
  // in and wait for it, which is what "every night, before the backup" means.
  const dropIn = read('deploy/update/10-os-update.conf');
  assert.match(dropIn, /^\[Unit\]$/m);
  assert.match(dropIn, /^Wants=pitchtribe-os-update\.service$/m);
  assert.match(dropIn, /^After=pitchtribe-os-update\.service$/m);
  // Requires= would mean an offline Pi, or a broken archive, leaves the club
  // without a backup of its content that night.
  assert.doesNotMatch(code('deploy/update/10-os-update.conf'), /Requires=/);
  // It is a drop-in for the nightly instance only: the same template also runs
  // on every USB stick plug-in (scan) and on every dashboard request.
  const installer = read('deploy/install.sh');
  assert.match(installer, /pitchtribe-backup@nightly\.service\.d/);
  assert.doesNotMatch(installer, /pitchtribe-backup@(scan|request)\.service\.d/);
});

test('the update service is not enabled on its own: that would patch twice a night', () => {
  const unit = read('deploy/update/pitchtribe-os-update.service');
  assert.doesNotMatch(code('deploy/update/pitchtribe-os-update.service'), /\[Install\]|WantedBy=/);
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/pitchtribe-os-update$/m);
  // apt needs a route out of the club, not just an interface that is up.
  assert.match(unit, /^Wants=network-online\.target$/m);
  assert.match(unit, /^After=network-online\.target/m);
  // A first upgrade of an old card over club broadband is slow; the default
  // 90 seconds would kill it half way through a dpkg run.
  assert.match(unit, /^TimeoutStartSec=2h$/m);
  // Nothing in a dpkg run survives a read-only filesystem.
  assert.doesNotMatch(code('deploy/update/pitchtribe-os-update.service'),
    /ProtectSystem=|ReadOnlyPaths=|PrivateDevices=/);
});

test('an extra-screen Pi gets its own timer, a full PitchTribe does not', () => {
  const timer = read('deploy/update/pitchtribe-os-update.timer');
  assert.match(timer, /^OnCalendar=\*-\*-\* 03:00$/m);
  // A Pi switched off overnight (a clubhouse on a timer switch) still catches
  // up, exactly like the backup.
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^Unit=pitchtribe-os-update\.service$/m);
  // Installed only on the extra-screen path, and taken away again when a card
  // that was an extra screen is reinstalled as a full PitchTribe.
  assert.match(read('deploy/install.sh'), /rm -f \/etc\/systemd\/system\/pitchtribe-os-update\.timer/);
});

test('the installer patches the card on the way in, and can be told not to', () => {
  const installer = read('deploy/install.sh');
  assert.match(installer, /install -m 0755 "\$SRC_DIR\/deploy\/update\/os-update\.sh" \/usr\/local\/bin\/pitchtribe-os-update/);
  // Not fatal: a club behind a slow or filtered connection must still end up
  // with a working screen, and tonight's run picks the updates up.
  assert.match(installer, /pitchtribe-os-update \|\| log/);
  assert.match(installer, /PITCHTRIBE_NO_OS_UPGRADE/);
});

test('the helper is valid bash and ships executable', () => {
  const r = spawnSync('bash', ['-n', HELPER], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // install.sh installs it 0755, and it is also run straight out of a checkout.
  assert.ok(fs.statSync(HELPER).mode & 0o111, 'deploy/update/os-update.sh should be executable');
});

/* ---------------------------------------------------------------- the dashboard
   What Settings → About makes of that file (app/lib/os-update.js). The point of
   these is the judgements the file itself can't make, because they are about
   today's date: a nightly job that has stopped running, and a Pi that keeps
   running it and keeps failing. /api/state carrying the result is covered in
   api.test.js. */
const { osUpdateView, SILENT_DAYS, UNPATCHED_DAYS } = require('../lib/os-update');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400_000).toISOString();

/** Writes a status file and returns the view of it. */
function viewOf(status, now = NOW) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-os-view-'));
  if (status !== null) fs.writeFileSync(path.join(dataDir, 'os-update-status.json'), typeof status === 'string' ? status : JSON.stringify(status));
  return osUpdateView(dataDir, now);
}

const okStatus = (extra = {}) => ({
  checkedAt: daysAgo(0), lastOkAt: daysAgo(0), result: 'ok', upgraded: 0,
  packages: [], rebootRequired: false, message: 'already up to date', ...extra,
});

test('a dashboard that is not on a Pi has nothing to show, and says nothing', () => {
  // No file at all (a laptop, or docker-compose), and a file caught half
  // written. Neither is a fault worth putting on a volunteer's screen.
  assert.deepEqual(viewOf(null), { available: false });
  assert.deepEqual(viewOf('{ "checkedAt": '), { available: false });
  assert.deepEqual(viewOf('null'), { available: false });
  assert.deepEqual(viewOf('[1, 2]').available, false);
});

test('last night’s run, as the About card shows it', () => {
  const v = viewOf(okStatus({ upgraded: 2, packages: ['chromium', 'openssl'], message: 'installed 2 update(s)' }));
  assert.equal(v.available, true);
  assert.equal(v.result, 'ok');
  assert.equal(v.upgraded, 2);
  assert.deepEqual(v.packages, ['chromium', 'openssl']);
  assert.equal(v.daysSinceCheck, 0);
  assert.equal(v.daysSincePatched, 0);
  assert.equal(v.silent, false);
  assert.equal(v.unpatched, false);
  assert.equal(v.level, 'ok');
});

test('a waiting restart is the one thing this has to say', () => {
  // The helper deliberately never reboots a screen, so an installed kernel fix
  // does nothing at all until somebody is asked.
  const v = viewOf(okStatus({ upgraded: 1, packages: ['linux-image-rpi-v8'], rebootRequired: true }));
  assert.equal(v.rebootRequired, true);
  assert.equal(v.level, 'due', 'waiting for a person, not broken');
});

test('one offline night is normal; a fortnight of them is not', () => {
  const recent = viewOf({ ...okStatus(), result: 'offline', lastOkAt: daysAgo(1), message: 'could not reach the package archive' });
  assert.equal(recent.unpatched, false);
  assert.equal(recent.level, 'due');

  const weeks = viewOf({ ...okStatus(), result: 'offline', lastOkAt: daysAgo(UNPATCHED_DAYS + 16) });
  assert.equal(weeks.unpatched, true, 'nothing installed for a month — the card has stopped being patched');
  assert.equal(weeks.daysSincePatched, UNPATCHED_DAYS + 16);
  assert.equal(weeks.silent, false, 'it is running every night; that is what makes it quiet');
  assert.equal(weeks.level, 'warn');

  // A card that has never once managed it: no date to count from, same answer.
  const never = viewOf({ ...okStatus(), result: 'offline', lastOkAt: null });
  assert.equal(never.unpatched, true);
  assert.equal(never.daysSincePatched, null);
});

test('a nightly job that has stopped running is not an up-to-date Pi', () => {
  // The last thing it wrote said "ok", which would read as reassuring — a
  // clubhouse on a timer switch, or a timer that never got enabled.
  const v = viewOf(okStatus({ checkedAt: daysAgo(SILENT_DAYS + 3), lastOkAt: daysAgo(SILENT_DAYS + 3) }));
  assert.equal(v.silent, true);
  assert.equal(v.daysSinceCheck, SILENT_DAYS + 3);
  assert.equal(v.level, 'warn');
  assert.equal(viewOf(okStatus({ checkedAt: daysAgo(1), lastOkAt: daysAgo(1) })).silent, false, 'a missed night is not a fault');
});

test('an upgrade that stopped half way is shown as a fault, not as 0 updates', () => {
  const v = viewOf({ ...okStatus(), result: 'error', message: 'apt-get upgrade failed — see journalctl -u pitchtribe-os-update' });
  assert.equal(v.level, 'warn');
  assert.match(v.message, /journalctl/);
});

test('nothing in the status file reaches the dashboard unbounded or untyped', () => {
  const v = viewOf({
    checkedAt: 'not a date', lastOkAt: 12345, result: 'something else',
    upgraded: '7', packages: 'openssl', rebootRequired: 'true', message: 'x'.repeat(5000),
  });
  assert.equal(v.checkedAt, null);
  assert.equal(v.lastOkAt, null);
  assert.equal(v.result, 'error', 'an unknown result is a fault, not a pass');
  assert.equal(v.upgraded, 0);
  assert.deepEqual(v.packages, []);
  assert.equal(v.rebootRequired, false, 'only a real boolean asks a club to restart a screen');
  assert.equal(v.message.length, 200);
  assert.equal(v.daysSinceCheck, null);

  // The first upgrade of an old card can name a hundred packages.
  const many = viewOf(okStatus({ upgraded: 120, packages: Array.from({ length: 120 }, (_, i) => `pkg-${i}`) }));
  assert.equal(many.packages.length, 40);
  assert.equal(many.upgraded, 120, 'the count is what ran, not what is listed');
});
