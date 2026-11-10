'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const helper = require('../bin/remote-access');

const HASH = execFileSync('openssl', ['passwd', '-6', '-stdin'], { input: 'long-enough-password', encoding: 'utf8' }).trim();

const SIGNIN_URL = 'https://connect.raspberrypi.com/verify/ABCD-1234';
const SIGNIN_OK = `Complete sign in by visiting ${SIGNIN_URL}\n`;

function fakePi({
  users = [], connect = true, supportUser = '', signin = SIGNIN_OK, runtimeDir = true, stubborn = false,
  // A bus that goes away with linger, which is what really happens: disable-linger
  // stops user@<uid>.service and /run/user/<uid> goes with it.
  busNeedsLinger = false,
  // Who is signed in under which login, for the second-client cases.
  signedInAs = [],
  /* Whether somebody goes to the verification URL. `rpi-connect signin` prints
     a link and then waits, so false is the real state of a Pi in the moments
     after switching support access on: the link is up, nobody has used it yet. */
  completeSignin = true,
  mirrorGroup = 'pitchtribe-dashboard',
  /* Whether systemd-timesyncd has stepped the clock from the network yet. True
     is an ordinary card; false is the fifteen seconds after a cold boot, when
     the clock is fake-hwclock's last save and nothing about the *order* of two
     timestamps can be believed. */
  clockSynced = true,
  /* Whether the process whose pid is in the lock file is still running. The
     lock is stolen from a holder that is gone, not from one that is slow, so
     the tests have to be able to say which this is. */
  pidAlive = () => false,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ra-'));
  // Root's own directory, outside the one the dashboard's user owns.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ra-state-'));
  // /run/pitchtribe: root's, with the sign-in log inside it handed to the club user.
  const signinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ra-run-'));
  const passwd = path.join(dir, 'passwd');
  const group = path.join(dir, 'group');
  const lines = [
    'root:x:0:0:root:/root:/bin/bash',
    'sshd:x:100:65534::/run/sshd:/usr/sbin/nologin',
    'pitchtribe:x:999:999::/var/lib/pitchtribe:/usr/sbin/nologin',
    ...users.map((u, i) => `${u}:x:${1000 + i}:${1000 + i}::/home/${u}:/bin/bash`),
  ];
  fs.writeFileSync(passwd, `${lines.join('\n')}\n`);
  // The dashboard's own group, with the dashboard's own user in it and nothing
  // else — not `pitchtribe`, which the captive portal's user is also in.
  fs.writeFileSync(group, `pitchtribe:x:999:pitchtribe-portal\npitchtribe-dashboard:x:1500:pitchtribe\n`);
  const calls = [];
  const warnings = [];
  let ssh = 'disabled';
  // What the fake rpi-connect reports, moved along by the calls made to it.
  const pi = { connectOn: false, linger: new Set(), shellSessions: 0, signinUnit: false, signedInAs: new Set(signedInAs) };
  // `signedIn` reads as "anybody on this card", which is what the assertions mean.
  Object.defineProperty(pi, 'signedIn', {
    get: () => pi.signedInAs.size > 0,
    set: (v) => { if (v) pi.signedInAs.add(users[0]); else pi.signedInAs.clear(); },
  });
  // Where the sign-in unit writes its output.
  const signinLog = (user = users[0]) => path.join(signinDir, `pitchtribe-support-signin-${user}.log`);
  let now = new Date('2026-11-04T14:00:00Z');
  const whoami = (args) => {
    const env = args.find((a) => String(a).startsWith('XDG_RUNTIME_DIR=')) || '';
    const uid = Number(env.split('/').pop());
    return (lines.find((l) => Number(l.split(':')[2]) === uid) || '').split(':')[0];
  };
  const exec = (cmd, args, input) => {
    calls.push({ cmd: [cmd, ...args].join(' '), input });
    if (cmd === 'useradd') fs.appendFileSync(passwd, `${args.at(-1)}:x:1500:1500::/home/${args.at(-1)}:/bin/bash\n`);
    if (cmd === 'systemctl' && args[0] === 'enable') ssh = 'enabled';
    if (cmd === 'systemctl' && args[0] === 'disable') ssh = 'disabled';
    if (cmd === 'systemctl' && args[0] === 'is-enabled') return `${ssh}\n`;
    if (cmd === 'systemctl' && args[0] === 'is-active') return ssh === 'enabled' ? 'active\n' : 'inactive\n';
    if (cmd === 'sh' && args[1] === 'command -v rpi-connect') {
      if (!connect) throw Object.assign(new Error('rpi-connect: not found'), { status: 1 });
      return '/usr/bin/rpi-connect\n';
    }
    if (cmd === 'loginctl' && args[0] === 'show-user') return `Linger=${pi.linger.has(args[1]) ? 'yes' : 'no'}\n`;
    if (cmd === 'loginctl' && args[0] === 'enable-linger') pi.linger.add(args[1]);
    if (cmd === 'loginctl' && args[0] === 'disable-linger') pi.linger.delete(args[1]);
    if (cmd === 'runuser') {
      const who = whoami(args);
      // Without linger there is no user@<uid>.service, so there is no bus to
      // ask anything over — including whether the sign-out actually worked.
      if (busNeedsLinger && !pi.linger.has(who)) {
        throw Object.assign(new Error('Failed to connect to bus: No such file or directory'), { status: 1, stdout: '' });
      }
      const i = args.indexOf('rpi-connect');
      if (i < 0) {
        // The only other thing run as that user: their own systemctl.
        const sub = args.slice(args.indexOf('systemctl') + 1);
        if (sub.includes('stop')) pi.signinUnit = false;
        return '';
      }
      const sub = args.slice(i + 1);
      if (sub[0] === 'on') pi.connectOn = true;
      if (sub[0] === 'off') pi.connectOn = false;
      // A Pi that will not sign out: the one case where saying "it is off" would
      // be a lie, so the helper has to check rather than assume.
      if (sub[0] === 'signout' && !stubborn) { pi.signedInAs.delete(who); pi.shellSessions = 0; }
      if (sub[0] === 'signin') {
        // systemd-run starts the unit and returns; the unit writes the
        // verification URL to the file it was told to append to, and somebody
        // at a browser finishes the pairing.
        pi.signinUnit = true;
        fs.writeFileSync(signinLog(who), signin, { mode: 0o600 });
        // A sign-in only ever completes if a verification URL was offered, and
        // then only once somebody has been to it.
        if (signin.includes('/verify/') && completeSignin) pi.signedInAs.add(who);
      }
      if (sub[0] === 'status') {
        const live = pi.signedInAs.has(who);
        return `Signed in: ${live ? 'yes' : 'no'}\nScreen sharing: ${pi.connectOn ? 'allowed' : 'not allowed'}\n`
          + `Remote shell: allowed (${live ? pi.shellSessions : 0} sessions active)\n`;
      }
    }
    return '';
  };
  const o = {
    dataDir: dir,
    stateDir,
    passwdFile: passwd,
    groupFile: group,
    supportUser,
    mirrorGroup,
    signinDir,
    now: () => now,
    exec,
    hasRuntimeDir: () => runtimeDir,
    clockSynced: () => clockSynced,
    pidAlive,
    // The real waits are 10s and 30s; there is nothing to wait for here.
    runtimeWaitMs: 20,
    signinWaitMs: 20,
    /* The real ones are 60s to give up waiting and 15 minutes before a lock
       with no readable pid is nobody's — which has to be above the longest
       legitimate hold (one rpi-connect call per login at 30s each against a
       wedged rpi-connectd, so minutes), not below it. */
    lockWaitMs: 30,
    lockStaleMs: 200,
    sleep: () => {},
    warn: (m) => warnings.push(m),
  };
  /* `at` is in it because the real route puts it there and the helper now reads
     it: a request has to be recent as well as unseen. Taken from the fake clock
     so that moving the clock moves the request's age with it. */
  const ask = (req) => {
    fs.writeFileSync(path.join(dir, 'remote-access-request.json'), JSON.stringify({ at: now.toISOString(), ...req }));
    return helper.main('request', o);
  };
  const ran = (re) => calls.filter((c) => re.test(c.cmd)).map((c) => c.cmd);
  const sessionFile = path.join(stateDir, 'support-session.json');
  const session = () => { try { return JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch { return null; } };
  const setSession = (s) => fs.writeFileSync(sessionFile, JSON.stringify(s));
  return {
    o,
    calls,
    warnings,
    ask,
    ran,
    dir,
    stateDir,
    signinDir,
    pi,
    signinLog,
    session,
    setSession,
    sessionFile,
    statusFile: path.join(dir, 'remote-access-status.json'),
    requestFile: path.join(dir, 'remote-access-request.json'),
    at: (iso) => { now = new Date(iso); },
    /* A request written at a given moment and then left unread — `at` as the
       dashboard writes it, and the mtime to match, because the helper takes the
       older of the two and neither alone is enough to say how old it is. */
    strand: (req, iso) => {
      const f = path.join(dir, 'remote-access-request.json');
      fs.writeFileSync(f, JSON.stringify({ at: iso, ...req }));
      const when = new Date(iso);
      fs.utimesSync(f, when, when);
      return f;
    },
  };
}

test('remote access: status lists people, not system accounts', () => {
  const pi = fakePi({ users: ['dan'] });
  const s = helper.main('status', pi.o);
  assert.deepEqual(s.users, ['dan']);
  assert.equal(s.sshActive, false);
});

test('remote access: switching on creates the login, sets the password from a hash, starts SSH', () => {
  const pi = fakePi();
  const s = pi.ask({ id: 'r1', action: 'enable', username: 'clubadmin', passwordHash: HASH });
  assert.equal(s.last.ok, true, s.last.message);
  assert.equal(s.sshActive, true);
  assert.deepEqual(s.users, ['clubadmin']);
  assert.ok(pi.calls.some((c) => c.cmd === 'useradd --create-home --shell /bin/bash --groups sudo,adm,video,plugdev clubadmin'));
  const pw = pi.calls.find((c) => c.cmd === 'chpasswd -e');
  assert.equal(pw.input, `clubadmin:${HASH}\n`, 'only ever a hash, through stdin');
  assert.ok(pi.calls.some((c) => c.cmd === 'ssh-keygen -A'));
  assert.ok(!fs.existsSync(path.join(pi.dir, 'remote-access-request.json')), 'the request with the hash is removed');

  const off = pi.ask({ id: 'r2', action: 'disable' });
  assert.equal(off.sshActive, false);
  assert.deepEqual(off.users, ['clubadmin'], 'the login stays for next time');
});

test('remote access: an Imager login just gets a new password', () => {
  const pi = fakePi({ users: ['dan'] });
  const s = pi.ask({ id: 'r1', action: 'enable', username: 'dan', passwordHash: HASH });
  assert.equal(s.last.ok, true);
  assert.ok(!pi.calls.some((c) => c.cmd.startsWith('useradd')));
  assert.ok(pi.calls.some((c) => c.cmd === 'chpasswd -e'));
});

test('remote access: refuses system accounts, odd names and anything but a SHA-512 hash', () => {
  for (const [username, passwordHash, why] of [
    ['root', HASH, /different username/],
    ['pitchtribe', HASH, /different username/],
    ['sshd', HASH, /different username/],
    ['Bad Name', HASH, /different username/],
    ['clubadmin', 'plain-text-password', /could not be set/],
  ]) {
    const pi = fakePi();
    const s = pi.ask({ id: 'x', action: 'enable', username, passwordHash });
    assert.equal(s.last.ok, false, username);
    assert.match(s.last.message, why);
    assert.ok(!pi.calls.some((c) => c.cmd.startsWith('chpasswd') || c.cmd.startsWith('useradd')), `${username}: nothing changed`);
  }
  // A system account not in the reserved list is refused too.
  const pi = fakePi();
  fs.appendFileSync(pi.o.passwdFile, 'colord:x:120:120::/var/lib/colord:/usr/sbin/nologin\n');
  assert.match(pi.ask({ id: 'y', action: 'enable', username: 'colord', passwordHash: HASH }).last.message, /system account/);
});

test('remote access: the same request is only done once', () => {
  const pi = fakePi();
  pi.ask({ id: 'r1', action: 'enable', username: 'clubadmin', passwordHash: HASH });
  const n = pi.calls.length;
  fs.writeFileSync(path.join(pi.dir, 'remote-access-request.json'), JSON.stringify({ id: 'r1', action: 'disable' }));
  helper.main('request', pi.o);
  assert.ok(!pi.calls.slice(n).some((c) => c.cmd.includes('disable')));
});

// ------------------------------------------------- support access (Connect)

test('support access: off on a fresh card, and nothing has been asked of Connect', () => {
  const pi = fakePi({ users: ['dan'] });
  const s = helper.main('status', pi.o);
  assert.equal(s.support.enabled, false);
  assert.equal(s.support.installed, true, 'the client is there, it is just not on');
  assert.equal(s.support.expiresAt, null);
  assert.equal(s.support.signin, null);
  assert.deepEqual(pi.ran(/rpi-connect (on|signin)/), [], 'a status read never switches it on');
  assert.deepEqual(pi.ran(/enable-linger/), []);
});

test('support access: turning on signs in as the club login and reports the link to finish at', () => {
  // Nobody has been to the verification URL yet, which is the state of every
  // card in the moments after the club presses the button.
  const pi = fakePi({ users: ['dan'], completeSignin: false });
  const s = pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  assert.equal(s.last.ok, true, s.last.message);
  assert.equal(s.support.enabled, true);
  assert.equal(s.support.user, 'dan', 'the club’s own login, not root and not a PitchTribe account');
  assert.equal(s.support.hours, 6);
  assert.equal(s.support.expiresAt, '2026-11-04T20:00:00.000Z', 'six hours on from 14:00');
  assert.equal(s.support.signin.url, SIGNIN_URL);
  assert.equal(s.support.signin.code, 'ABCD-1234');
  assert.match(s.last.message, /ends by itself after 6 hours/);
  // And the link is shown from support.signin, never from last.message, which
  // the dashboard keeps long after the code has been used.
  assert.ok(!s.last.message.includes('/verify/'), 'the code does not go into last.message');

  // Through that user's own session, and never as root.
  const on = pi.ran(/rpi-connect on/)[0];
  assert.ok(on.startsWith('runuser -u dan -- env XDG_RUNTIME_DIR=/run/user/1000 '), on);
  assert.match(on, /DBUS_SESSION_BUS_ADDRESS=unix:path=\/run\/user\/1000\/bus/);
  assert.ok(pi.ran(/rpi-connect signin/).length === 1, 'signed in once');
  // Linger, or the session would end at the next reboot with the dashboard
  // still saying support access is on.
  assert.deepEqual(pi.ran(/enable-linger/), ['loginctl enable-linger dan']);
  assert.equal(pi.pi.connectOn, true);

  // SSH is a separate thing and is left exactly as it was: read, never changed.
  assert.equal(s.sshActive, false, 'support access does not switch SSH on');
  assert.deepEqual(pi.ran(/^systemctl (?!is-)/), [], 'SSH state is read, never changed');
});

test('support access: ending it signs out, switches the client off and gives linger back', () => {
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  const s = pi.ask({ id: 's2', action: 'support-disable' });
  assert.equal(s.support.enabled, false);
  assert.equal(s.support.signedIn, false);
  assert.equal(s.support.expiresAt, null);
  assert.equal(s.support.signin, null, 'the old sign-in link is not left lying about');
  assert.ok(pi.ran(/rpi-connect signout/).length === 1);
  assert.ok(pi.ran(/rpi-connect off/).length === 1);
  assert.deepEqual(pi.ran(/disable-linger/), ['loginctl disable-linger dan'], 'we enabled it, so we take it away');
  assert.equal(pi.pi.connectOn, false);
  assert.ok(!fs.existsSync(path.join(pi.dir, 'remote-access-signin.log')), 'the sign-in output is removed');
});

test('support access: linger the club set up itself is left alone', () => {
  const pi = fakePi({ users: ['dan'] });
  pi.pi.linger.add('dan');
  pi.ask({ id: 's1', action: 'support-enable', hours: 1 });
  assert.deepEqual(pi.ran(/enable-linger/), [], 'already lingering, nothing to do');
  pi.ask({ id: 's2', action: 'support-disable' });
  assert.deepEqual(pi.ran(/disable-linger/), [], 'not ours to take away');
  assert.ok(pi.pi.linger.has('dan'));
});

test('support access: the timer ends a session that has run out, and leaves one that has not', () => {
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  const n = pi.calls.length;

  pi.at('2026-11-04T19:59:00Z');
  let s = helper.main('support-expire', pi.o);
  assert.equal(s.support.enabled, true, 'a minute to go — still on');
  assert.ok(!pi.calls.slice(n).some((c) => /signout/.test(c.cmd)));

  pi.at('2026-11-04T20:00:01Z');
  s = helper.main('support-expire', pi.o);
  assert.equal(s.support.enabled, false);
  assert.equal(s.last.action, 'support-expire');
  assert.match(s.last.message, /ran out/);
  assert.ok(pi.ran(/rpi-connect signout/).length === 1);
  assert.equal(pi.pi.connectOn, false);

  // And it does nothing at all the rest of the time.
  const m = pi.calls.length;
  helper.main('support-expire', pi.o);
  assert.ok(!pi.calls.slice(m).some((c) => /signout|rpi-connect off/.test(c.cmd)));
});

test('support access: a card that was off past its expiry comes back expired', () => {
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  // Unplugged for a fortnight. The timer's OnBootSec run is the first thing
  // that happens; the session must not be waiting to be used.
  pi.at('2026-11-18T09:00:00Z');
  const s = helper.main('support-expire', pi.o);
  assert.equal(s.support.enabled, false);
  assert.ok(pi.ran(/rpi-connect signout/).length === 1);
});

test('support access: refuses a length that is not on the list, and will not run unbounded', () => {
  for (const hours of [0, -1, 999, 7, 'forever', null, undefined, 1.5]) {
    const pi = fakePi({ users: ['dan'] });
    const s = pi.ask({ id: 'x', action: 'support-enable', hours });
    assert.equal(s.last.ok, false, `hours=${hours}`);
    assert.match(s.last.message, /how long support access lasts/);
    assert.equal(s.support.enabled, false);
    assert.deepEqual(pi.ran(/rpi-connect (on|signin)/), [], `hours=${hours}: nothing was switched on`);
    assert.deepEqual(pi.ran(/enable-linger/), []);
  }
});

test('support access: a sign-in that never produces a link leaves nothing switched on', () => {
  const pi = fakePi({ users: ['dan'], signin: 'error: failed to reach connect.raspberrypi.com\n' });
  const s = pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  assert.equal(s.last.ok, false);
  assert.equal(s.support.enabled, false);
  assert.ok(pi.ran(/rpi-connect off/).length === 1, 'the client is switched back off');
  assert.deepEqual(pi.ran(/disable-linger/), ['loginctl disable-linger dan']);
  assert.equal(pi.pi.connectOn, false);
});

test('support access: says so plainly when there is no Connect client or no login to use', () => {
  const noClient = fakePi({ users: ['dan'], connect: false });
  const a = noClient.ask({ id: 's1', action: 'support-enable', hours: 6 });
  assert.equal(a.last.ok, false);
  assert.match(a.last.message, /not installed/);
  assert.equal(a.support.installed, false);

  // A card flashed without an Imager login has nobody to run a user service as.
  const noLogin = fakePi({ users: [] });
  const b = noLogin.ask({ id: 's1', action: 'support-enable', hours: 6 });
  assert.equal(b.last.ok, false);
  assert.match(b.last.message, /no login account/);
  assert.deepEqual(noLogin.ran(/rpi-connect on/), []);
});

test('support access: SUPPORT_USER picks the login, and must be one that exists', () => {
  const pi = fakePi({ users: ['dan', 'clubadmin'], supportUser: 'clubadmin' });
  const s = pi.ask({ id: 's1', action: 'support-enable', hours: 4 });
  assert.equal(s.last.ok, true, s.last.message);
  assert.equal(s.support.user, 'clubadmin');
  assert.ok(pi.ran(/rpi-connect on/)[0].startsWith('runuser -u clubadmin -- env XDG_RUNTIME_DIR=/run/user/1001 '));

  const wrong = fakePi({ users: ['dan'], supportUser: 'nobody-here' });
  const bad = wrong.ask({ id: 's1', action: 'support-enable', hours: 4 });
  assert.equal(bad.last.ok, false);
  assert.match(bad.last.message, /is not a login on this Pi/);
});

test('support access: the request file is removed as it is read, same as an SSH one', () => {
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  assert.ok(!fs.existsSync(path.join(pi.dir, 'remote-access-request.json')));
  // And a replayed request is ignored, so a kept copy cannot re-open a session.
  pi.ask({ id: 's2', action: 'support-disable' });
  const n = pi.calls.length;
  fs.writeFileSync(path.join(pi.dir, 'remote-access-request.json'), JSON.stringify({ id: 's2', action: 'support-enable', hours: 24 }));
  const s = helper.main('request', pi.o);
  assert.equal(s.support.enabled, false);
  assert.ok(!pi.calls.slice(n).some((c) => /rpi-connect signin/.test(c.cmd)));
});

test('support access: a live support shell shows up in the status, and switching SSH does not disturb it', () => {
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  pi.pi.shellSessions = 1;
  pi.at('2026-11-04T15:00:00Z');
  let s = helper.main('status', pi.o);
  assert.equal(s.support.shellSessions, 1);
  assert.equal(s.support.signedIn, true);
  assert.equal(s.support.lastConnection, '2026-11-04T15:00:00.000Z');

  // Switching SSH on alongside leaves the support session exactly as it was.
  s = pi.ask({ id: 'r1', action: 'enable', username: 'clubadmin', passwordHash: HASH });
  assert.equal(s.sshActive, true);
  assert.equal(s.support.enabled, true);
  assert.equal(s.support.expiresAt, '2026-11-04T20:00:00.000Z');
  assert.equal(s.support.user, 'dan');
  // The new SSH login does not become a second place support access could be
  // signed in from, and is not signed in to anything.
  assert.equal(s.support.signedIn, true);
  assert.equal(pi.pi.signedInAs.size, 1);
});

test('support access: the verification code goes as soon as it has been used', () => {
  // While the club still has to visit the link, the dashboard needs it. The
  // moment the device is signed in it is of no further use to the club and of
  // every use to somebody who should not have it: whoever reaches that code
  // can pair the Pi to their own Raspberry Pi ID instead of the club's.
  const pi = fakePi({ users: ['dan'], completeSignin: false });
  let s = pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  assert.equal(s.support.signin.code, 'ABCD-1234', 'shown while it is waiting to be finished');
  assert.ok(JSON.parse(fs.readFileSync(pi.statusFile, 'utf8')).support.signin, 'and in the mirror the dashboard reads');

  // Somebody goes to the link.
  pi.pi.signedInAs.add('dan');
  s = helper.main('status', pi.o);
  assert.equal(s.support.enabled, true, 'the session carries on');
  assert.equal(s.support.signedIn, true);
  assert.equal(s.support.signin, null, 'the code is not kept once it has been used');
  const mirrored = JSON.parse(fs.readFileSync(pi.statusFile, 'utf8'));
  assert.equal(mirrored.support.signin, null);
  assert.ok(!JSON.stringify(mirrored).includes('/verify/'), 'nothing in the mirror still holds the code');
});

/* ---------------------------------------------------------------------------
   The device decides, not the record (PIT-29 S1/S2)

   remote-access-status.json lives in DATA_DIR, which belongs to the dashboard's
   own user — and a backup restore chowns everything in it to that user. So it
   is a mirror and never the authority: what bounds a session is kept in root's
   own directory, and the device itself is asked on every run. These are the
   cases where trusting the mirror would have left support access on, or on and
   invisible, or endable only in appearance.
   --------------------------------------------------------------------------- */

test('support access: losing the status mirror mid-session neither ends it nor hides it', () => {
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });

  // SD corruption, or the app user replacing a file in a directory it owns.
  fs.writeFileSync(pi.statusFile, '');
  pi.at('2026-11-04T15:00:00Z');
  let s = helper.main('support-expire', pi.o);
  assert.equal(s.support.enabled, true, 'the session is still on, and says so');
  assert.equal(s.support.expiresAt, '2026-11-04T20:00:00.000Z', 'rebuilt from the record root owns');
  assert.equal(s.support.signedIn, true, 'and from what the device says');

  // And it still ends by itself, which the lost mirror could not have told us.
  pi.at('2026-11-04T20:00:01Z');
  s = helper.main('support-expire', pi.o);
  assert.equal(s.support.enabled, false);
  assert.equal(pi.pi.signedIn, false);
  assert.equal(pi.pi.connectOn, false);
});

