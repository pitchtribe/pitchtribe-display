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
     DATA_DIR/remote-access-status.json 0640 root:pitchtribe-dashboard.
       A mirror, for the dashboard to read. It decides nothing.

   The dashboard's own user owns DATA_DIR, and a restore chowns everything in
   it, so the mirror is not trustworthy — and the device is asked directly on
   every run regardless of what the mirror says. A Connect client that reports
   itself signed in with no bounded session to account for it is signed out
   there and then. Losing, truncating or editing the mirror cannot leave a
   support session running, and cannot hide one either.

   That cuts both ways, and the second half of it is easier to miss than the
   first: *nothing read out of DATA_DIR may steer a write made by this process*.
   Every write here goes through writeJson(), on a temporary file this process
   certainly created (O_EXCL|O_NOFOLLOW), with the mode and the owner set on the
   file descriptor rather than on the path — because the one thing the account
   that owns DATA_DIR can do there is put a symlink in the way of a name root is
   about to write. status() carries keys forward from the mirror by name for the
   same reason: spreading whatever else is in that file back out again makes it
   a way of choosing the content of root's next write. */
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
/* A minute of slack on *the clock*, and nowhere else. A Pi has no real-time
   clock: it boots with fake-hwclock's last-shutdown time and systemd-timesyncd
   steps it some seconds later, so a run can legitimately see a clock a little
   behind where the session says it is. It cannot legitimately see one hours
   behind — see sessionBounds(). */
const CLOCK_SLACK_MS = 60_000;
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
/* Nothing here is worth waiting on for ever. A wedged rpi-connectd would
   otherwise hold the lock indefinitely — and liveSessions() makes one call per
   login on the card, so there are several chances for it on every run. */
const EXEC_TIMEOUT_MS = 30_000;
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
    groupFile: '/etc/group',
    supportUser: process.env.SUPPORT_USER || '',
    /* The group the status mirror is readable as, and it has exactly one
       member: the dashboard's own user. Not group `pitchtribe` — that one is
       wider than the dashboard (the captive portal's user joins it to reach
       DATA_DIR/portal) and the mirror holds a live Connect verification code
       while a sign-in is waiting to be finished. */
    mirrorGroup: process.env.MIRROR_GROUP || 'pitchtribe-dashboard',
    now: () => new Date(),
    exec: (cmd, args, input) => childProcess.execFileSync(cmd, args, { encoding: 'utf8', input, timeout: EXEC_TIMEOUT_MS, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }),
    /* Where the sign-in unit's output goes. Root's own directory, with the log
       inside it created by root and handed to the club user to append to: in
       their own /run/user/<uid> they could replace the name with a symlink
       between our creating it and our reading it, and root would read whatever
       it pointed at — and a failure put the last line of that into the mirror
       the dashboard renders. They can still write nonsense into their own log,
       which is inherent in delegating to them; they cannot choose which file
       it is. */
    signinDir: process.env.SIGNIN_DIR || '/run/pitchtribe-remote-access',
    hasRuntimeDir: (uid) => fs.existsSync(`/run/user/${uid}`),
    runtimeWaitMs: RUNTIME_WAIT_MS,
    signinWaitMs: SIGNIN_WAIT_MS,
    sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
    // Detail for the journal that has no business in a file the dashboard reads.
    warn: (message) => { console.error(message); },
  };
}

// Only on the card is this root; off it (the tests, a dev box) nothing can be
// chowned, and a chown that fails there is expected rather than a problem.
const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

const file = (o, name) => path.join(o.dataDir, name);
const stateFile = (o, name) => path.join(o.stateDir, name);
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

/** Write-then-rename, with the write actually on the card before the rename,
    onto a temporary file this process certainly created itself.

    The mirror's temporary file lands in DATA_DIR, where the dashboard's own
    user can create names. So every part of this is deliberate:

      rmSync      unlinks a symlink left at that name rather than following it.
      O_EXCL      we write only a file we have just created — never one somebody
                  else pre-made, which with 'w' would have kept their inode and
                  their mode, and with it their ownership of the renamed file.
      O_NOFOLLOW  and never through a link planted in the moment in between.
      fchmod,     set on the descriptor, not on the path: a path can be made to
      fchown      mean something else between two calls, a descriptor cannot.

    Without that, root followed a link at `${f}.tmp` and wrote content a caller
    had partly chosen into whatever it pointed at — including the session record
    that bounds support access, in a directory this user otherwise cannot reach.
    `f` itself being a symlink stops mattering once tmp is a real file, because
    rename() replaces the link instead of following it.

    The fsyncs are a different concern: without them a power cut mid-write can
    leave a zero-length file, and a signage Pi is unplugged rather than shut
    down as a matter of routine. */
