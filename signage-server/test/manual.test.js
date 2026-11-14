// The manual source: a club's own results typed into a JSON file, which is what a
// grassroots install actually runs on. The status cell is the risky field — it decides
// whether a published score is shown, so reading it wrong presents a finished match as a
// fixture still to be played, or a fixture as a 0–0 result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchManual, normalizeStatus, CORE_STATUSES } from '../src/sources/manual.js';

const here = dirname(fileURLToPath(import.meta.url));
const league = { key: 'club', name: 'Our Club', file: resolve(here, 'fixtures/manual-club.json') };

test('a whole phrase in the status cell is read, not dropped to "scheduled"', async () => {
  const { events } = await fetchManual(league);
  const byId = Object.fromEntries(events.map((e) => [e.id.replace('club:', ''), e]));

  // The regression. "Postponed — pitch unplayable" matched no exact lowercase word, so it
  // fell through to `scheduled` — a called-off match shown as a fixture still to be
  // played, with the league's explanation discarded.
  assert.equal(byId.off.status, 'postponed');
  assert.equal(byId.off.statusText, 'Postponed — pitch unplayable', "the league's own words, kept as written");

  // Case alone used to be enough: "Final" is not "final".
  assert.equal(byId.won.status, 'final');
  assert.deepEqual([byId.won.home.score, byId.won.away.score], [1, 3]);
  assert.equal(byId.won.statusText, 'FT');

  // Played, no score published yet. Not a fifth status and not an invented 0–0: it sorts
  // as a fixture and says why.
  assert.equal(byId.awaiting.status, 'scheduled');
  assert.equal(byId.awaiting.awaitingResult, true);
  assert.equal(byId.awaiting.statusText, 'Played — result to follow', 'a phrase is kept, not replaced by our caption');
  assert.equal(byId.awaiting.home.score, null);

  // A phrase can mention more than one of the four; the one that says something happened
  // to the match wins over a bare "fixture".
  assert.equal(byId.walkover.status, 'final');
  assert.equal(byId.walkover.statusText, 'Walkover awarded to Our Club');

  // Wording we have never seen, with a score beside it: the score was published, so it is
  // a result, and the league's words are shown rather than guessed at.
  assert.equal(byId.mystery.status, 'final');
  assert.equal(byId.mystery.statusText, 'Unavoidable clash');
  assert.deepEqual([byId.mystery.home.score, byId.mystery.away.score], [2, 2]);

  // The four exact words a file may already contain keep working.
  assert.equal(byId.playing.status, 'live');
});

test('a fixture carries no score, and no event carries a fifth status', async () => {
  const { events } = await fetchManual(league);

  // A pre-match 0–0 in the file is not a result. Shown beside a fixture it reads as one.
  const fixture = events.find((e) => e.id === 'club:fixture');
  assert.equal(fixture.status, 'scheduled');
  assert.deepEqual([fixture.home.score, fixture.away.score], [null, null]);

  for (const e of events) {
    assert.ok(CORE_STATUSES.has(e.status), `${e.id}: "${e.status}" is not one of the four display statuses`);
    if (e.status === 'scheduled') {
      assert.deepEqual([e.home.score, e.away.score], [null, null], `${e.id}: a fixture is showing a score`);
    }
  }
});

test('normalizeStatus maps the words and phrases a league actually writes', () => {
  const status = (raw, scores) => normalizeStatus(raw, scores).status;

  assert.equal(status('Postponed — pitch unplayable'), 'postponed');
  assert.equal(status('Abandoned 70 mins — floodlight failure'), 'postponed');
  assert.equal(status('Match called off, pitch frozen'), 'postponed');
  assert.equal(status('Fixture postponed'), 'postponed', 'postponed beats a bare "fixture"');
  assert.equal(status('FULL-TIME', { homeScore: 2, awayScore: 0 }), 'final');
  assert.equal(status('in-progress'), 'live');
  assert.equal(status('TBC'), 'scheduled');
  assert.equal(status(''), 'scheduled', 'an empty cell is a fixture');
  assert.equal(status(undefined), 'scheduled');

  // Whole words only: "void" is a status, "avoided" is not.
  assert.equal(status('Match void by committee'), 'postponed');
  assert.equal(normalizeStatus('Relegation avoided').unknown, true);

  // A "final" with nothing to show is a result we don't have, not a 0–0.
  assert.deepEqual(normalizeStatus('final'), {
    status: 'scheduled', statusText: 'Result to follow', awaitingResult: true, unknown: false,
  });
  assert.deepEqual(normalizeStatus('final', { homeScore: 0, awayScore: 0 }), {
    status: 'final', statusText: 'FT', awaitingResult: false, unknown: false,
  });

  // The league's own wording is never overwritten when the file supplies it.
  assert.equal(normalizeStatus('postponed', { statusText: 'Off — frozen pitch' }).statusText, 'Off — frozen pitch');
});