test('support access: a device signed in with nothing to account for it is signed out on the spot', () => {
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  // The session record is gone but the Pi is still signed in and reachable.
  // Nothing may read "off" off the mirror and leave it that way.
  fs.rmSync(pi.sessionFile);
  const n = pi.calls.length;
  const s = helper.main('status', pi.o);
  assert.equal(s.support.enabled, false);
  assert.equal(s.support.signedIn, false);
  assert.equal(s.last.action, 'support-reconcile');
  assert.match(s.last.message, /no support session is recorded/);
  assert.ok(pi.calls.slice(n).some((c) => /rpi-connect signout/.test(c.cmd)), 'the device was signed out, not just reported');
  assert.equal(pi.pi.connectOn, false);
});

test('support access: ending it with the record gone still switches the device off', () => {
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  fs.rmSync(pi.sessionFile);
  const n = pi.calls.length;
  // The club presses "End support access". A green tick with the Pi still
  // signed in is the worst outcome this feature has, so the button asks the
  // device who is signed in rather than reading the state off a file.
  const s = pi.ask({ id: 's2', action: 'support-disable' });
  assert.equal(s.last.ok, true);
  assert.equal(s.support.enabled, false);
  assert.ok(pi.calls.slice(n).some((c) => /rpi-connect signout/.test(c.cmd)));
  assert.equal(pi.pi.signedIn, false);
  assert.equal(pi.pi.connectOn, false);
});