function writeJson(f, value, { mode = 0o600, gid = null } = {}) {
  const tmp = `${f}.tmp`;
  fs.rmSync(tmp, { force: true });
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT
    | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    // 'w'-style modes apply on create only; this one applies full stop.
    fs.fchmodSync(fd, mode);
    if (gid !== null) {
      try { fs.fchownSync(fd, 0, gid); } catch (err) { if (isRoot()) throw err; }
    }
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, f);
  try {
    const dir = fs.openSync(path.dirname(f), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch { /* some filesystems won't let you, and the rename stands anyway */ }
}

/** A group's gid, from the group file, without shelling out to anything. */
function groupGid(o, name) {
  if (!name) return null;
  try {
    for (const line of fs.readFileSync(o.groupFile, 'utf8').split('\n')) {
      const [n, , gid] = line.split(':');
      if (n === name && Number.isInteger(Number(gid))) return Number(gid);
    }
  } catch { /* no group file to read, off a Pi */ }
  return null;
}

function ensureStateDir(o) {
  fs.mkdirSync(o.stateDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(o.stateDir, 0o700); } catch { /* not ours to tighten */ }
}

/** The status mirror: 0640 root, group `pitchtribe-dashboard`, whose only
    member is the dashboard's own user. The dashboard has to read this to show
    the sign-in code; nothing else on the card may, and `pitchtribe` is not a
    narrow enough group to say that with — the captive portal's user is in it,
    and that is the one process guests on an untrusted network can reach. */
function writeStatus(o, next) {
  const f = file(o, 'remote-access-status.json');
  const gid = groupGid(o, o.mirrorGroup);
  if (gid === null) {
    /* Nothing to narrow it to, so keep it root's. The dashboard then shows
       Remote access as unavailable until the installer is re-run, which is
       visible and recoverable; a verification code the wrong account can read
       is neither. */
    o.warn(`group ${o.mirrorGroup} does not exist — keeping ${f} root-only; re-run the PitchTribe installer`);
    writeJson(f, next, { mode: 0o600 });
    return;
  }
  writeJson(f, next, { mode: 0o640, gid });
}

const lockFile = (o) => stateFile(o, 'support.lock');
const lockPid = (o) => { try { return Number(String(fs.readFileSync(lockFile(o), 'utf8')).trim()) || 0; } catch { return 0; } };

/** One helper at a time: the path unit and the expiry timer are separate
    instances of the same template and would otherwise interleave over the same
    files. Returns a function that releases it, or null when it could not be
    taken — which is the caller's to judge, because the answer is not the same
    for all three actions. Never throws: an expiry that stops happening because
    the card filled up would be the one failure this feature must not have. */
function takeLock(o) {
  try { ensureStateDir(o); } catch { return null; }
  const lock = lockFile(o);
  const stale = o.lockStaleMs === undefined ? LOCK_STALE_MS : o.lockStaleMs;
  const deadline = Date.now() + (o.lockWaitMs === undefined ? LOCK_WAIT_MS : o.lockWaitMs);
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try { fs.writeFileSync(fd, `${process.pid}\n`); } finally { fs.closeSync(fd); }
      /* Release our own lock and no one else's. If a waiter stole a lock we
         were still holding, the holder unlinking it unconditionally would take
         the thief's lock away and let a third helper in alongside both. */
      return () => { if (lockPid(o) === process.pid) fs.rmSync(lock, { force: true }); };
    } catch (err) {
      if (err.code !== 'EEXIST') return null;
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; /* just went */ }
      /* Steal only a lock old enough to belong to nobody. A support-enable
         legitimately holds it for the runtime-directory wait plus the sign-in
         wait, ~40s, comfortably under this; STATE_DIR is 0700 root, so nothing
         else can keep the mtime fresh. Waiting a long time is *not* evidence
         of a dead holder — it is evidence of a slow one — so the deadline
         gives up instead, and running two helpers over the same files at once
         is exactly what this exists to prevent. */
      if (age > stale) { fs.rmSync(lock, { force: true }); continue; }
      if (Date.now() >= deadline) return null;
      o.sleep(250);
    }
  }
}

