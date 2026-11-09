#!/usr/bin/env node
'use strict';
/* PitchTribe remote access helper: switches SSH on or off and sets the login
   used for it, and switches PitchTribe support access (Raspberry Pi Connect)
   on or off, as asked from the dashboard (Settings → Remote access). Runs as
   root (pitchtribe-remote-access@.service), because the dashboard's server
   can't create accounts or start services.

     remote-access.js status           record whether SSH is on, and the logins (boot)
     remote-access.js request          do what remote-access-request.json asks
     remote-access.js support-expire   sign support access out once it has run out (timer)

   remote-access-request.json, written by the server:
     { id, action: 'enable', username, passwordHash }   SHA-512 crypt hash, never the password
     { id, action: 'disable' }
     { id, action: 'support-enable', hours }
     { id, action: 'support-disable' }
   remote-access-status.json, written here:
     { sshEnabled, sshActive, users: [names], username, last, lastRequestId, support: {…} }

   'enable' creates the login if it doesn't exist (in the sudo group, so it can
   run the installer), or sets a new password on one this helper made before,
   makes sure SSH has host keys, and starts SSH. 'disable' stops SSH; the login
   stays, so switching it back on later keeps the same name.

   Support access is a separate thing, and deliberately so: it is off on every
   card, it is the *club's* own Raspberry Pi ID that the device is signed in to
   (we never see the account, and the club can revoke the device from
   connect.raspberrypi.com whenever it likes), and it always expires. SSH is
   untouched by it — a support shell through Connect is an outbound connection
   from the Pi, so no inbound port is opened anywhere and SSH can stay off. */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const USERNAME_RE = /^[a-z][a-z0-9-]{2,30}$/;
// Never touch these, even if asked: system accounts and PitchTribe's own.
const RESERVED = new Set(['root', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy',
  'www-data', 'backup', 'list', 'irc', 'nobody', 'systemd-network', 'systemd-timesync', 'messagebus', 'sshd', 'avahi',
  'pitchtribe', 'pitchtribe-kiosk', 'admin', 'administrator', 'sudo', 'adm', 'ssh', 'user']);
const HASH_RE = /^\$6\$[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{86}$/;

/* How long support access may last. The dashboard offers exactly these, and
   anything else is refused here too — an unbounded support session is the one
   thing this feature exists to avoid. */
const SUPPORT_HOURS = [1, 4, 6, 12, 24];
const SUPPORT_HOURS_DEFAULT = 6;
// The verification URL `rpi-connect signin` prints, and the code at the end of it.
const SIGNIN_URL_RE = /https:\/\/connect\.raspberrypi\.com\/verify\/[A-Za-z0-9][A-Za-z0-9-]{3,31}/;
// How long to wait for that URL to appear before giving up on the sign-in.
const SIGNIN_WAIT_MS = 30_000;

function defaults() {
  return {
    dataDir: process.env.DATA_DIR || '/var/lib/pitchtribe',
    passwdFile: '/etc/passwd',
    supportUser: process.env.SUPPORT_USER || '',
    now: () => new Date(),
    exec: (cmd, args, input) => childProcess.execFileSync(cmd, args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }),
    // `rpi-connect signin` prints its verification URL and then keeps polling
    // until somebody visits it, so it can't be waited on: start it detached,
    // with its output going to a file, and read the URL out of that.
    spawn: (cmd, args, outFile) => {
      const fd = fs.openSync(outFile, 'w', 0o600);
      try {
        childProcess.spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd] }).unref();
      } finally {
        fs.closeSync(fd);
      }
    },
    sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
  };
}