test('support access: a hand-edited expiry cannot buy an unbounded session', () => {
  for (const [expiresAt, why] of [
    ['2099-01-01T00:00:00.000Z', /longer than the 24 hours allowed/],
    ['not a date', /no usable expiry/],
    [undefined, /no usable expiry/],
    ['2026-11-04T13:00:00.000Z', /expires before it started/],
  ]) {
    const pi = fakePi({ users: ['dan'] });
    pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
    pi.setSession({ ...pi.session(), expiresAt });
    // Well inside the six hours that were actually asked for.
    pi.at('2026-11-04T15:00:00Z');
    const s = helper.main('support-expire', pi.o);
    assert.equal(s.support.enabled, false, `expiresAt=${expiresAt}`);
    assert.match(s.last.message, why);
    assert.equal(pi.pi.signedIn, false, `expiresAt=${expiresAt}: the device is signed out`);
    assert.equal(pi.pi.connectOn, false);
    assert.equal(pi.session(), null, 'and the record goes with it');
  }
});

test('support access: a Pi that will not sign out is reported, not called off', () => {
  const pi = fakePi({ users: ['dan'], stubborn: true });
  pi.ask({ id: 's1', action: 'support-enable', hours: 1 });
  const s = pi.ask({ id: 's2', action: 'support-disable' });
  assert.equal(s.last.ok, false, 'two commands having been run is not the same as it being off');
  assert.match(s.last.message, /still reports this Pi as signed in/);
  assert.match(s.last.message, /connect\.raspberrypi\.com/, 'and says what the club can do about it');
  assert.equal(s.support.signedIn, true);
  assert.ok(pi.ran(/rpi-connect signout/).length >= 2, 'tried again before giving up');
  // The record still goes: nothing may keep treating this as a live session.
  assert.equal(pi.session(), null);
});