/** Every account in the people range (uid 1000 and up), whatever shell it has.
    Which matters in one direction only: people() below is the list support
    access may be *started* as, and a shell is part of being that. Finding a
    Connect client already signed in is the other direction, and an account
    whose shell was set to nologin afterwards can still be holding one. */
function accounts(o) {
  const out = [];
  try {
    for (const line of fs.readFileSync(o.passwdFile, 'utf8').split('\n')) {
      const [name, , uid, gid, , , shell] = line.split(':');
      if (Number(uid) >= 1000 && Number(uid) < 60000) out.push({ name, uid: Number(uid), gid: Number(gid), shell: shell || '' });
    }
  } catch { /* no passwd file to read */ }
  return out;
}

/** Accounts people log in as (uid 1000 and up, with a real shell). */
const people = (o) => accounts(o).filter((u) => u.shell && !/nologin|false$/.test(u.shell));
const login = (o, name) => (name ? accounts(o).find((u) => u.name === name) || null : null);

function sshState(o) {
  const q = (args) => { try { return o.exec('systemctl', args).trim(); } catch (err) { return String(err.stdout || '').trim(); } };
  return { sshEnabled: q(['is-enabled', 'ssh.service']) === 'enabled', sshActive: q(['is-active', 'ssh.service']) === 'active' };
}

/** What is allowed to survive a run by sitting in the mirror. Three things
    need to: the SSH login's name, the last thing that happened, and the id of
    the request it happened for. Everything else is rebuilt from the card.

    This used to be `{ ...prev }`. The mirror is in DATA_DIR, so that spread
    copied every top-level key the dashboard's own user cared to put in the
    file straight back out into root's next write — which is both how a forged
    session record got its content and, more generally, a way of choosing what
    root writes. Carrying three keys forward by name, with their shapes
    checked, is all that was ever wanted. */
function keepFromMirror(prev) {
  const kept = {};
  const str = (x, max) => (typeof x === 'string' && x.length <= max ? x : undefined);
  if (str(prev.username, 32) !== undefined) kept.username = prev.username;
  if (str(prev.lastRequestId, 64) !== undefined) kept.lastRequestId = prev.lastRequestId;
  if (prev.last && typeof prev.last === 'object' && !Array.isArray(prev.last)) {
    kept.last = {
      action: str(prev.last.action, 32) || null,
      at: str(prev.last.at, 32) || null,
      ok: Boolean(prev.last.ok),
      message: str(prev.last.message, 500) || '',
    };
  }
  return kept;
}