const file = (o, name) => path.join(o.dataDir, name);
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJson(f, value) {
  fs.writeFileSync(`${f}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(`${f}.tmp`, f);
}

/** Accounts people log in as (uid 1000 and up, with a real shell). */
function people(o) {
  const out = [];
  for (const line of fs.readFileSync(o.passwdFile, 'utf8').split('\n')) {
    const [name, , uid, , , , shell] = line.split(':');
    if (Number(uid) >= 1000 && Number(uid) < 60000 && shell && !/nologin|false$/.test(shell)) out.push({ name, uid: Number(uid) });
  }
  return out;
}

function sshState(o) {
  const q = (args) => { try { return o.exec('systemctl', args).trim(); } catch (err) { return String(err.stdout || '').trim(); } };
  return { sshEnabled: q(['is-enabled', 'ssh.service']) === 'enabled', sshActive: q(['is-active', 'ssh.service']) === 'active' };
}

function status(o, extra = {}) {
  const prev = readJson(file(o, 'remote-access-status.json')) || {};
  const next = {
    ...prev,
    ...extra,
    ...sshState(o),
    users: people(o).map((u) => u.name),
    updatedAt: o.now().toISOString(),
  };
  next.support = supportState(o, next.support);
  writeJson(file(o, 'remote-access-status.json'), next);
  return next;
}

/* ---------------------------------------------------------- support access */

/** Is the Connect client on this card at all? Raspberry Pi OS Lite ships it. */
function supportInstalled(o) {
  try { return Boolean(o.exec('sh', ['-c', 'command -v rpi-connect']).trim()); } catch { return false; }
}

/** The account `rpi-connect` runs as. It is a *user* service wanting a user
    bus, and neither `pitchtribe` nor `pitchtribe-kiosk` has a login shell, so
    it is the club's own login — the one Raspberry Pi Imager set up, which is
    also the one `people()` lists. SUPPORT_USER in
    /etc/default/pitchtribe-remote-access overrides it. */
function supportUser(o) {
  const named = String(o.supportUser || '').trim();
  const logins = people(o);
  if (named) {
    const found = logins.find((u) => u.name === named);
    if (!found) throw new Error(`SUPPORT_USER “${named}” is not a login on this Pi`);
    return found;
  }
  if (!logins.length) {
    throw new Error('This Pi has no login account to run support access as. Set one up in Raspberry Pi Imager, or switch SSH on and create one first.');
  }
  return logins[0];
}

/** `rpi-connect` as that user, through their own systemd user session. The
    session only exists because of enable-linger below; without the runtime
    directory and bus address the CLI cannot reach rpi-connectd at all. */
function connectArgs(user, args) {
  return ['-u', user.name, '--', 'env', `XDG_RUNTIME_DIR=/run/user/${user.uid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${user.uid}/bus`, 'rpi-connect', ...args];
}
const connect = (o, user, args) => o.exec('runuser', connectArgs(user, args));

/** What `rpi-connect status` says, when there is a session to ask. */
function connectStatus(o, user) {
  let out = '';
  try { out = connect(o, user, ['status']) || ''; } catch (err) { out = String(err.stdout || ''); }
  return {
    signedIn: /Signed in:\s*yes/i.test(out),
    screenSharing: /Screen sharing:\s*(allowed|yes)/i.test(out),
    // "Remote shell: allowed (1 session active)" — what we actually care about.
    shellSessions: Number((out.match(/Remote shell:[^\n]*?(\d+)\s+session/i) || [])[1] || 0),
  };
}

/** The support block of remote-access-status.json, refreshed from the device.
    Called on every status write, so it must never throw. */
function supportState(o, prev) {
  const base = { enabled: false, user: null, expiresAt: null, hours: null, signin: null, lastConnection: null, ...(prev || {}) };
  let installed = base.installed;
  try { installed = supportInstalled(o); } catch { /* leave what we knew */ }
  const next = { ...base, installed: Boolean(installed) };
  if (!next.enabled || !next.user || !installed) return next;
  try {
    const user = people(o).find((u) => u.name === next.user);
    if (!user) return next;
    const live = connectStatus(o, user);
    next.signedIn = live.signedIn;
    next.screenSharing = live.screenSharing;
    next.shellSessions = live.shellSessions;
    if (live.shellSessions > 0) next.lastConnection = o.now().toISOString();
  } catch { /* the device will say next time */ }
  return next;
}

/** Read the verification URL out of the detached sign-in's output. */
function awaitSigninUrl(o, logFile) {
  const deadline = Date.now() + SIGNIN_WAIT_MS;
  for (;;) {
    let out = '';
    try { out = fs.readFileSync(logFile, 'utf8'); } catch { /* not written yet */ }
    const url = (out.match(SIGNIN_URL_RE) || [])[0];
    if (url) return { url, code: url.split('/').pop() };
    // Signing in needs somebody at a browser, so a clear failure is worth
    // repeating rather than sitting on until the wait runs out.
    if (/error|failed|not found|no such/i.test(out)) throw new Error(out.trim().split('\n').pop());
    if (Date.now() >= deadline) throw new Error('Raspberry Pi Connect did not offer a sign-in link. Check the Pi has internet access.');
    o.sleep(500);
  }
}

function supportEnable(o, req) {
  const hours = Number(req.hours);
  if (!SUPPORT_HOURS.includes(hours)) throw new Error(`Choose how long support access lasts: ${SUPPORT_HOURS.join(', ')} hours`);
  if (!supportInstalled(o)) throw new Error('Raspberry Pi Connect is not installed on this Pi');
  const user = supportUser(o);
  // The user session has to outlive the login that started it, or support
  // access would end at the next reboot with the dashboard still saying it is on.
  const lingering = /Linger=yes/i.test((() => { try { return o.exec('loginctl', ['show-user', user.name]); } catch { return ''; } })());
  if (!lingering) o.exec('loginctl', ['enable-linger', user.name]);
  connect(o, user, ['on']);
  const logFile = file(o, 'remote-access-signin.log');
  fs.rmSync(logFile, { force: true });
  o.spawn('runuser', connectArgs(user, ['signin']), logFile);
  let signin;
  try {
    signin = awaitSigninUrl(o, logFile);
  } catch (err) {
    // Leave nothing half-on behind: a client that is on but not signed in is
    // exactly the "a remote-access client nobody chose" state we are avoiding.
    try { connect(o, user, ['off']); } catch { /* best effort */ }
    if (!lingering) { try { o.exec('loginctl', ['disable-linger', user.name]); } catch { /* best effort */ } }
    throw err;
  }
  const at = o.now();
  const expiresAt = new Date(at.getTime() + hours * 3600_000).toISOString();
  return {
    support: {
      ...supportState(o, { enabled: true, user: user.name, hours, expiresAt, lingeredByUs: !lingering }),
      signin: { ...signin, at: at.toISOString() },
    },
    last: {
      action: 'support-enable',
      at: at.toISOString(),
      ok: true,
      message: `Finish turning support access on at ${signin.url} — it ends by itself after ${hours} ${hours === 1 ? 'hour' : 'hours'}`,
    },
  };
}

/** Sign out and switch the client off. Used by the dashboard's "End support
    access", and by the timer when a session has run out. */
function supportOff(o, action, prev) {
  const state = prev || {};
  const name = state.user;
  const user = name ? people(o).find((u) => u.name === name) : null;
  if (user && supportInstalled(o)) {
    try { connect(o, user, ['signout']); } catch { /* perhaps never signed in */ }
    try { connect(o, user, ['off']); } catch { /* already off */ }
    if (state.lingeredByUs) { try { o.exec('loginctl', ['disable-linger', user.name]); } catch { /* best effort */ } }
  }
  fs.rmSync(file(o, 'remote-access-signin.log'), { force: true });
  return {
    support: {
      ...state,
      enabled: false,
      signedIn: false,
      screenSharing: false,
      shellSessions: 0,
      expiresAt: null,
      hours: null,
      signin: null,
      lingeredByUs: false,
    },
    last: {
      action,
      at: o.now().toISOString(),
      ok: true,
      message: action === 'support-expire' ? 'Support access ran out and has ended' : 'Support access is off',
    },
  };
}

/** The timer's job: end a session that has run out, whether or not anybody
    ever opened the dashboard again. Does nothing the rest of the time. */
function supportExpire(o) {
  const prev = (readJson(file(o, 'remote-access-status.json')) || {}).support;
  if (!prev || !prev.enabled) return status(o);
  if (prev.expiresAt && o.now() < new Date(prev.expiresAt)) return status(o);
  return status(o, supportOff(o, 'support-expire', prev));
}

function enable(o, req) {
  const username = String(req.username || '');
  const hash = String(req.passwordHash || '');
  if (!USERNAME_RE.test(username) || RESERVED.has(username)) throw new Error('Choose a different username: small letters, numbers and hyphens, starting with a letter');
  if (!HASH_RE.test(hash)) throw new Error('The password could not be set');
  const existing = people(o).find((u) => u.name === username);
  let systemUser = false;
  try { systemUser = !existing && fs.readFileSync(o.passwdFile, 'utf8').split('\n').some((l) => l.split(':')[0] === username); } catch { /* no */ }
  if (systemUser) throw new Error(`“${username}” is a system account. Choose a different username.`);
  // A personal login (perhaps the one set in Raspberry Pi Imager) just gets the
  // new password, which also rescues a forgotten one; otherwise create it.
  if (!existing) {
    o.exec('useradd', ['--create-home', '--shell', '/bin/bash', '--groups', 'sudo,adm,video,plugdev', username]);
  }
  o.exec('chpasswd', ['-e'], `${username}:${hash}\n`);
  try { o.exec('ssh-keygen', ['-A']); } catch { /* keys already there */ }
  o.exec('systemctl', ['enable', '--now', 'ssh.service']);
  return { username, last: { action: 'enable', at: o.now().toISOString(), ok: true, message: `Remote access is on for “${username}”` } };
}

function handleRequest(o) {
  const req = readJson(file(o, 'remote-access-request.json'));
  const prev = readJson(file(o, 'remote-access-status.json')) || {};
  if (!req || !req.id || req.id === prev.lastRequestId) return status(o);
  // The request may hold a password hash: remove it as soon as it's read.
  fs.rmSync(file(o, 'remote-access-request.json'), { force: true });
  try {
    if (req.action === 'enable') return status(o, { lastRequestId: req.id, ...enable(o, req) });
    if (req.action === 'disable') {
      o.exec('systemctl', ['disable', '--now', 'ssh.service']);
      return status(o, { lastRequestId: req.id, last: { action: 'disable', at: o.now().toISOString(), ok: true, message: 'Remote access is off' } });
    }
    if (req.action === 'support-enable') return status(o, { lastRequestId: req.id, ...supportEnable(o, req) });
    if (req.action === 'support-disable') return status(o, { lastRequestId: req.id, ...supportOff(o, 'support-disable', prev.support) });
    return status(o, { lastRequestId: req.id });
  } catch (err) {
    const message = err.stderr ? String(err.stderr).trim().split('\n').pop() : err.message;
    return status(o, { lastRequestId: req.id, last: { action: req.action, at: o.now().toISOString(), ok: false, message } });
  }
}

function main(command, o = defaults()) {
  if (command === 'status') return status(o);
  if (command === 'request') return handleRequest(o);
  if (command === 'support-expire') return supportExpire(o);
  throw new Error('usage: remote-access.js status|request|support-expire');
}

module.exports = { main, people, USERNAME_RE, RESERVED, HASH_RE, SUPPORT_HOURS, SUPPORT_HOURS_DEFAULT };

if (require.main === module) {
  try {
    const s = main(process.argv[2]);
    console.log(`ssh ${s.sshActive ? 'on' : 'off'}, support ${s.support && s.support.enabled ? 'on' : 'off'}${s.last ? ` — ${s.last.message}` : ''}`);
    process.exitCode = s.last && !s.last.ok ? 1 : 0;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