test('support access: taking linger back does not get to decide whether the sign-out worked', () => {
  /* disable-linger stops user@<uid>.service, and /run/user/<uid> goes with it —
     and with it the bus the check talks over. Done before the check, the check
     threw, the catch left signedIn false, and a Pi that had refused to sign out
     was reported as cleanly off: a guess, in the one function whose whole
     purpose is not guessing. So the device is asked first and linger goes last. */
  const pi = fakePi({ users: ['dan'], stubborn: true, busNeedsLinger: true });
  pi.ask({ id: 's1', action: 'support-enable', hours: 1 });
  const s = pi.ask({ id: 's2', action: 'support-disable' });
  assert.equal(s.last.ok, false, 'a stubborn Pi cannot be turned into a clean “off” by losing the bus');
  assert.match(s.last.message, /still reports this Pi as signed in/);
  assert.equal(s.support.signedIn, true);
  // And the order is the point: asked while there was still a bus to ask over.
  const order = pi.calls.map((c) => c.cmd);
  const asked = order.findIndex((c) => /disable-linger/.test(c));
  assert.ok(order.slice(0, asked).some((c) => /rpi-connect status/.test(c)), 'checked before linger was taken away');
});

test('support access: a clock that falls behind the session does not extend it', () => {
  /* The bound was `now >= expiresAt` and nothing else, so a well-formed
     one-hour session stayed valid for as long as the clock sat before its end,
     however the clock got there. The realistic route is the first run of all: a
     Pi has no RTC, boots with fake-hwclock's last-shutdown time, and the
     OnBootSec run can happen before timesyncd has stepped it — so the one run
     the timer's guarantee rests on is the one most likely to see a stale clock. */
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 1 });

  pi.at('2026-11-04T14:30:00Z');
  assert.equal(helper.main('support-expire', pi.o).support.enabled, true, 'half an hour in, still on');

  // A week before the session started, which is a week of real time it never had.
  pi.at('2026-10-28T12:00:00Z');
  const s = helper.main('support-expire', pi.o);
  assert.equal(s.support.enabled, false);
  assert.match(s.last.message, /clock has moved behind/);
  assert.equal(pi.pi.signedIn, false);
  assert.equal(pi.session(), null);
});

test('support access: a minute of clock correction is not treated as a lie', () => {
  // timesyncd stepping the clock a few seconds on a card that has just booted
  // is ordinary, and must not end a session that has hours left.
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  pi.at('2026-11-04T13:59:30Z');
  assert.equal(helper.main('support-expire', pi.o).support.enabled, true);
  assert.equal(pi.pi.signedIn, true);
});

test('support access: when the record was written is a second witness to when it started', () => {
  // The timestamps inside the record say one thing; the mtime root gave it in
  // a 0700 root directory says another, and the shorter of the two wins.
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  const twoDaysBefore = new Date('2026-11-02T14:00:00Z');
  fs.utimesSync(pi.sessionFile, twoDaysBefore, twoDaysBefore);
  pi.at('2026-11-04T15:00:00Z');
  const s = helper.main('support-expire', pi.o);
  assert.equal(s.support.enabled, false, 'an hour into a six-hour session, but recorded two days ago');
  assert.match(s.last.message, /recorded longer than the 24 hours allowed ago/);
  assert.equal(pi.pi.signedIn, false);
});

