'use strict';
/* What `/healthz` tells a monitor that cannot get onto the card.

   A club's Pi lives somewhere nobody looks — a bar ceiling, a locked office —
   so by the time a volunteer phones, the screens have been black for a week.
   Watching the port only proves the kernel is alive, and the failures that
   actually take a club off the air are quieter than that: the card fills up
   with uploaded videos, the nightly OS update has been failing since the
   summer, or the service is crash-looping and answering between restarts.

   So this reports the few numbers that come *before* those outages, and no
   more. `/healthz` is the one route served without a login (app.js says why),
   which means everything here has to be safe for anyone on the club's LAN to
   read: counts and percentages, never a club name, a screen name, a file path,
   or the apt output in the OS-update message.

   Two deliberate non-decisions:

   - The response stays 200 and `ok` stays true whatever the numbers say.
     deploy/kiosk.sh waits for `curl -fsS .../healthz` before it starts the
     browser, so failing this route when the card is nearly full would stop
     every screen in the club from booting — turning a warning into exactly the
     outage it was meant to prevent. Degradation goes in `status` and
     `warnings`, where only a monitor looks.

   - Screens and load are counted, not judged. Clubs switch screens off at the
     wall overnight and over the summer, so "2 of 4 online" is not a fault here;
     what is normal for a given club is the watcher's business, not the Pi's.
     `warnings` is kept for the three things that are a fault anywhere, so that
     a warning stays worth waking up for. */
const fs = require('node:fs');
const os = require('node:os');

/** Card nearly full: the next video upload or nightly backup is what fails. */
const DISK_WARN_PERCENT = 90;
/** Nothing left to allocate; on a Pi this ends with the OOM killer taking the service. */
const MEMORY_WARN_PERCENT = 90;
/** How long a computed view is reused. See the note in createHealth. */
const CACHE_MS = 5000;

const pct = (part, whole) => Math.round((part / whole) * 1000) / 10;

/**
 * Space on the filesystem holding the club's data, or null if it can't be read.
 *
 * `bavail` (free to us) rather than `bfree` (free including the reserve only
 * root may use), so the percentage matches what the dashboard can actually
 * write — a card reading 100% here still has the root reserve left, which is
 * why the app fails to save long before `df` looks full.
 */
function diskView(dir, statfs) {
  try {
    const { bsize, blocks, bavail } = statfs(dir);
    const totalBytes = bsize * blocks;
    if (!totalBytes) return null;
    const freeBytes = bsize * bavail;
    return { freeBytes, totalBytes, usedPercent: pct(totalBytes - freeBytes, totalBytes) };
  } catch {
    // Not Linux, or a sandbox without statfs: say nothing rather than guess,
    // the same choice backup-routes.js makes about headroom.
    return null;
  }
}

/**
 * Memory, as "could the Pi still allocate?" and not "is the RAM empty?".
 *
 * On Linux `os.freemem()` is MemAvailable, not MemFree, so the page cache is
 * counted as available — which is the only reason this number is meaningful.
 * MemFree on a Pi that has been up a fortnight is nearly zero because the
 * kernel has cached the media files, and a warning built on it would fire every
 * day on perfectly healthy cards.
 */
function memoryView() {
  const totalBytes = os.totalmem();
  const availableBytes = os.freemem();
  if (!totalBytes) return null;
  return { availableBytes, totalBytes, usedPercent: pct(totalBytes - availableBytes, totalBytes) };
}

/**
 * Uptime of the Pi and of this process.
 *
 * Both, because the gap is the tell: a card that answers every probe while
 * systemd restarts the service every forty seconds looks perfectly healthy
 * until you notice `app` never grows while `host` does.
 */
function uptimeView() {
  return { hostSeconds: Math.round(os.uptime()), appSeconds: Math.round(process.uptime()) };
}

/** The nightly OS update, reduced to what is safe to serve without a login. */
function osUpdateView(osUpdate) {
  const u = osUpdate();
  if (!u || !u.available) return { available: false };
  // Deliberately not `packages` or `message`: both carry apt's own text, which
  // names the exact versions installed on the card. That belongs on the
  // dashboard behind the login, not on an open route.
  return {
    available: true,
    level: u.level,
    result: u.result,
    rebootRequired: u.rebootRequired,
    daysSinceCheck: u.daysSinceCheck,
    daysSincePatched: u.daysSincePatched,
    unpatched: u.unpatched,
    silent: u.silent,
  };
}

/**
 * Builds the `/healthz` body.
 *
 * Cached for a few seconds because this route takes no login, kiosk.sh polls it
 * in a loop while a screen boots, and a watcher hits it on a timer. One statfs
 * and one small JSON read per request is cheap but not free on a Pi, and an
 * open route that does filesystem work on demand is worth bounding whatever the
 * cost looks like today.
 *
 * @param {object} o
 * @param {string} o.version           app version, reported as-is
 * @param {string} o.dataDir           the club's data directory, for free space
 * @param {() => {total: number, online: number}} o.screens
 * @param {() => object} o.osUpdate    osUpdateView() from os-update.js
 * @param {number} [o.cacheMs]         0 to recompute on every call (tests)
 * @param {Function} [o.statfs]        fs.statfsSync, swapped out to test a full card
 * @returns {() => object} the body, ready to send
 */
function createHealth({ version, dataDir, screens, osUpdate, cacheMs = CACHE_MS, now = Date.now, statfs = fs.statfsSync }) {
  let cached = null;
  let cachedAt = 0;

  return function health() {
    const at = now();
    if (cached && at - cachedAt < cacheMs) return cached;

    const disk = diskView(dataDir, statfs);
    const memory = memoryView();
    const osUpdates = osUpdateView(osUpdate);

    const warnings = [];
    if (disk && disk.usedPercent >= DISK_WARN_PERCENT) warnings.push('disk-low');
    if (memory && memory.usedPercent >= MEMORY_WARN_PERCENT) warnings.push('memory-low');
    // `unpatched` already means "the runs happen and none of them works" — the
    // one OS-update failure that looks like success from the outside.
    if (osUpdates.available && (osUpdates.unpatched || osUpdates.silent)) warnings.push('os-unpatched');

    cached = {
      // `ok` and `version` first and unchanged: kiosk.sh and the older probes
      // only read these two, and this route has to stay a liveness check.
      ok: true,
      version,
      status: warnings.length ? 'warn' : 'ok',
      warnings,
      uptime: uptimeView(),
      disk,
      memory,
      load: {
        oneMinute: Math.round(os.loadavg()[0] * 100) / 100,
        cpus: os.cpus().length,
      },
      screens: screens(),
      osUpdate: osUpdates,
    };
    cachedAt = at;
    return cached;
  };
}

module.exports = { createHealth, DISK_WARN_PERCENT, MEMORY_WARN_PERCENT, CACHE_MS };
