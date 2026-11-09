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
   from the Pi, so no inbound port is opened anywhere and SSH can stay off.

   Two files, and the difference between them is the whole of the safety:

     STATE_DIR/support-session.json     0600 root, in a 0700 root directory.
       The authority. What bounds the session, and the only thing allowed to.
     DATA_DIR/remote-access-status.json 0640 root:pitchtribe.
       A mirror, for the dashboard to read. It decides nothing.

   The dashboard's own user owns DATA_DIR, and a restore chowns everything in
   it, so the mirror is not trustworthy — and the device is asked directly on
   every run regardless of what the mirror says. A Connect client that reports
   itself signed in with no bounded session to account for it is signed out
   there and then. Losing, truncating or editing the mirror cannot leave a
   support session running, and cannot hide one either. */
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
/* The longest session the card will keep running, whatever a record claims.
   The dashboard checks the list, the request path checks it again — and this
   is the third check, on the enforcement path, because that is the one an
   edited or corrupted record walks through. */
const SUPPORT_MAX_MS = Math.max(...SUPPORT_HOURS) * 3600_000;
// A session that simply reached its end, as opposed to one that never made sense.
const RAN_OUT = 'support access ran out';
// The verification URL `rpi-connect signin` prints, and the code at the end of it.
const SIGNIN_URL_RE = /https:\/\/connect\.raspberrypi\.com\/verify\/[A-Za-z0-9][A-Za-z0-9-]{3,31}/;
// How long to wait for that URL to appear before giving up on the sign-in.
const SIGNIN_WAIT_MS = 30_000;
/* The sign-in runs as a named transient unit of the club user's own systemd,
   so that it has both a lifetime and a name to stop it by. */
const SIGNIN_UNIT = 'pitchtribe-support-signin';
// How long to wait for the user session enable-linger asks for to come up.
const RUNTIME_WAIT_MS = 10_000;
/* The path unit and the expiry timer are separate instances of the same
   template and can run at the same time, read-modify-writing the same files. */
const LOCK_WAIT_MS = 60_000;
const LOCK_STALE_MS = 150_000;
// Blank means off. Anything a record claims beyond this has to be earned.
const SUPPORT_OFF = {
  enabled: false,
  user: null,
  hours: null,
  startedAt: null,
  expiresAt: null,
  signin: null,
  signedIn: false,
  screenSharing: false,
  shellSessions: 0,
};

function defaults() {
  return {
    dataDir: process.env.DATA_DIR || '/var/lib/pitchtribe',
    // Root's own, outside DATA_DIR: see the note at the top of this file.
    stateDir: process.env.STATE_DIR || '/var/lib/pitchtribe-remote-access',
    passwdFile: '/etc/passwd',
    supportUser: process.env.SUPPORT_USER || '',
    serviceGroup: process.env.SVC_GROUP || 'pitchtribe',
    now: () => new Date(),
    exec: (cmd, args, input) => childProcess.execFileSync(cmd, args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }),
    // The club user's own runtime directory, which is also somewhere they can
    // be given a file to write: the sign-in output goes there and not into
    // DATA_DIR, which they cannot write to.
    runtimeDir: (uid) => `/run/user/${uid}`,
    hasRuntimeDir: (uid) => fs.existsSync(`/run/user/${uid}`),
    runtimeWaitMs: RUNTIME_WAIT_MS,
    signinWaitMs: SIGNIN_WAIT_MS,
    sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
  };
}

const file = (o, name) => path.join(o.dataDir, name);
const stateFile = (o, name) => path.join(o.stateDir, name);
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
/** Write-then-rename, with the write actually on the card before the rename.
    Without the fsync a power cut mid-write can leave a zero-length file — and
    a signage Pi is unplugged rather than shut down as a matter of routine. */
