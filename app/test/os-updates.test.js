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
  const statusFile = path.join(dataDir, 'os-update-status.json');
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
    ['checkedAt', 'message', 'packages', 'rebootRequired', 'result', 'upgraded']);
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