test('support access: a second Connect client under another login is not hidden by a valid session', () => {
  /* The device check stopped at the first login that reported itself signed
     in, so with login A holding a valid session, a sign-in under login B was
     never looked at — masked for as long as A's session stayed valid, which is
     up to a day. Every login is asked now, and everything a bounded session
     does not account for is signed out. */
  const pi = fakePi({ users: ['dan', 'other'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  assert.equal(pi.session().user, 'dan');
  pi.pi.signedInAs.add('other');

  const s = helper.main('status', pi.o);
  assert.equal(s.support.enabled, true, 'the club’s own session carries on');
  assert.equal(s.support.user, 'dan');
  assert.equal(s.support.expiresAt, '2026-11-04T20:00:00.000Z');
  assert.ok(pi.ran(/runuser -u other .* rpi-connect status/).length >= 1, 'the other login was asked');
  assert.ok(pi.ran(/runuser -u other .* rpi-connect signout/).length >= 1, 'and signed out');
  assert.deepEqual([...pi.pi.signedInAs], ['dan']);
  assert.equal(s.last.action, 'support-reconcile');
  assert.ok(pi.session(), 'and the record that bounds the real session is left alone');
});

test('support access: a client under a login that is no longer a login is still found', () => {
  // people() is the list support access may *start* as. A client already signed
  // in under an account whose shell has since been set to nologin dropped out
  // of that list and became invisible.
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  fs.writeFileSync(pi.o.passwdFile, fs.readFileSync(pi.o.passwdFile, 'utf8').replace('/home/dan:/bin/bash', '/home/dan:/usr/sbin/nologin'));
  fs.rmSync(pi.sessionFile);

  const s = helper.main('status', pi.o);
  assert.equal(s.support.enabled, false);
  assert.equal(s.support.signedIn, false);
  assert.equal(pi.pi.signedIn, false, 'signed out even though it is not a login any more');
  assert.match(s.last.message, /no support session is recorded/);
});

/* ---------------------------------------------------------------- the lock */

test('remote access: a lock a live helper is holding is waited for, not taken away', () => {
  /* Stealing on the wait deadline as well as on staleness meant a holder that
     was merely slow — a wedged rpi-connectd makes one call per login on the
     card — had its lock removed and two helpers ran over the same files, which
     is the one thing the lock exists to prevent. Then the original holder's
     release unlinked the thief's lock and a third could walk in. Waiting a
     long time is evidence of a slow holder, not a dead one. */
  const pi = fakePi({ users: ['dan'] });
  const lock = path.join(pi.stateDir, 'support.lock');
  fs.writeFileSync(lock, '424242\n');
  assert.throws(() => helper.main('status', pi.o), /still running/);
  assert.equal(fs.readFileSync(lock, 'utf8'), '424242\n', 'somebody else’s lock is left exactly as it was');
  assert.deepEqual(pi.ran(/rpi-connect/), [], 'and nothing was done alongside them');
});

test('remote access: a lock left behind by a killed helper is stolen, once it is old enough', () => {
  const pi = fakePi({ users: ['dan'] });
  const lock = path.join(pi.stateDir, 'support.lock');
  fs.writeFileSync(lock, '424242\n');
  const longAgo = new Date(Date.now() - 600_000);
  fs.utimesSync(lock, longAgo, longAgo);
  const s = helper.main('status', pi.o);
  assert.equal(s.support.enabled, false);
  assert.ok(!fs.existsSync(lock), 'and released again on the way out');
});

test('support access: the expiry happens whether or not the lock can be taken', () => {
  /* The lock is a convenience; the expiry is the promise. A card that has
     filled up or remounted read-only cannot create a lock file at all — and a
     signage Pi that is unplugged rather than shut down is exactly the thing
     that remounts read-only, while the dashboard's own user can fill DATA_DIR
     on the same filesystem. "Support access stopped expiring because of
     ENOSPC" is not a failure this feature may have. */
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 1 });
  // Something at the lock's name that is not a lock and cannot become one.
  fs.mkdirSync(path.join(pi.stateDir, 'support.lock'));
  pi.at('2026-11-04T15:00:01Z');

  const s = helper.main('support-expire', pi.o);
  assert.equal(s.support.enabled, false);
  assert.equal(pi.pi.signedIn, false, 'the device was signed out anyway');
  assert.equal(pi.pi.connectOn, false);
  assert.equal(pi.session(), null);
  // A status or request run gives up instead: both of those are retried.
  assert.throws(() => helper.main('status', pi.o), /still running/);
});

test('remote access: a request the path unit could not pick up is not stranded', () => {
  // PathChanged= fires on the write, so if a helper was already running when it
  // fired, nothing would look at that request again until somebody pressed the
  // button a second time. The timer picks it up within five minutes instead,
  // and the id check makes a second look at it harmless.
  const pi = fakePi({ users: ['dan'] });
  fs.writeFileSync(pi.requestFile, JSON.stringify({ id: 's1', action: 'support-enable', hours: 6 }));
  const s = helper.main('support-expire', pi.o);
  assert.equal(s.support.enabled, true, s.last && s.last.message);
  assert.equal(s.lastRequestId, 's1');
  assert.ok(!fs.existsSync(pi.requestFile));
});

/* ------------------------------------------------- the sign-in's lifetime */

test('support access: the sign-in is a named unit, and ending access stops it', () => {
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  // Not a loose background process: loose, it is in this one-shot service's
  // cgroup and systemd reaps it the moment the helper returns, so the pairing
  // could never be finished — and if it did survive, a browser visit after the
  // session ended could sign the card back in with nobody watching.
  const signin = pi.ran(/rpi-connect signin/);
  assert.equal(signin.length, 1);
  assert.match(signin[0], /systemd-run --user --quiet --unit=pitchtribe-support-signin --collect/);
  assert.ok(signin[0].startsWith('runuser -u dan -- env XDG_RUNTIME_DIR='), signin[0]);
  assert.equal(pi.pi.signinUnit, true);

  pi.ask({ id: 's2', action: 'support-disable' });
  assert.ok(pi.ran(/systemctl --user stop pitchtribe-support-signin\.service/).length >= 1);
  assert.equal(pi.pi.signinUnit, false, 'nothing is left waiting at the verification URL');
  assert.ok(!fs.existsSync(pi.signinLog()));
});

test('support access: the verification URL is not left in a second file', () => {
  const pi = fakePi({ users: ['dan'], completeSignin: false });
  const s = pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  assert.equal(s.support.signin.code, 'ABCD-1234');
  assert.ok(!fs.existsSync(pi.signinLog()), 'the sign-in output goes once it has been read');
});

test('support access: the sign-in log is root’s file to name, not the club user’s', () => {
  /* It has to be writable by the account the sign-in unit runs as, and that
     account owns its own /run/user/<uid> — so a log kept there could be
     replaced with a symlink between root creating it and root reading it, and
     root would read whatever it pointed at. Worse, a failure put the last line
     of it into the status mirror, which the dashboard renders: a last-line-of-
     any-file oracle. So the name belongs to root, in root's own directory. */
  const pi = fakePi({ users: ['dan'], completeSignin: false });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  const log = pi.signinLog();
  assert.equal(path.dirname(log), pi.signinDir, 'in the root-owned directory, not /run/user/<uid>');
  assert.equal(fs.statSync(pi.signinDir).mode & 0o777, 0o755, 'the club user cannot create names in it');
  assert.match(pi.ran(/rpi-connect signin/)[0], new RegExp(`StandardOutput=append:${log.replace(/[/\\]/g, '\\$&')}`));

  // A symlink left at that name is not read, whatever it points at.
  const secret = path.join(pi.dir, 'secret');
  fs.writeFileSync(secret, `nothing to see\n${SIGNIN_URL}\n`);
  const sneaky = fakePi({ users: ['dan'], signin: '' });
  fs.mkdirSync(sneaky.signinDir, { recursive: true });
  fs.symlinkSync(secret, sneaky.signinLog());
  const s = sneaky.ask({ id: 's1', action: 'support-enable', hours: 6 });
  assert.equal(s.last.ok, false, 'a link at the log’s name is not followed');
  assert.equal(s.support.enabled, false);
  assert.ok(!String(s.last.message).includes('/verify/'));
});

test('support access: what the sign-in printed does not end up in the dashboard', () => {
  // The club user can write what they like into their own log. The last line
  // of it must not become the message the dashboard shows, nor reach the
  // mirror; the detail goes to the journal instead.
  const pi = fakePi({ users: ['dan'], signin: 'error: /etc/shadow:root:$6$secrethash\n' });
  const s = pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  assert.equal(s.last.ok, false);
  assert.ok(!s.last.message.includes('secrethash'), s.last.message);
  assert.match(s.last.message, /Check the Pi has internet access/);
  assert.ok(!fs.readFileSync(pi.statusFile, 'utf8').includes('secrethash'));
  assert.ok(pi.warnings.some((w) => w.includes('secrethash')), 'and it is in the journal, where it belongs');
});

test('support access: waits for the session enable-linger asks for, and tidies up if it never comes', () => {
  const pi = fakePi({ users: ['dan'], runtimeDir: false });
  const s = pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  assert.equal(s.last.ok, false);
  assert.match(s.last.message, /did not open a background session/);
  // Nothing was asked of Connect, because there was no bus to ask over — and
  // the linger we set on the way in is given back.
  assert.deepEqual(pi.ran(/rpi-connect (on|signin)/), []);
  assert.deepEqual(pi.ran(/disable-linger/), ['loginctl disable-linger dan']);
  assert.equal(pi.session(), null);
});

/* ------------------------------------------------------- file hygiene */

test('remote access: the status mirror is readable by the dashboard and nothing else', () => {
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  /* During the sign-in window this file holds the verification code, and
     whoever reads it can pair the Pi to their own Raspberry Pi ID instead of
     the club's. 0644 was world-readable; 0640 root:pitchtribe was not narrow
     enough either, because group `pitchtribe` is wider than the dashboard —
     the captive portal's user joins it to reach DATA_DIR/portal, and that is
     the one process guests on an untrusted network can reach. So the mirror
     has a group of its own, whose only member is the dashboard's user. */
  assert.equal(fs.statSync(pi.statusFile).mode & 0o777, 0o640);
  assert.deepEqual(pi.ran(/^chgrp/), [], 'the group is set on the descriptor, not by re-resolving the path');
  /* Which group is the next test: only root can chown, so off a Pi the file
     keeps this process's own group and the gid cannot be asserted here. What
     can be asserted is that the group is looked up at all, and what happens
     when the answer is no. */
  // The record that bounds the session is root's alone.
  assert.equal(fs.statSync(pi.sessionFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(pi.stateDir).mode & 0o777, 0o700);
});

test('remote access: with no dashboard group to narrow to, the mirror stays root’s', () => {
  // Rather than widen it to something the portal can read. The dashboard then
  // reports remote access as unavailable until the installer is re-run, which
  // is visible and recoverable; a readable verification code is not.
  const pi = fakePi({ users: ['dan'], mirrorGroup: 'no-such-group' });
  helper.main('status', pi.o);
  assert.equal(fs.statSync(pi.statusFile).mode & 0o777, 0o600);
  assert.ok(pi.warnings.some((w) => /no-such-group/.test(w)), 'and it says so in the journal');
});

test('remote access: a symlink in DATA_DIR cannot steer what root writes', () => {
  /* The attack this closes, and the reason the mirror can never be the
     authority *or* steer a write: DATA_DIR belongs to the dashboard's own user,
     so that user can create names in it — including the temporary file every
     status write passes through. With that name pointed at the session record
     in STATE_DIR, root wrote a forged session there on the next run, and the
     content came from the mirror's own keys being spread back out again. The
     session then renewed itself for ever and the bound was back in the hands of
     the one account the whole arrangement exists to distrust. Point it anywhere
     and it was an arbitrary root write besides. */
  const pi = fakePi({ users: ['dan'] });
  const victim = path.join(pi.dir, 'victim');
  fs.writeFileSync(victim, 'do not touch\n');

  // The forged record the mirror's keys used to carry through.
  fs.writeFileSync(pi.statusFile, JSON.stringify({
    user: 'dan',
    hours: 24,
    startedAt: '2026-11-04T13:00:00.000Z',
    expiresAt: '2026-11-05T13:00:00.000Z',
    lingeredByUs: false,
    evil: true,
  }));
  fs.symlinkSync(victim, `${pi.statusFile}.tmp`);
  pi.pi.signedInAs.add('dan');

  const s = helper.main('status', pi.o);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'do not touch\n', 'root did not follow the link');
  assert.ok(!fs.lstatSync(pi.statusFile).isSymbolicLink());
  assert.equal(fs.statSync(pi.statusFile).mode & 0o777, 0o640);

  // The forged keys are not copied back out, so there is nothing to steer a
  // write with even if a link did survive somewhere.
  const mirrored = JSON.parse(fs.readFileSync(pi.statusFile, 'utf8'));
  assert.equal(mirrored.evil, undefined);
  assert.equal(mirrored.expiresAt, undefined, 'the mirror’s own keys are the only ones carried forward');
  assert.equal(mirrored.startedAt, undefined);
  assert.deepEqual(Object.keys(mirrored).sort(), ['last', 'sshActive', 'sshEnabled', 'support', 'updatedAt', 'users']);

  // And the device, which was signed in with no record behind it, was signed out.
  assert.equal(s.support.enabled, false);
  assert.equal(pi.pi.signedIn, false);
  assert.equal(pi.session(), null, 'no session was forged into root’s own directory');

  // The same thing aimed at a live session's record, which is where it was
  // worth the most: rolling startedAt/expiresAt forward on every cycle meant
  // the bound never saw a window longer than a day and the session never ended.
  const live = fakePi({ users: ['dan'] });
  live.ask({ id: 's1', action: 'support-enable', hours: 1 });
  const before = live.session();
  fs.writeFileSync(live.statusFile, JSON.stringify({ ...before, expiresAt: '2026-11-05T13:00:00.000Z' }));
  fs.symlinkSync(live.sessionFile, `${live.statusFile}.tmp`);
  live.at('2026-11-04T14:30:00Z');
  helper.main('support-expire', live.o);
  assert.deepEqual(live.session(), before, 'the record root owns is exactly as root left it');
  live.at('2026-11-04T15:00:01Z');
  assert.equal(helper.main('support-expire', live.o).support.enabled, false, 'and the hour still runs out');
  assert.equal(live.pi.signedIn, false);
});

test('remote access: a file pre-made at the mirror’s temporary name is not written into', () => {
  // 'w' keeps the inode and a mode argument it ignores, so a 0666 file left at
  // that name by the dashboard's user had root write into it world-writably,
  // and the rename then handed them the mirror itself.
  const pi = fakePi({ users: ['dan'] });
  const tmp = `${pi.statusFile}.tmp`;
  fs.writeFileSync(tmp, 'mine\n', { mode: 0o666 });
  fs.chmodSync(tmp, 0o666);
  // A handle on *their* inode, so we can see whether root wrote into it. The
  // mode argument is ignored for an existing file, so root wrote into a 0666
  // file until the chmod afterwards closed it — and rename() keeps the inode,
  // so the mirror then belonged to whoever left that file there, while the code
  // believed it had just written 0640 root:… itself.
  const theirs = fs.openSync(tmp, 'r');
  helper.main('status', pi.o);
  assert.equal(fs.readFileSync(theirs, 'utf8'), 'mine\n', 'root wrote nothing into the file they made');
  fs.closeSync(theirs);
  assert.equal(fs.statSync(pi.statusFile).mode & 0o777, 0o640);
  assert.ok(JSON.parse(fs.readFileSync(pi.statusFile, 'utf8')).updatedAt);
});

test('remote access: keys the mirror cannot be trusted with do not survive a run', () => {
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 'r1', action: 'enable', username: 'clubadmin', passwordHash: HASH });
  const before = JSON.parse(fs.readFileSync(pi.statusFile, 'utf8'));
  assert.equal(before.username, 'clubadmin');
  // The three things that have to live in the mirror between runs, and nothing
  // else: the SSH login's name, what happened last, and the id it happened for.
  fs.writeFileSync(pi.statusFile, JSON.stringify({
    ...before, username: 'clubadmin', smuggled: { anything: 'at all' }, users: ['root'], support: { enabled: true, expiresAt: '2099-01-01T00:00:00Z' },
  }));
  const s = helper.main('status', pi.o);
  assert.equal(s.username, 'clubadmin');
  assert.equal(s.lastRequestId, 'r1');
  assert.equal(s.smuggled, undefined);
  assert.deepEqual(s.users, ['dan', 'clubadmin'], 'rebuilt from the card, not read back');
  assert.equal(s.support.enabled, false, 'and support access is what the record says, not the mirror');
});

