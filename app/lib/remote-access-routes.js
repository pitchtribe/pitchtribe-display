'use strict';
/* Settings → Remote access: switch SSH on or off and choose its login, and
   switch PitchTribe support access (Raspberry Pi Connect) on or off.

   The root helper (bin/remote-access.js) does the work; this server writes
   remote-access-request.json for it and reads remote-access-status.json back.
   Either one gives somebody a shell on the Pi, so both need the dashboard
   password again, and the SSH password is hashed here (SHA-512 crypt, via
   openssl): the plain password is never written to disk.

   remote-access-status.json is a mirror the helper writes for this server to
   read, and nothing here decides anything: how long a support session lasts
   is bounded by the helper, from a record in root's own directory that this
   user cannot write. The hours check below is for a useful error message, not
   for safety — the helper checks again, and so does the expiry timer.

   That mirror is 0640 root:pitchtribe-dashboard, a group whose only member is
   this server's own user, because while a support sign-in is waiting to be
   finished it holds the Raspberry Pi Connect verification code — and whoever
   opens that link first is who the Pi gets added to. So this is the only
   process on the card that may read it, and it stops holding the code as soon
   as the device is signed in. */
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const v = require('./validate');
const { USERNAME_RE, RESERVED, HASH_RE, SUPPORT_HOURS, SUPPORT_HOURS_DEFAULT } = require('../bin/remote-access');

const MIN_PASSWORD = 10;

function mountRemoteAccessRoutes({ api, dataDir, adminHash, limiter, hashPassword }) {
  hashPassword = hashPassword || sha512crypt;
  const statusFile = path.join(dataDir, 'remote-access-status.json');
  const requestFile = path.join(dataDir, 'remote-access-request.json');
  const status = () => { try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { return null; } };

  api.get('/remote-access', (req, res) => {
    const s = status();
    res.set('Cache-Control', 'no-store').json({
      available: Boolean(s),
      supportHours: SUPPORT_HOURS,
      supportHoursDefault: SUPPORT_HOURS_DEFAULT,
      status: s && {
        sshEnabled: Boolean(s.sshEnabled),
        sshActive: Boolean(s.sshActive),
        users: s.users || [],
        username: s.username || null,
        last: s.last || null,
        lastRequestId: s.lastRequestId || null,
        support: supportView(s.support),
      },
    });
  });

  api.post('/remote-access', (req, res, next) => {
    try {
      const b = req.body || {};
      if (!status()) throw new v.HttpError(503, 'Remote access can only be switched on from a Raspberry Pi running PitchTribe');
      if (limiter.blocked(req.ip)) throw new v.HttpError(429, 'Too many attempts — wait 15 minutes and try again');
      if (!auth.verifyPassword(String(b.currentPassword || ''), adminHash())) {
        limiter.fail(req.ip);
        throw new v.HttpError(403, 'Your dashboard password isn’t right');
      }
      limiter.reset(req.ip);

      // A support block asks about Raspberry Pi Connect and nothing else: the
      // SSH fields are left exactly as they were, so one is never a way of
      // quietly changing the other.
      if (b.support && typeof b.support === 'object') {
        const want = Boolean(b.support.enabled);
        let support;
        if (want) {
          const hours = b.support.hours === undefined ? SUPPORT_HOURS_DEFAULT : Number(b.support.hours);
          if (!SUPPORT_HOURS.includes(hours)) {
            throw v.bad(`Choose how long support access should last: ${SUPPORT_HOURS.join(', ')} hours`);
          }
          support = { action: 'support-enable', hours };
        } else {
          support = { action: 'support-disable' };
        }
        return res.json({ requestId: write(support) });
      }

      let body;
      if (b.enabled) {
        const username = String(b.username || '').trim();
        if (!USERNAME_RE.test(username) || RESERVED.has(username)) {
          throw v.bad('Choose a username of small letters, numbers and hyphens, starting with a letter (for example “clubadmin”)');
        }
        const password = String(b.password || '');
        if (password.length < MIN_PASSWORD) throw v.bad(`Choose an SSH password of at least ${MIN_PASSWORD} characters`);
        const passwordHash = hashPassword(password);
        if (!HASH_RE.test(passwordHash)) throw new v.HttpError(500, 'The password could not be prepared');
        body = { action: 'enable', username, passwordHash };
      } else {
        body = { action: 'disable' };
      }
      res.json({ requestId: write(body) });
    } catch (err) {
      next(err);
    }
  });

  /** Hand one request to the root helper. 0600, because an SSH request holds a
      password hash — and only ever one at a time, which is what gives the
      helper its id/lastRequestId idempotency. */
  function write(body) {
    const id = crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(`${requestFile}.tmp`, `${JSON.stringify({ id, at: new Date().toISOString(), ...body })}\n`, { mode: 0o600 });
    fs.renameSync(`${requestFile}.tmp`, requestFile);
    return id;
  }
}

/** The support block as the dashboard sees it: state, the sign-in link to
    finish at, when it runs out, and when support was last connected. */
function supportView(s) {
  const d = s || {};
  return {
    installed: Boolean(d.installed),
    enabled: Boolean(d.enabled),
    signedIn: Boolean(d.signedIn),
    connected: Number(d.shellSessions || 0) > 0,
    user: d.user || null,
    hours: d.hours || null,
    expiresAt: d.expiresAt || null,
    lastConnection: d.lastConnection || null,
    signin: d.signin ? { url: d.signin.url, code: d.signin.code, at: d.signin.at || null } : null,
  };
}

/** SHA-512 crypt ($6$) hash, as /etc/shadow stores it. */
function sha512crypt(password) {
  return childProcess.execFileSync('openssl', ['passwd', '-6', '-stdin'], { input: password, encoding: 'utf8' }).trim();
}

module.exports = { mountRemoteAccessRoutes, MIN_PASSWORD };