function writeJson(f, value, mode = 0o600) {
  const tmp = `${f}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, f);
  try {
    const dir = fs.openSync(path.dirname(f), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch { /* some filesystems won't let you, and the rename stands anyway */ }
}

function ensureStateDir(o) {
  fs.mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(o.stateDir, 0o700); } catch { /* not ours to tighten */ }
}

/** The status mirror: 0640 root:pitchtribe. The dashboard has to read it to
    show the sign-in code, and nothing else on the card should be able to. */
function writeStatus(o, next) {
  const f = file(o, 'remote-access-status.json');
  writeJson(f, next, 0o640);
  try { o.exec('chgrp', [o.serviceGroup, f]); } catch { /* no such group off a Pi */ }
}

/** One helper at a time. Both callers are unattended (a path unit and a
    timer), so waiting is fine, but neither may wait for ever: a helper killed
    mid-run must not stop the expiry timer from ever running again. */
function withLock(o, fn) {
  ensureStateDir(o);
  const lock = stateFile(o, 'support.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try { fs.writeFileSync(fd, `${process.pid}\n`); } finally { fs.closeSync(fd); }
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { /* just went */ }
      if (age > LOCK_STALE_MS || Date.now() >= deadline) { fs.rmSync(lock, { force: true }); continue; }
      o.sleep(250);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
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
  /* A caller that has just acted on support access has already asked the
     device and already switched off anything it shouldn't find; everything
     else gets the full reconcile. */
  const refreshed = refreshSupport(o, { ...(prev.support || {}), ...(extra.support || {}) }, { reconcile: !extra.support });
  next.support = refreshed.support;
  if (refreshed.last && !extra.last) next.last = refreshed.last;
  writeStatus(o, next);
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

/** Drop to that user, with their own systemd user session around us. The
    session only exists because of enable-linger below; without the runtime
    directory and bus address the CLI cannot reach rpi-connectd at all. */
function userEnv(user) {
  return ['-u', user.name, '--', 'env', `XDG_RUNTIME_DIR=/run/user/${user.uid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${user.uid}/bus`];
}
/** `rpi-connect` as that user. `wrap` puts the call inside something — the
    sign-in puts it inside a transient unit so that it has a lifetime. */
function connectArgs(user, args, wrap = []) {
  return [...userEnv(user), ...wrap, 'rpi-connect', ...args];
}
const connect = (o, user, args) => o.exec('runuser', connectArgs(user, args));
/** That user's own systemd, for starting and stopping the sign-in unit. */
const userctl = (o, user, args) => o.exec('runuser', [...userEnv(user), 'systemctl', '--user', ...args]);

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

/** Who the device says is signed in. The recorded login is asked first, but
    every login is asked, because a lost or edited record must not be able to
    hide a signed-in client — that is the state we most need to find. */
function liveSession(o, preferredName) {
  const logins = people(o);
  const order = [];
  for (const name of [preferredName, String(o.supportUser || '').trim()]) {
    const found = name && logins.find((u) => u.name === name);
    if (found && !order.includes(found)) order.push(found);
  }
  for (const u of logins) if (!order.includes(u)) order.push(u);
  let first = null;
  for (const user of order) {
    const live = { user, ...connectStatus(o, user) };
    if (!first) first = live;
    if (live.signedIn) return live;
  }
  return first;
}

/* ------------------------------------------- the session record (authority) */

const readSession = (o) => readJson(stateFile(o, 'support-session.json'));

function writeSession(o, session) {
  ensureStateDir(o);
  const f = stateFile(o, 'support-session.json');
  if (!session) { fs.rmSync(f, { force: true }); return null; }
  writeJson(f, session, 0o600);
  return session;
}

/** Is this a session the card is still allowed to be running? Everything that
    bounds support access is checked here, on the enforcement path: a record
    with no clock, a backwards one, one claiming longer than the longest length
    on offer, and one that has simply run out all come out the same way — not
    valid, so sign out. The hours allow-list on the way in is not enough on its
    own, because it is not the allow-list the timer reads. */
function sessionBounds(session, now) {
  if (!session || !session.user) return { valid: false, why: 'no support session is recorded' };
  const started = Date.parse(session.startedAt);
  const expires = Date.parse(session.expiresAt);
  if (!Number.isFinite(started) || !Number.isFinite(expires)) return { valid: false, why: 'the support session has no usable expiry' };
  if (expires <= started) return { valid: false, why: 'the support session expires before it started' };
  // A minute of slack so a clock correction mid-session isn't fatal.
  if (expires - started > SUPPORT_MAX_MS + 60_000) {
    return { valid: false, why: `the support session is longer than the ${Math.max(...SUPPORT_HOURS)} hours allowed` };
  }
  if (now.getTime() >= expires) return { valid: false, why: RAN_OUT };
  return { valid: true };
}

/** The support block of remote-access-status.json. The *device* fills it in:
    whenever the Connect client is installed we ask it, whatever the mirror
    says, and the session record — not the mirror — decides whether what it
    reports is allowed. Anything signed in that no bounded session accounts for
    is signed out here and now rather than reported.

    Called on every status write, so it must never throw. */
function refreshSupport(o, prev, { reconcile = true } = {}) {
  const base = prev || {};
  let installed = Boolean(base.installed);
  try { installed = supportInstalled(o); } catch { /* leave what we knew */ }

  const session = readSession(o);
  const bounds = sessionBounds(session, o.now());
  const next = { ...SUPPORT_OFF, installed, lastConnection: base.lastConnection || null };
  if (bounds.valid) {
    next.enabled = true;
    next.user = session.user;
    next.hours = session.hours || null;
    next.startedAt = session.startedAt;
    next.expiresAt = session.expiresAt;
    next.signin = session.signin || null;
  }
  if (!installed) return { support: next };

  let live = null;
  try { live = liveSession(o, session && session.user); } catch { /* ask again next time */ }
  if (!live) return { support: next };
  next.signedIn = live.signedIn;
  next.screenSharing = live.screenSharing;
  next.shellSessions = live.shellSessions;
  if (live.shellSessions > 0) next.lastConnection = o.now().toISOString();

  /* Signed in with nothing to account for it. This is the case the whole
     arrangement exists for: a lost mirror, a restored one, an edited one, or a
     session the timer should have ended and somehow didn't. End it now. */
  if (live.signedIn && !bounds.valid && reconcile) {
    try {
      const off = supportOff(o, 'support-reconcile', {
        user: live.user.name,
        lingeredByUs: Boolean(session && session.lingeredByUs),
      }, bounds.why);
      return { support: { ...off.support, installed, lastConnection: next.lastConnection }, last: off.last };
    } catch { /* fall through and report what the device said */ }
  }
  return { support: next };
}

/** Read the verification URL out of the sign-in unit's output. */
function awaitSigninUrl(o, logFile) {
  const deadline = Date.now() + (o.signinWaitMs === undefined ? SIGNIN_WAIT_MS : o.signinWaitMs);
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

/** Wait for the user session enable-linger asked for. `loginctl` returns
    before user@<uid>.service has necessarily created the runtime directory,
    and without that directory the very next rpi-connect call has no bus to
    talk to — a flaky first switch-on rather than a dangerous one, but there is
    no reason to put up with it. */
function awaitRuntimeDir(o, user) {
  const deadline = Date.now() + (o.runtimeWaitMs === undefined ? RUNTIME_WAIT_MS : o.runtimeWaitMs);
  for (;;) {
    if (o.hasRuntimeDir(user.uid)) return;
    if (Date.now() >= deadline) throw new Error('The Pi did not open a background session for support access. Try again in a minute.');
    o.sleep(250);
  }
}

const signinLog = (o, user) => path.join(o.runtimeDir(user.uid), `${SIGNIN_UNIT}.log`);

/** Start `rpi-connect signin` as a named transient unit of that user's own
    systemd, with its output going to a file in their runtime directory.

    It prints a verification URL and then polls until somebody visits it, so it
    cannot be waited on — but it must not be left running loose either. Loose,
    it is in this one-shot service's cgroup, and systemd kills what is left
    there when ExecStart returns, so the pairing could never be completed; and
    if it did survive, a browser visit after the session ended could sign the
    card back in with nothing watching. A unit has a lifetime of its own and a
    name to stop it by, which fixes both. */
function startSignin(o, user) {
  const log = signinLog(o, user);
  try { userctl(o, user, ['stop', `${SIGNIN_UNIT}.service`]); } catch { /* not running */ }
  fs.rmSync(log, { force: true });
  o.exec('runuser', connectArgs(user, ['signin'], ['systemd-run', '--user', '--quiet', `--unit=${SIGNIN_UNIT}`,
    '--collect', `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`]));
  return log;
}

function supportEnable(o, req) {
  const hours = Number(req.hours);
  if (!SUPPORT_HOURS.includes(hours)) throw new Error(`Choose how long support access lasts: ${SUPPORT_HOURS.join(', ')} hours`);
  if (!supportInstalled(o)) throw new Error('Raspberry Pi Connect is not installed on this Pi');
  const user = supportUser(o);
  // The user session has to outlive the login that started it, or support
  // access would end at the next reboot with the dashboard still saying it is on.
  const lingering = /Linger=yes/i.test((() => { try { return o.exec('loginctl', ['show-user', user.name]); } catch { return ''; } })());
  const at = o.now();
  let signin;
  try {
    if (!lingering) o.exec('loginctl', ['enable-linger', user.name]);
    awaitRuntimeDir(o, user);
    connect(o, user, ['on']);
    signin = awaitSigninUrl(o, startSignin(o, user));
  } catch (err) {
    // Leave nothing half-on behind: a client that is on but not signed in is
    // exactly the "a remote-access client nobody chose" state we are avoiding,
    // and a sign-in still waiting at its URL could complete later.
    try { userctl(o, user, ['stop', `${SIGNIN_UNIT}.service`]); } catch { /* best effort */ }
    try { connect(o, user, ['off']); } catch { /* best effort */ }
    if (!lingering) { try { o.exec('loginctl', ['disable-linger', user.name]); } catch { /* best effort */ } }
    writeSession(o, null);
    throw err;
  }
  /* The authority, written before anything reports the session as on. Nothing
     in DATA_DIR is consulted to decide when this ends. */
  writeSession(o, {
    user: user.name,
    hours,
    startedAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + hours * 3600_000).toISOString(),
    lingeredByUs: !lingering,
    signin: { ...signin, at: at.toISOString() },
  });
  // The URL is in the session record now; don't leave it in a second place.
  try { fs.rmSync(signinLog(o, user), { force: true }); } catch { /* already gone */ }
  return {
    support: refreshSupport(o, {}, { reconcile: false }).support,
    last: {
      action: 'support-enable',
      at: at.toISOString(),
      ok: true,
      message: `Finish turning support access on at ${signin.url} — it ends by itself after ${hours} ${hours === 1 ? 'hour' : 'hours'}`,
    },
  };
}

/** Sign out and switch the client off, then *check* — the dashboard's "End
    support access", the timer when a session has run out, and the reconcile
    when the device turns out to be signed in with no session behind it all
    come through here. The two commands are not taken at their word: if the
    device still reports itself signed in afterwards the club is told so,
    because "we pressed the button" is not the same as "it is off". */
function supportOff(o, action, prev, why) {
  const state = prev || {};
  const name = state.user;
  const user = name ? people(o).find((u) => u.name === name) : null;
  let signedIn = false;
  let installed = false;
  try { installed = supportInstalled(o); } catch { /* assume not */ }
  if (user && installed) {
    // Stop the sign-in first: a pairing completed after this point would sign
    // the card back in behind everyone's back.
    try { userctl(o, user, ['stop', `${SIGNIN_UNIT}.service`]); } catch { /* not running */ }
    try { connect(o, user, ['signout']); } catch { /* perhaps never signed in */ }
    try { connect(o, user, ['off']); } catch { /* already off */ }
    if (state.lingeredByUs) { try { o.exec('loginctl', ['disable-linger', user.name]); } catch { /* best effort */ } }
    try { signedIn = connectStatus(o, user).signedIn; } catch { /* nothing to ask */ }
    if (signedIn) {
      try { connect(o, user, ['signout']); } catch { /* best effort */ }
      try { signedIn = connectStatus(o, user).signedIn; } catch { signedIn = false; }
    }
    try { fs.rmSync(signinLog(o, user), { force: true }); } catch { /* already gone */ }
  }
  // Older cards kept the sign-in output here.
  fs.rmSync(file(o, 'remote-access-signin.log'), { force: true });
  writeSession(o, null);
  let message = 'Support access is off';
  if (signedIn) {
    message = 'Support access could not be ended: Raspberry Pi Connect still reports this Pi as signed in. Remove the device at connect.raspberrypi.com.';
  } else if (action === 'support-expire') {
    message = why === RAN_OUT ? 'Support access ran out and has ended' : `Support access has ended — ${why}`;
  } else if (action === 'support-reconcile') {
    message = `Support access was signed out — ${why || 'nothing on this card accounted for it'}`;
  }
  return {
    support: { ...SUPPORT_OFF, installed, signedIn },
    last: { action, at: o.now().toISOString(), ok: !signedIn, message },
  };
}

/** The timer's job: end a session that has run out, whether or not anybody
    ever opened the dashboard again — and whatever the dashboard's own mirror
    of the state happens to say, since that is not what is read here. Does
    nothing the rest of the time, beyond the device check every status does. */
function supportExpire(o) {
  const session = readSession(o);
  const bounds = sessionBounds(session, o.now());
  if (session && !bounds.valid) return status(o, supportOff(o, 'support-expire', session, bounds.why));
  return status(o);
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

/** What "End support access" has to act on. Normally the session record; but
    if there is no record and the device says it is signed in anyway, that is
    what gets switched off. The one thing this button must never do is report
    "support access is off" while the Pi is still signed in and reachable. */
function endable(o, prev) {
  const session = readSession(o);
  if (session) return session;
  let live = null;
  try { live = supportInstalled(o) ? liveSession(o, prev.support && prev.support.user) : null; } catch { /* nothing to ask */ }
  return live && live.signedIn ? { user: live.user.name, lingeredByUs: false } : { user: null };
}

function handleRequest(o) {
  const requestFile = file(o, 'remote-access-request.json');
  let raw = null;
  try { raw = fs.readFileSync(requestFile, 'utf8'); } catch { /* nothing asked */ }
  /* The request may hold a password hash, so it goes as soon as it is read —
     before anything is decided about it. A malformed one and a replayed one
     are read too, and must not be left lying about either. */
  if (raw !== null) fs.rmSync(requestFile, { force: true });
  let req = null;
  try { req = JSON.parse(raw); } catch { /* not ours to act on */ }
  const prev = readJson(file(o, 'remote-access-status.json')) || {};
  if (!req || !req.id || req.id === prev.lastRequestId) return status(o);
  try {
    if (req.action === 'enable') return status(o, { lastRequestId: req.id, ...enable(o, req) });
    if (req.action === 'disable') {
      o.exec('systemctl', ['disable', '--now', 'ssh.service']);
      return status(o, { lastRequestId: req.id, last: { action: 'disable', at: o.now().toISOString(), ok: true, message: 'Remote access is off' } });
    }
    if (req.action === 'support-enable') return status(o, { lastRequestId: req.id, ...supportEnable(o, req) });
    if (req.action === 'support-disable') return status(o, { lastRequestId: req.id, ...supportOff(o, 'support-disable', endable(o, prev)) });
    return status(o, { lastRequestId: req.id });
  } catch (err) {
    const message = err.stderr ? String(err.stderr).trim().split('\n').pop() : err.message;
    return status(o, { lastRequestId: req.id, last: { action: req.action, at: o.now().toISOString(), ok: false, message } });
  }
}

function main(command, o = defaults()) {
  if (command !== 'status' && command !== 'request' && command !== 'support-expire') {
    throw new Error('usage: remote-access.js status|request|support-expire');
  }
  // One at a time: the path unit and the expiry timer are separate instances
  // of the same template and would otherwise interleave over the same files.
  return withLock(o, () => {
    if (command === 'status') return status(o);
    if (command === 'request') return handleRequest(o);
    return supportExpire(o);
  });
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