test('remote access: a request is off the disk as soon as it is read, whatever it says', () => {
  const requestFile = (pi) => path.join(pi.dir, 'remote-access-request.json');

  // No id, so nothing is done with it — but it carries a password hash, and
  // "the helper deletes that file as it reads it" has to be true of this one too.
  const noId = fakePi({ users: ['dan'] });
  fs.writeFileSync(requestFile(noId), JSON.stringify({ action: 'enable', username: 'clubadmin', passwordHash: HASH }));
  helper.main('request', noId.o);
  assert.ok(!fs.existsSync(requestFile(noId)), 'a request with no id does not stay on disk');
  assert.ok(!noId.calls.some((c) => c.cmd.startsWith('chpasswd')), 'and nothing was done with it');

  // Nor does something that is not JSON at all.
  const junk = fakePi({ users: ['dan'] });
  fs.writeFileSync(requestFile(junk), 'not json {');
  helper.main('request', junk.o);
  assert.ok(!fs.existsSync(requestFile(junk)));

  // Nor a replay of one already done.
  const replay = fakePi({ users: ['dan'] });
  replay.ask({ id: 'r1', action: 'enable', username: 'clubadmin', passwordHash: HASH });
  fs.writeFileSync(requestFile(replay), JSON.stringify({ id: 'r1', action: 'disable' }));
  const s = helper.main('request', replay.o);
  assert.ok(!fs.existsSync(requestFile(replay)), 'a replayed request does not stay on disk either');
  assert.equal(s.sshActive, true, 'and it is still ignored');
});

/* ---------------------------------------------------------------------------
   What the owner of DATA_DIR chooses about a name there is not only whether it
   is a symlink. It is what *kind of object* it is — and readFileSync, existsSync
   and rmSync all used to take that on trust.
   --------------------------------------------------------------------------- */

const mkfifo = (p) => execFileSync('mkfifo', [p]);

test('support access: a FIFO where the request file goes cannot stop the expiry', () => {
  /* The one that mattered. `open(O_RDONLY)` on a FIFO with no writer blocks,
     `readFileSync` has no timeout, and Type=oneshot has no TimeoutStartSec= by
     default — so the expiry unit stayed `activating` for ever, OnUnitActiveSec=
     never started the next run because the unit it triggers was already active,
     and a bounded support session carried on until somebody rebooted the card.
     Which a signage Pi in a clubhouse does not do for months.

     `mkfifo` was the whole exploit, available to the account the design assumes
     may be hostile. This test hangs for ever against a readFileSync. */
  // While the session is still valid, which is the run that reaches the
  // request file at all — and so the run the proof of concept wedged.
  const live = fakePi({ users: ['dan'] });
  live.ask({ id: 's1', action: 'support-enable', hours: 1 });
  mkfifo(live.requestFile);
  live.at('2026-11-04T14:05:00Z');

  const still = helper.main('support-expire', live.o);
  assert.equal(still.support.enabled, true, 'the run returned, and the session has time left');
  assert.ok(!fs.existsSync(live.requestFile), 'and the thing that is not a request is gone');
  assert.ok(live.warnings.some((w) => /not a regular file \(a FIFO\)/.test(w)), 'with a line in the journal saying so');

  // And the run that has a session to end gets to the end of it.
  live.at('2026-11-04T15:00:01Z');
  mkfifo(live.requestFile);
  const s = helper.main('support-expire', live.o);
  assert.equal(s.support.enabled, false, 'the session ended on time regardless');
  assert.equal(live.pi.signedIn, false, 'and the device was signed out');
  assert.equal(live.session(), null);
});

