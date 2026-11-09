'use strict';
/* What the nightly Raspberry Pi OS update did, for Settings → About.

   deploy/update/os-update.sh patches the card when PitchTribe is installed and
   then every night in front of the backup, and writes what happened to
   DATA_DIR/os-update-status.json:

     { checkedAt, lastOkAt, result: ok|offline|error, upgraded,
       packages[], rebootRequired, message }

   The helper writes it as root; this only ever reads it. Nobody at a club opens
   a terminal, so the dashboard is the only place a volunteer ever learns that
   the Pi is patched — or that it stopped being patched three weeks ago.

   Two judgements are made here rather than in the shell, because they are about
   today's date and not about the night the file describes:

     silent     nothing has written the file for days. The Pi has been switched
                off (a clubhouse on a timer switch catches up on the next night
                it is on), or the nightly unit is broken. One missed night is a
                coincidence; a week of them is worth a line on the screen.
     unpatched  the runs happen and none of them works — a Pi behind a captive
                guest network, or an archive it cannot reach. This is the one
                failure that looks like success from the outside: `checkedAt`
                moves every night and nothing is ever installed. */
const fs = require('node:fs');
const path = require('node:path');

const DAY = 86400 * 1000;
/** Nightly, so two missed nights is the broadband; five is the Pi. */
const SILENT_DAYS = 5;
/** `offline` for a fortnight is a card that has stopped getting security fixes. */
const UNPATCHED_DAYS = 14;
/* The helper already takes the quotes and newlines out of apt's messages; these
   bound what a status file can put on the dashboard whatever it holds. */
const MAX_MESSAGE = 200;
const MAX_PACKAGES = 40;
const MAX_PACKAGE_NAME = 80;

const RESULTS = ['ok', 'offline', 'error'];

const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '');
const time = (x) => {
  const t = Date.parse(str(x, 40));
  return Number.isFinite(t) ? t : null;
};
const daysSince = (at, now) => (at === null ? null : Math.max(0, Math.floor((now - at) / DAY)));
const iso = (t) => (t === null ? null : new Date(t).toISOString());

/** The status file as the dashboard needs it, or `{ available: false }`. */
function osUpdateView(dataDir, now = Date.now()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'os-update-status.json'), 'utf8'));
  } catch {
    // No file, or half a file: a dashboard that isn't running on a Pi, or a
    // card whose first nightly run hasn't come round yet. Nothing to report,
    // and nothing to worry anyone with.
    return { available: false };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { available: false };

  const checkedAt = time(raw.checkedAt);
  const result = RESULTS.includes(raw.result) ? raw.result : 'error';
  const upgraded = Number.isInteger(raw.upgraded) && raw.upgraded >= 0 ? raw.upgraded : 0;
  const packages = Array.isArray(raw.packages)
    ? raw.packages.filter((p) => typeof p === 'string' && p).slice(0, MAX_PACKAGES).map((p) => p.slice(0, MAX_PACKAGE_NAME))
    : [];
  /* The last night that *worked*, carried forward by the helper. `result` only
     says how last night went, and a Pi can spend a month reporting `offline`
     every morning without anyone noticing nothing was installed. */
  const lastOkAt = result === 'ok' ? checkedAt : time(raw.lastOkAt);
  const daysSinceCheck = daysSince(checkedAt, now);
  const daysSincePatched = daysSince(lastOkAt, now);
  const silent = daysSinceCheck !== null && daysSinceCheck >= SILENT_DAYS;
  const unpatched = result !== 'ok' && (daysSincePatched === null || daysSincePatched >= UNPATCHED_DAYS);
  const rebootRequired = raw.rebootRequired === true;

  return {
    available: true,
    checkedAt: iso(checkedAt),
    lastOkAt: iso(lastOkAt),
    result,
    upgraded,
    packages,
    rebootRequired,
    message: str(raw.message, MAX_MESSAGE),
    daysSinceCheck,
    daysSincePatched,
    silent,
    unpatched,
    /* How loudly to say it: `warn` is something that has stopped working, `due`
       is something waiting for a person — a restart most of all, because the
       helper deliberately never restarts a screen by itself. */
    level: silent || unpatched || result === 'error' ? 'warn' : rebootRequired || result === 'offline' ? 'due' : 'ok',
  };
}

module.exports = { osUpdateView, SILENT_DAYS, UNPATCHED_DAYS };