function status(o, extra = {}) {
  const prev = readJson(file(o, 'remote-access-status.json')) || {};
  const next = {
    ...keepFromMirror(prev),
    ...extra,
    ...sshState(o),
    users: people(o).map((u) => u.name),
    updatedAt: o.now().toISOString(),
  };
  /* A caller that has just acted on support access has already asked the
     device and already switched off anything it shouldn't find; everything
     else gets the full reconcile. */
  const acted = extra.support || null;
  const refreshed = refreshSupport(o, { ...(prev.support || {}), ...(acted || {}) }, { reconcile: !acted });
  next.support = refreshed.support;
  /* One thing the refresh is not allowed to do: argue a signed-in device back
     to "off". supportOff() asked it a moment ago, while there was still a user
     session to ask over, and taking linger back closes that bus — so a refresh
     that cannot reach the device now knows less than the call that just ran,
     not more. "It is off" is the one claim here that must never be a guess. */
  if (acted && acted.signedIn && !next.support.signedIn) next.support = { ...next.support, signedIn: true };
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

/** Every account the card could be signed in as: the logins, plus the recorded
    user and SUPPORT_USER even if their shell has since been set to nologin and
    they have dropped out of people(). A client signed in under an account that
    is no longer a login is precisely the one that would otherwise go unseen. */
function candidates(o, preferredName) {
  const all = accounts(o);
  const order = [];
  const add = (u) => { if (u && !order.some((x) => x.name === u.name)) order.push(u); };
  for (const name of [preferredName, String(o.supportUser || '').trim()]) {
    add(name ? all.find((u) => u.name === name) : null);
  }
  for (const u of all) add(u);
  return order;
}

/** Who the device says is signed in. Every candidate is asked, and all of them
    every time: a lost or edited record must not be able to hide a signed-in
    client, and stopping at the first one found would mask a second client
    signed in under another account for as long as the first session stayed
    valid. The recorded login is asked first only so that the usual case costs
    nothing to read. */
function liveSessions(o, preferredName) {
  return candidates(o, preferredName).map((user) => ({ user, ...connectStatus(o, user) }));
}

/* ------------------------------------------- the session record (authority) */

/** The record, and when root wrote it. The mtime is a second witness to when
    the session really started: it is set by root in a 0700 root directory, so
    the one account this bound exists to constrain cannot roll it forward. */
function readSessionRecord(o) {
  const f = stateFile(o, 'support-session.json');
  const session = readJson(f);
  let writtenAtMs = NaN;
  try { writtenAtMs = fs.statSync(f).mtimeMs; } catch { /* no record to date */ }
  return { session, writtenAtMs };
}

function writeSession(o, session) {
  ensureStateDir(o);
  const f = stateFile(o, 'support-session.json');
  if (!session) { fs.rmSync(f, { force: true }); return null; }
  writeJson(f, session, { mode: 0o600 });
  return session;
}

/** Is this a session the card is still allowed to be running? Everything that
    bounds support access is checked here, on the enforcement path: a record
    with no clock, a backwards one, one claiming longer than the longest length
    on offer, one that has simply run out, and one the clock has fallen behind
    all come out the same way — not valid, so sign out. The hours allow-list on
    the way in is not enough on its own, because it is not the allow-list the
    timer reads. */
function sessionBounds(session, now, writtenAtMs = NaN) {
  if (!session || !session.user) return { valid: false, why: 'no support session is recorded' };
  const started = Date.parse(session.startedAt);
  const expires = Date.parse(session.expiresAt);
  const longest = `longer than the ${Math.max(...SUPPORT_HOURS)} hours allowed`;
  if (!Number.isFinite(started) || !Number.isFinite(expires)) return { valid: false, why: 'the support session has no usable expiry' };
  if (expires <= started) return { valid: false, why: 'the support session expires before it started' };
  /* No slack here. Both timestamps are written together by root from one
     reading of the clock, so nothing can move one without the other, and the
     only thing slack could ever buy is a record claiming an hour too much. */
  if (expires - started > SUPPORT_MAX_MS) return { valid: false, why: `the support session is ${longest}` };
  const t = now.getTime();
  if (t >= expires) return { valid: false, why: RAN_OUT };
  /* The clock has fallen behind the session. Checking `now` against the expiry
     but never against the start left a well-formed one-hour session valid for
     as long as the clock sat before its end — and the realistic way for that
     to happen is the first run of all: a Pi has no RTC, boots with
     fake-hwclock's last-shutdown time, and OnBootSec=15s can fire before
     timesyncd has stepped it. `now` before `startedAt` is not an ambiguous
     state, it is a positive signal that this has happened, and it was being
     thrown away. */
  if (t < started - CLOCK_SLACK_MS) return { valid: false, why: 'the clock has moved behind the support session' };
  // And the second witness: however the recorded clock reads, root wrote this
  // record when the session began, and that cannot have been a day ago.
  if (Number.isFinite(writtenAtMs) && t - writtenAtMs > SUPPORT_MAX_MS) {
    return { valid: false, why: `the support session was recorded ${longest} ago` };
  }
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

  const { session, writtenAtMs } = readSessionRecord(o);
  const bounds = sessionBounds(session, o.now(), writtenAtMs);
  // base is the mirror, so even the one thing carried over from it is checked.
  const was = Number.isFinite(Date.parse(base.lastConnection)) ? base.lastConnection : null;
  const next = { ...SUPPORT_OFF, installed, lastConnection: was };
  if (bounds.valid) {
    next.enabled = true;
    next.user = session.user;
    next.hours = session.hours || null;
    next.startedAt = session.startedAt;
    next.expiresAt = session.expiresAt;
    next.signin = session.signin || null;
  }
  if (!installed) return { support: next };

  let lives = [];
  try { lives = liveSessions(o, session && session.user); } catch { return { support: next }; }
  // The one account a bounded session accounts for, and everything else.
  const accounted = bounds.valid ? next.user : null;
  const mine = lives.find((l) => l.user.name === accounted);
  const rogue = lives.filter((l) => l.signedIn && l.user.name !== accounted);
  const report = mine || (rogue.length ? rogue[0] : null);
  if (report) {
    next.signedIn = report.signedIn;
    next.screenSharing = report.screenSharing;
    next.shellSessions = report.shellSessions;
    if (report.shellSessions > 0) next.lastConnection = o.now().toISOString();
  }
  /* A code that has been used must not outlive its use: to the club it is now
     worth nothing, and to anyone else it is worth the whole device. */
  if (next.signedIn) next.signin = null;
  if (!rogue.length || !reconcile) return { support: next };

  /* Signed in with nothing to account for it. This is the case the whole
     arrangement exists for: a lost mirror, a restored one, an edited one, a
     session the timer should have ended and somehow didn't — or a second
     Connect client signed in under another login on the card, which is the one
     a valid session used to hide. End every one of them now. */
  let last = null;
  let stubborn = false;
  for (const r of rogue) {
    try {
      const off = supportOff(o, 'support-reconcile', {
        user: r.user.name,
        // Only the recorded user's linger was ever ours to take back.
        lingeredByUs: Boolean(session && session.lingeredByUs && session.user === r.user.name),
      }, bounds.valid ? 'no support session accounts for it' : bounds.why, { clearSession: !bounds.valid });
      last = off.last;
      if (off.support.signedIn) stubborn = true;
    } catch { /* report what the device said and try again next run */ }
  }
  if (!last) return { support: next };
  // A valid session carries on; the rest of the card is now off.
  if (bounds.valid) return { support: { ...next, signedIn: mine ? next.signedIn : stubborn }, last };
  return { support: { ...SUPPORT_OFF, installed, signedIn: stubborn, lastConnection: next.lastConnection }, last };
}

/** Read the file we created, and not whatever has been put at its name since.
    O_NOFOLLOW refuses a symlink, and the owner check refuses a file that is not
    the one we handed to that user — the directory is root's, so neither should
    be possible, and both are cheap to be certain of. */
function readSigninLog(log) {
  let fd = null;
  try { fd = fs.openSync(log.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { return ''; }
  try {
    return fs.fstatSync(fd).uid === log.owner ? fs.readFileSync(fd, 'utf8') : '';
  } catch { return ''; } finally { fs.closeSync(fd); }
}

/** Read the verification URL out of the sign-in unit's output. */
function awaitSigninUrl(o, log) {
  const deadline = Date.now() + (o.signinWaitMs === undefined ? SIGNIN_WAIT_MS : o.signinWaitMs);
  for (;;) {
    const out = readSigninLog(log);
    const url = (out.match(SIGNIN_URL_RE) || [])[0];
    if (url) return { url, code: url.split('/').pop() };
    // Signing in needs somebody at a browser, so a clear failure is worth
    // repeating rather than sitting on until the wait runs out. What it said
    // goes to the journal and not into the message: this is the club user's
    // own file, the last line of it is theirs to choose, and the message ends
    // up in the status mirror and on the dashboard.
    if (/error|failed|not found|no such/i.test(out)) {
      o.warn(`support sign-in: ${out.trim().split('\n').pop()}`);
      throw new Error('Raspberry Pi Connect could not start a sign-in. Check the Pi has internet access.');
    }
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

const signinLogPath = (o, user) => path.join(o.signinDir, `${SIGNIN_UNIT}-${user.name}.log`);
const removeSigninLog = (o, user) => { try { fs.rmSync(signinLogPath(o, user), { force: true }); } catch { /* read-only card */ } };

/** Make the file the sign-in unit writes to: root's directory, root's name,
    owned by the club user so their systemd can append to it. They can write
    what they like into it — that is inherent in running the sign-in as them —
    but they cannot make the name mean a different file. */
function makeSigninLog(o, user) {
  const p = signinLogPath(o, user);
  fs.mkdirSync(o.signinDir, { recursive: true, mode: 0o755 });
  try { fs.chmodSync(o.signinDir, 0o755); } catch { /* not ours to tighten */ }
  fs.rmSync(p, { force: true });
  const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT
    | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    // -1 leaves the group alone, for a passwd line we could not read one from.
    const gid = Number.isInteger(user.gid) ? user.gid : -1;
    try { fs.fchownSync(fd, user.uid, gid); } catch (err) { if (isRoot()) throw err; }
    return { path: p, owner: fs.fstatSync(fd).uid };
  } finally {
    fs.closeSync(fd);
  }
}

/** Start `rpi-connect signin` as a named transient unit of that user's own
    systemd, with its output going to a file root made for it to append to.

    It prints a verification URL and then polls until somebody visits it, so it
    cannot be waited on — but it must not be left running loose either. Loose,
    it is in this one-shot service's cgroup, and systemd kills what is left
    there when ExecStart returns, so the pairing could never be completed; and
    if it did survive, a browser visit after the session ended could sign the
    card back in with nothing watching. A unit has a lifetime of its own and a
    name to stop it by, which fixes both. */
function startSignin(o, user) {
  try { userctl(o, user, ['stop', `${SIGNIN_UNIT}.service`]); } catch { /* not running */ }
  const log = makeSigninLog(o, user);
  /* stdbuf is free insurance on the one thing about this that is still
     unverified against real hardware: whether rpi-connect flushes its
     verification URL when stdout is a file rather than a terminal. A Go or
     Rust binary does and this is a no-op; a C one using stdio would hold the
     URL in a 4 KB buffer that a process which then polls for ever never
     flushes, and the sign-in would time out having printed nothing. */
  o.exec('runuser', connectArgs(user, ['signin'], ['systemd-run', '--user', '--quiet', `--unit=${SIGNIN_UNIT}`,
    '--collect', `--property=StandardOutput=append:${log.path}`, `--property=StandardError=append:${log.path}`,
    'stdbuf', '-oL', '-eL']));
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
    removeSigninLog(o, user);
    if (!lingering) { try { o.exec('loginctl', ['disable-linger', user.name]); } catch { /* best effort */ } }
    try { writeSession(o, null); } catch { /* nothing was written to undo */ }
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
  removeSigninLog(o, user);
  return {
    support: refreshSupport(o, {}, { reconcile: false }).support,
    last: {
      action: 'support-enable',
      at: at.toISOString(),
      ok: true,
      /* Deliberately without the URL in it. `last` is mirrored for the
         dashboard and persists there long after the code has been used,
         whereas support.signin — which is what the page shows the link from —
         goes the moment the device is signed in. Whoever reaches that code
         before the club does pairs the Pi to their own Raspberry Pi ID. */
      message: `Support access is waiting to be finished — open the sign-in link on this page. It ends by itself after ${hours} ${hours === 1 ? 'hour' : 'hours'}`,
    },
  };
}

/** Sign out and switch the client off, then *check* — the dashboard's "End
    support access", the timer when a session has run out, and the reconcile
    when the device turns out to be signed in with no session behind it all
    come through here. The two commands are not taken at their word: if the
    device still reports itself signed in afterwards the club is told so,
    because "we pressed the button" is not the same as "it is off". */
function supportOff(o, action, prev, why, { clearSession = true } = {}) {
  const state = prev || {};
  const name = state.user;
  const user = name ? login(o, name) : null;
  let signedIn = false;
  let installed = false;
  try { installed = supportInstalled(o); } catch { /* assume not */ }
  if (user && installed) {
    // Stop the sign-in first: a pairing completed after this point would sign
    // the card back in behind everyone's back.
    try { userctl(o, user, ['stop', `${SIGNIN_UNIT}.service`]); } catch { /* not running */ }
    try { connect(o, user, ['signout']); } catch { /* perhaps never signed in */ }
    try { connect(o, user, ['off']); } catch { /* already off */ }
    try { signedIn = connectStatus(o, user).signedIn; } catch { /* nothing to ask */ }
    if (signedIn) {
      try { connect(o, user, ['signout']); } catch { /* best effort */ }
      try { signedIn = connectStatus(o, user).signedIn; } catch { signedIn = false; }
    }
    removeSigninLog(o, user);
    /* Linger goes last, and that ordering is the point of this comment:
       disable-linger stops user@<uid>.service, which takes /run/user/<uid> and
       with it the bus every check above talks over. Done first, the checks
       threw, the catch left signedIn false, and this reported a clean "off"
       without having verified anything — in the one function whose whole
       purpose is not taking those two commands at their word. */
    if (state.lingeredByUs) { try { o.exec('loginctl', ['disable-linger', user.name]); } catch { /* best effort */ } }
  }
  // Older cards kept the sign-in output here.
  try { fs.rmSync(file(o, 'remote-access-signin.log'), { force: true }); } catch { /* read-only card */ }
  // Not when a bounded session is being left alone and this was a second
  // client signed in alongside it.
  if (clearSession) { try { writeSession(o, null); } catch { /* tried again next run */ } }
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
function supportExpire(o, { locked = true } = {}) {
  const { session, writtenAtMs } = readSessionRecord(o);
  const bounds = sessionBounds(session, o.now(), writtenAtMs);
  if (session && !bounds.valid) return mirror(o, supportOff(o, 'support-expire', session, bounds.why));
  /* A request the path unit could not pick up, because a helper was already
     running when it fired. PathChanged= only fires again on the next write, so
     without this it would sit there until somebody pressed the button a second
     time; the id/lastRequestId check makes a second look at it harmless. */
  if (locked && fs.existsSync(file(o, 'remote-access-request.json'))) {
    // And nothing about that errand may stop the expiry run finishing.
    try { return handleRequest(o); } catch (err) { o.warn(`could not pick up the pending request: ${err.message}`); }
  }
  return mirror(o, {});
}

/** Update the dashboard's copy of the state, and do not make the caller's
    success depend on it. By the time this is reached the sign-out has already
    happened — it is a few D-Bus calls and an unlink — and support access must
    not carry on being on because a card that has filled up or remounted
    read-only cannot write a status file. */
function mirror(o, extra) {
  try { return status(o, extra); } catch (err) {
    const last = extra.last
      ? { ...extra.last, ok: false, message: `${extra.last.message} (the dashboard’s copy of this could not be written: ${err.message})` }
      : { action: 'status', at: o.now().toISOString(), ok: false, message: `The status file could not be written: ${err.message}` };
    o.warn(last.message);
    return { sshEnabled: false, sshActive: false, users: [], ...extra, last };
  }
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
  const { session } = readSessionRecord(o);
  if (session) return session;
  let lives = [];
  try { lives = supportInstalled(o) ? liveSessions(o, prev.support && prev.support.user) : []; } catch { /* nothing to ask */ }
  const live = lives.find((l) => l.signedIn);
  return live ? { user: live.user.name, lingeredByUs: false } : { user: null };
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
  /* One at a time: the path unit and the expiry timer are separate instances
     of the same template and would otherwise interleave over the same files.
     But the lock is a convenience and the expiry is a promise, so they are not
     allowed to be the same thing. A card that has filled up or remounted
     read-only — which is what a signage Pi that is unplugged rather than shut
     down eventually does, and what the dashboard's own user can cause by
     filling DATA_DIR on the same filesystem — cannot create a lock file at
     all. "Support access stopped expiring because of ENOSPC" is precisely the
     failure this feature must not have, so the expiry goes ahead regardless,
     and only the dashboard's copy of the state is gated on the lock. Status
     and request runs give up instead: both are retried. */
  const release = takeLock(o);
  try {
    if (command === 'support-expire') return supportExpire(o, { locked: Boolean(release) });
    if (!release) throw new Error('Another PitchTribe remote access helper is still running — nothing was changed. Try again in a minute.');
    return command === 'status' ? status(o) : handleRequest(o);
  } finally {
    if (release) release();
  }
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