test('support access: a FIFO where the mirror goes does not wedge a status run either', () => {
  // Same primitive at the other name. `status` and `request` both read the
  // mirror to carry three keys forward, so the same mkfifo wedged those too —
  // and then every expiry run after it, inside mirror().
  const pi = fakePi({ users: ['dan'] });
  mkfifo(pi.statusFile);
  const s = helper.main('status', pi.o);
  assert.deepEqual(s.users, ['dan']);
  assert.equal(fs.statSync(pi.statusFile).isFile(), true, 'and the mirror is a file again');
});

test('support access: a directory in the way is cleared rather than breaking every run', () => {
  /* `rmSync(path, { force: true })` throws ERR_FS_EISDIR on a directory, and
     O_EXCL then gets EEXIST, so a single `mkdir` at the mirror's temporary name
     made every status and request run throw — persistently, with no race to
     win. It failed closed, but the club lost all feedback: a support-enable
     through it wrote a real session with the verification URL in it and then
     died before the mirror carried it, so the session was on and the link was
     unreachable. */
  // completeSignin: false is the real state of a Pi in the moments after
  // switching support access on — the link is up, nobody has been to it yet,
  // which is exactly when losing the mirror costs the club the link.
  const pi = fakePi({ users: ['dan'], completeSignin: false });
  fs.mkdirSync(`${pi.statusFile}.tmp`);

  const s = pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  assert.equal(s.last.ok, true, s.last.message);
  assert.ok(s.support.signin.url, 'and the club can see the link it has to open');
  assert.equal(JSON.parse(fs.readFileSync(pi.statusFile, 'utf8')).support.signin.url, s.support.signin.url,
    'in the mirror, which is the only place the dashboard reads it from');

  // And a directory where the mirror itself goes: rename(2) will not replace
  // one, so this broke the write at the other end of the same function.
  const other = fakePi({ users: ['dan'] });
  fs.mkdirSync(other.statusFile);
  assert.deepEqual(helper.main('status', other.o).users, ['dan']);
  assert.equal(fs.statSync(other.statusFile).isFile(), true);

  // And at the request file's name, where it stopped the helper rather than a
  // write: rmSync threw before anything was read.
  const asked = fakePi({ users: ['dan'] });
  fs.mkdirSync(asked.requestFile);
  assert.deepEqual(helper.main('request', asked.o).users, ['dan']);
  assert.ok(!fs.existsSync(asked.requestFile), 'and it is cleared out of the way');
});

test('support access: a symlink at the mirror is not a way of reading root’s own files', () => {
  /* The read half of the same class. Point the mirror at a file in STATE_DIR
     (0700 root) and root reads it on the club user's behalf, with
     keepFromMirror() copying `username` and `last.message` straight out into
     the 0640 group-readable mirror it writes next. Nothing root-only on the
     card is JSON with those keys today — but that is a property of today's key
     names, not of the mechanism. */
  const pi = fakePi({ users: ['dan'] });
  const secret = path.join(pi.stateDir, 'secret.json');
  fs.writeFileSync(secret, JSON.stringify({ username: 'leaked', last: { message: 'root-only' } }), { mode: 0o600 });
  fs.symlinkSync(secret, pi.statusFile);

  helper.main('status', pi.o);
  const mirror = JSON.parse(fs.readFileSync(pi.statusFile, 'utf8'));
  assert.equal(mirror.username, undefined, 'nothing was read through the link');
  assert.equal(mirror.last, undefined);
  assert.equal(JSON.parse(fs.readFileSync(secret, 'utf8')).username, 'leaked', 'and the file it pointed at is untouched');
  assert.equal(fs.lstatSync(pi.statusFile).isSymbolicLink(), false, 'the link was replaced by a real file');
});

/* ------------------------------------------- the clock, and what it is for */

test('support access: a power cut does not end a session the club is in the middle of', () => {
  /* The lower bound on the clock was right in intent and wrong in scale. A Pi
     has no RTC: fake-hwclock saves hourly and on clean shutdown, and a signage
     card is unplugged rather than shut down, so it comes back up to an hour
     behind — and OnBootSec=15s aims the first run at exactly that moment.
     Ten minutes into a twelve-hour session, a power cut would have signed the
     Pi out in the middle of the support call it was switched on for. */
  const pi = fakePi({ users: ['dan'], clockSynced: false });
  pi.ask({ id: 's1', action: 'support-enable', hours: 12 });

  // Ten real minutes later the power goes; the clock comes back half an hour
  // behind the session start, before timesyncd has stepped it.
  pi.at('2026-11-04T13:30:00Z');
  const s = helper.main('support-expire', pi.o);
  assert.equal(s.support.enabled, true, s.last && s.last.message);
  assert.equal(pi.pi.signedIn, true, 'the support call carries on');
  assert.ok(pi.session(), 'and the record it is bounded by is still there');
});

test('support access: once the clock is known good, a clock behind the session still ends it', () => {
  // Which is the case the bound was written for, and it is unchanged: the
  // difference is "no reliable clock yet" versus "the clock really has moved".
  const pi = fakePi({ users: ['dan'], clockSynced: true });
  pi.ask({ id: 's1', action: 'support-enable', hours: 12 });
  pi.at('2026-11-04T13:30:00Z');
  const s = helper.main('support-expire', pi.o);
  assert.equal(s.support.enabled, false);
  assert.match(s.last.message, /clock has moved behind/);
  assert.equal(pi.pi.signedIn, false);
});

test('support access: an untrusted clock does not postpone the expiry itself', () => {
  // Only the *ordering* judgement waits for the clock. A session that has run
  // out by the clock in front of us ends, synchronised or not — a clock that is
  // behind can only make a session look younger, never older.
  const pi = fakePi({ users: ['dan'], clockSynced: false });
  pi.ask({ id: 's1', action: 'support-enable', hours: 1 });
  pi.at('2026-11-04T15:00:01Z');
  const s = helper.main('support-expire', pi.o);
  assert.equal(s.support.enabled, false);
  assert.match(s.last.message, /ran out/);
  assert.equal(pi.pi.signedIn, false);
});

/* ------------------------------------------------- how old a request may be */

test('remote access: a request stranded for a season is not carried out in February', () => {
  /* `id`/`lastRequestId` cannot help here: a request that was never picked up
     never had its id recorded. Before the stray pickup the window was "until
     the next write to that file"; the pickup turned it into "until the next
     boot", because PathChanged= does not fire for a file that was already there
     when the path unit started. So a request written in November switched SSH
     on — with a sudo account, from a password hash the club typed before the
     close season — when the card came back in February. The timestamp to check
     was already in the file and nothing read it. */
  const pi = fakePi({ users: ['dan'] });
  pi.strand({ id: 'r1', action: 'enable', username: 'clubadmin', passwordHash: HASH }, '2026-08-14T10:00:00Z');

  const s = helper.main('support-expire', pi.o);
  assert.equal(s.sshActive, false, 'SSH was not switched on three months later');
  assert.equal(s.last.ok, false);
  assert.match(s.last.message, /sat unread for too long/);
  assert.deepEqual(s.users, ['dan'], 'and no login was created');
  assert.ok(!fs.existsSync(pi.requestFile), 'the hash does not stay on disk either');
});

test('support access: and a stranded support-enable does not start a fresh session', () => {
  const pi = fakePi({ users: ['dan'] });
  pi.strand({ id: 's1', action: 'support-enable', hours: 24 }, '2026-08-14T10:00:00Z');
  const s = helper.main('support-expire', pi.o);
  assert.equal(s.support.enabled, false);
  assert.equal(pi.pi.signedIn, false, 'nothing was signed in');
  assert.equal(pi.session(), null);
});

test('remote access: a request that really is fresh is still picked up', () => {
  // The bound is on the timing, not on the authority: a second look at a
  // recent request is exactly what the stray pickup is for.
  const pi = fakePi({ users: ['dan'] });
  pi.strand({ id: 's1', action: 'support-enable', hours: 6 }, '2026-11-04T13:58:00Z');
  const s = helper.main('support-expire', pi.o);
  assert.equal(s.support.enabled, true, s.last && s.last.message);
  assert.equal(s.lastRequestId, 's1');
});

