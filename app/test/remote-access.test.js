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

function fakePi({ users = [], connect = true, supportUser = '', signin = SIGNIN_OK } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ra-'));
  const passwd = path.join(dir, 'passwd');
  const lines = [
    'root:x:0:0:root:/root:/bin/bash',
    'sshd:x:100:65534::/run/sshd:/usr/sbin/nologin',
    'pitchtribe:x:999:999::/var/lib/pitchtribe:/usr/sbin/nologin',
    ...users.map((u, i) => `${u}:x:${1000 + i}:${1000 + i}::/home/${u}:/bin/bash`),
  ];
  fs.writeFileSync(passwd, `${lines.join('\n')}\n`);
  const calls = [];
  let ssh = 'disabled';
  // What the fake rpi-connect reports, moved along by the calls made to it.
  const pi = { connectOn: false, signedIn: false, linger: new Set(), shellSessions: 0 };
  let now = new Date('2026-11-04T14:00:00Z');
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
      const sub = args.slice(args.indexOf('rpi-connect') + 1);
      if (sub[0] === 'on') pi.connectOn = true;
      if (sub[0] === 'off') pi.connectOn = false;
      if (sub[0] === 'signout') { pi.signedIn = false; pi.shellSessions = 0; }
      if (sub[0] === 'status') {
        return `Signed in: ${pi.signedIn ? 'yes' : 'no'}\nScreen sharing: ${pi.connectOn ? 'allowed' : 'not allowed'}\n`
          + `Remote shell: allowed (${pi.shellSessions} sessions active)\n`;
      }
    }
    return '';
  };
  const o = {
    dataDir: dir,
    passwdFile: passwd,
    supportUser,
    now: () => now,
    exec,
    // The real one starts `rpi-connect signin` detached and reads the
    // verification URL out of its output; write that output straight away.
    spawn: (cmd, args, outFile) => {
      calls.push({ cmd: [cmd, ...args].join(' '), spawned: true });
      if (signin.includes('connect.raspberrypi.com')) pi.signedIn = true;
      fs.writeFileSync(outFile, signin, { mode: 0o600 });
    },
    sleep: () => {},
  };
  const ask = (req) => {
    fs.writeFileSync(path.join(dir, 'remote-access-request.json'), JSON.stringify(req));
    return helper.main('request', o);
  };
  const ran = (re) => calls.filter((c) => re.test(c.cmd)).map((c) => c.cmd);
  return { o, calls, ask, ran, dir, pi, at: (iso) => { now = new Date(iso); } };
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
  const pi = fakePi({ users: ['dan'] });
  const s = pi.ask({ id: 's1', action: 'support-enable', hours: 6 });
  assert.equal(s.last.ok, true, s.last.message);
  assert.equal(s.support.enabled, true);
  assert.equal(s.support.user, 'dan', 'the club’s own login, not root and not a PitchTribe account');
  assert.equal(s.support.hours, 6);
  assert.equal(s.support.expiresAt, '2026-11-04T20:00:00.000Z', 'six hours on from 14:00');
  assert.equal(s.support.signin.url, SIGNIN_URL);
  assert.equal(s.support.signin.code, 'ABCD-1234');
  assert.match(s.last.message, /ends by itself after 6 hours/);

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
  // Unplugged for a fortnight. The timer is Persistent=true, so this is the
  // first thing that runs; the session must not be waiting to be used.
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
  assert.equal(s.support.signin.url, SIGNIN_URL);
});
