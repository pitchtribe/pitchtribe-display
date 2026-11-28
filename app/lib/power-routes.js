'use strict';
/* Settings → Power: reboot or shutdown the Pi from the dashboard.

   The root helper (bin/power.js) does the work; this server writes
   power-request.json for it and reads power-status.json back.
   Both operations shut down the Pi, so they need the dashboard password again.

   power-status.json is a mirror the helper writes for this server to read,
   recording the last action taken. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const v = require('./validate');

function mountPowerRoutes({ api, dataDir, adminHash, limiter }) {
  const statusFile = path.join(dataDir, 'power-status.json');
  const requestFile = path.join(dataDir, 'power-request.json');

  /* Why the mirror could not be read matters. Missing means there is no root
     helper on this machine (a laptop, container, dev box). Unreadable means
     the helper is there but the file cannot be accessed. */
  function status() {
    try {
      return { s: JSON.parse(fs.readFileSync(statusFile, 'utf8')) };
    } catch (err) {
      return { s: null, code: err.code };
    }
  }

  const unavailable = (code) => (code === 'EACCES' || code === 'EPERM'
    ? 'Power controls are set up but this dashboard cannot read their state — re-run the PitchTribe installer on this Pi to repair it'
    : 'Power controls can only be used from a Raspberry Pi running PitchTribe');

  api.get('/power', (req, res) => {
    const { s, code } = status();
    res.set('Cache-Control', 'no-store').json({
      available: Boolean(s),
      unavailableReason: s ? null : unavailable(code),
      status: s && {
        last: s.last || null,
        lastRequestId: s.lastRequestId || null,
      },
    });
  });

  api.post('/power', (req, res, next) => {
    try {
      const b = req.body || {};
      const { s, code } = status();
      if (!s) throw new v.HttpError(503, unavailable(code));
      if (limiter.blocked(req.ip)) {
        throw new v.HttpError(429, 'Too many attempts — wait 15 minutes and try again');
      }
      if (!auth.verifyPassword(String(b.currentPassword || ''), adminHash(req))) {
        limiter.fail(req.ip);
        throw new v.HttpError(403, 'Your dashboard password isn\'t right');
      }
      limiter.reset(req.ip);

      const action = String(b.action || '').trim();
      if (action !== 'reboot' && action !== 'shutdown') {
        throw v.bad('Action must be "reboot" or "shutdown"');
      }

      res.json({ requestId: write({ action }) });
    } catch (err) {
      next(err);
    }
  });

  /** Hand one request to the root helper. 0600 for security, and only one at a
      time, which gives the helper its id/lastRequestId idempotency. */
  function write(body) {
    const id = crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(`${requestFile}.tmp`, `${JSON.stringify({ id, at: new Date().toISOString(), ...body })}\n`, { mode: 0o600 });
    fs.renameSync(`${requestFile}.tmp`, requestFile);
    return id;
  }
}

module.exports = { mountPowerRoutes };
