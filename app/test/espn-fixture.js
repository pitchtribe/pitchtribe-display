'use strict';
// The ESPN scoreboard fixture, moved to wherever "now" is.
//
// The engine trims every league to `daysBack`/`daysAhead` around the current clock, so a
// fixture pinned to fixed dates quietly falls out of the window as the real days pass and
// the suite starts failing on a Thursday for no reason anybody changed. This fixture was
// written around its live match (2026-11-03T20:00Z); shifting every date by the same
// amount keeps the shape of a real scoreboard — one finished, one in play, one postponed,
// one to come — and keeps it inside the window forever.
//
// `signage-server/test/server.test.js` does the same thing for the same reason.
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = path.join(__dirname, '..', '..', 'signage-server', 'test', 'fixtures', 'espn-eng1.json');
const LIVE_MATCH = '2026-11-03T20:00Z';

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

function espnFixtureAroundNow(now = Date.now()) {
  const delta = now - Date.parse(LIVE_MATCH);
  const shift = (iso) => new Date(Date.parse(iso) + delta).toISOString().replace('.000Z', 'Z');
  return {
    ...fixture,
    events: fixture.events.map((ev) => ({
      ...ev,
      date: shift(ev.date),
      competitions: (ev.competitions ?? []).map((c) => (c.date ? { ...c, date: shift(c.date) } : c)),
    })),
  };
}

module.exports = { espnFixtureAroundNow };