test('remote access: a request cannot be made to look fresh by dating it in the future', () => {
  /* `at` is chosen by the account that writes the file; the mtime is set by the
     kernel as a side effect of writing it. So the older of the two is used, and
     a forged `at` can only ever make a request look staler than it is. */
  const pi = fakePi({ users: ['dan'] });
  const f = pi.strand({ id: 'r1', action: 'enable', username: 'clubadmin', passwordHash: HASH }, '2027-01-01T00:00:00Z');
  const old = new Date('2026-08-14T10:00:00Z');
  fs.utimesSync(f, old, old);

  const s = helper.main('request', pi.o);
  assert.equal(s.sshActive, false);
  assert.match(s.last.message, /sat unread for too long/);
});

/* ------------------------------------------------------------- the lock */

test('remote access: a slow holder keeps its lock, however long it has held it', () => {
  /* The rule was age alone, at 150s. But a helper makes one rpi-connect call
     per login on the card and each can sit on EXEC_TIMEOUT_MS (30s) — the very
     case that timeout exists for — so a support-enable against a wedged
     rpi-connectd legitimately holds the lock for minutes. Age said that was a
     dead holder, two helpers then ran over the session record at once, and
     preventing exactly that is what the lock is for. Liveness is a question for
     the kernel, not for the clock. */
  const pi = fakePi({ users: ['dan'], pidAlive: () => true });
  pi.o.lockStaleMs = 15 * 60_000;
  const lock = path.join(pi.stateDir, 'support.lock');
  fs.writeFileSync(lock, '424242\n');
  // Ten minutes of holding it — four times what used to count as dead.
  const longAgo = new Date(Date.now() - 600_000);
  fs.utimesSync(lock, longAgo, longAgo);

  assert.throws(() => helper.main('status', pi.o), /still running/, 'we waited and gave up, rather than stealing');
  assert.equal(fs.readFileSync(lock, 'utf8'), '424242\n', 'the live holder’s lock is exactly as it was');
});

test('remote access: a lock whose holder is gone is stolen at once', () => {
  const pi = fakePi({ users: ['dan'], pidAlive: () => false });
  pi.o.lockStaleMs = 15 * 60_000;
  const lock = path.join(pi.stateDir, 'support.lock');
  fs.writeFileSync(lock, '424242\n');
  const longAgo = new Date(Date.now() - 600_000);
  fs.utimesSync(lock, longAgo, longAgo);

  const s = helper.main('status', pi.o);
  assert.deepEqual(s.users, ['dan'], 'no waiting for a process that is not there');
  assert.ok(!fs.existsSync(lock), 'and released again on the way out');
});

test('remote access: a lock with no readable pid falls back to its age', () => {
  // A holder killed between creating the file and writing its pid into it. The
  // grace covers the moment legitimately, and the mtime backstop covers the
  // rest — which is now above the longest legitimate hold rather than below it.
  const fresh = fakePi({ users: ['dan'], pidAlive: () => true });
  fs.writeFileSync(path.join(fresh.stateDir, 'support.lock'), '');
  assert.throws(() => helper.main('status', fresh.o), /still running/, 'within the grace, it is somebody’s');

  const stale = fakePi({ users: ['dan'], pidAlive: () => true });
  const lock = path.join(stale.stateDir, 'support.lock');
  fs.writeFileSync(lock, '');
  const longAgo = new Date(Date.now() - 600_000);
  fs.utimesSync(lock, longAgo, longAgo);
  assert.deepEqual(helper.main('status', stale.o).users, ['dan'], 'past it, it is nobody’s');
});

/* ------------------------------------------- the sign-in link, and honesty */

test('support access: two different verification links means none is used', () => {
  /* The sign-in runs as the club's own login, so that account writes the log
     and can put anything in it — inherent in delegating the sign-in to them,
     and on a stock card they are in `sudo` and can already do more than lie.
     What is worth refusing is the ambiguous case: two URLs means somebody has
     written one alongside rpi-connect's, and "whichever matched first wins" is
     a silent choice between the club's pairing and somebody else's. */
  const theirs = 'https://connect.raspberrypi.com/verify/ZZZZ-9999';
  const pi = fakePi({ users: ['dan'], signin: `${SIGNIN_OK}Complete sign in by visiting ${theirs}\n` });
  const s = pi.ask({ id: 's1', action: 'support-enable', hours: 6 });

  assert.equal(s.last.ok, false);
  assert.match(s.last.message, /more than one sign-in link/);
  assert.equal(s.support.enabled, false, 'and nothing was left switched on');
  assert.equal(pi.pi.connectOn, false);
  assert.equal(pi.session(), null);
  assert.ok(!pi.warnings.join('\n').includes(theirs), 'nor did either link reach the dashboard');
});

test('support access: a half-written verification link is not handed to the club', () => {
  // We poll a file somebody else is appending to, and return on the first
  // match, so without requiring the end of the line the first few characters
  // of a code matched and were shown as the link to open.
  const pi = fakePi({ users: ['dan'], signin: 'Complete sign in by visiting https://connect.raspberrypi.com/verify/ABCD' });
  const s = pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  assert.equal(s.last.ok, false);
  assert.match(s.last.message, /did not offer a sign-in link/);
  assert.equal(s.support.enabled, false);
  assert.equal(pi.pi.connectOn, false);
});

test('support access: the mirror never says a switch-off worked next to a signed-in Pi', () => {
  /* "End support access" switches off the session it knows about, and that
     call reports honestly on what it did. But the status write that follows it
     rebuilds support.signedIn from the device, and a *second* Connect client
     signed in under another login on the card is not something that call
     touched — a switch-off never reconciles, because the session it just ended
     is the one it is reporting on. So the mirror ended up with last.ok true and
     "Support access is off" on one line and support.signedIn true on the next.
     The ⚠ banner reads the second, so the page was right and the sentence under
     it was wrong. The sentence is what a club reads. */
  const pi = fakePi({ users: ['dan', 'coach'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  // Somebody else's Connect session, under the other login on the card.
  pi.pi.signedInAs.add('coach');

  const s = pi.ask({ id: 's2', action: 'support-disable' });
  assert.equal(s.support.signedIn, true, 'the card is still signed in, under the other login');
  assert.equal(s.last.ok, false, 'so nothing may report having switched it off');
  assert.match(s.last.message, /still reports this Pi as signed in/);
  const mirror = JSON.parse(fs.readFileSync(pi.statusFile, 'utf8'));
  assert.equal(mirror.last.ok, false, 'and the mirror does not contradict itself');
  assert.equal(mirror.support.signedIn, true);

  // And the next run, which does reconcile, ends it for real.
  const next = helper.main('status', pi.o);
  assert.equal(next.support.signedIn, false);
  assert.equal(pi.pi.signedIn, false);
});

test('support access: a live session alongside a second client is not reported as a failure', () => {
  /* The other way for that sentence to be wrong, which the first version of
     the fix above introduced. A valid session *should* report signedIn: true,
     and when the reconcile signs a second client out alongside it the run
     succeeded — so "Support access could not be ended" would be a lie in the
     opposite direction, about a session the club is in the middle of using. */
  const pi = fakePi({ users: ['dan', 'coach'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  pi.pi.signedInAs.add('coach');

  const s = helper.main('status', pi.o);
  assert.equal(s.support.enabled, true, 'the club’s own session carries on');
  assert.equal(s.support.signedIn, true);
  assert.equal(s.last.ok, true, 'and signing the other one out worked');
  assert.match(s.last.message, /was signed out/);
  assert.deepEqual([...pi.pi.signedInAs], ['dan'], 'only the unaccounted-for client went');
});

test('support access: clearing something out of the way is not a way to delete somebody else’s files', () => {
  /* The new primitive that *removes* things as root, so it is the one worth
     being certain about. A symlink at either of root's names in DATA_DIR is
     unlinked, never followed — `rmSync` recursive lstats and unlinks a link
     rather than recursing into what it points at — so pointing it at the
     session record, or anywhere else on the card, deletes nothing but the link
     the dashboard's own user made. */
  const pi = fakePi({ users: ['dan'] });
  pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  const before = pi.session();
  assert.ok(before, 'there is a session record to try to destroy');

  // A link at the mirror's name, and one at its temporary name, both aimed at
  // root's own directory.
  fs.rmSync(pi.statusFile, { force: true });
  fs.symlinkSync(pi.stateDir, pi.statusFile);
  fs.symlinkSync(pi.sessionFile, `${pi.statusFile}.tmp`);

  const s = helper.main('status', pi.o);
  assert.deepEqual(pi.session(), before, 'the record root owns is untouched');
  assert.equal(s.support.enabled, true, 'and the session it bounds carries on');
  assert.equal(fs.statSync(pi.stateDir).isDirectory(), true, 'and so is the directory it lives in');
  assert.equal(fs.lstatSync(pi.statusFile).isFile(), true, 'while the mirror is a real file again');
});
