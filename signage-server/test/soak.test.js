// Seven days, simulated.
//
// One of the brief's "done" criteria is seven days unattended on a test television. That
// needs a television, a card and a week, and none of those can be had from here. What can
// be had is the half that actually goes wrong in software: the loop is a pure function of
// the clock, so the clock can be run forward a week in a second and every page it would
// have shown can be checked.
//
// This is not the unattended soak. It cannot see a corrupted SD card, a browser that
// leaks over six days, a router that drops at 3am or a screen left on during a committee
// meeting because somebody typed the hours in wrong. It does prove that the pages
// themselves stay honest for a week with nobody touching anything and no new data
// arriving — including the part that matters most on day seven, which is that a result
// from last Saturday stops being shown rather than starting to read as this week's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import {
  buildClubhouse, zoneParts, isOpen, longDate, countdownWords, daysToSaturday, DAY_KEYS,
} from '../src/clubhouse.js';
import { renderClubhouse } from '../src/clubhouse-render.js';
import { measurePage, BASELINE } from '../src/legibility.js';
import { buildFixtureWall } from '../scripts/wall-fixture.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
const STEP = 15 * MINUTE; // 672 steps over the week
const POOL = Array.from({ length: 40 }, (_, i) => `photo-${String(i).padStart(3, '0')}.jpg`);

/** The config and the frozen snapshot: the week runs with no new data on purpose. */
const fixture = await buildFixtureWall();
const config = fixture.config;
const tz = config.timezone;
const hours = config.clubhouse.openingHours;
const store = new Store({ ...config }, { log: () => {} });
await store.refresh();
const snapshot = store.snapshot();
const start = fixture.now;

/**
 * Opening hours worked out a second way, deliberately naively, as a cross-check on the
 * one the card ships. No midnight-crossing logic here — the example hours never do —
 * so if the two ever disagree, one of them is wrong.
 */
function openByHand(date) {
  const { weekday, minutes } = zoneParts(date, tz);
  const windows = hours[DAY_KEYS[weekday]] ?? [];
  return windows.some(([from, to]) => {
    const [fh, fm] = from.split(':').map(Number);
    const [th, tm] = to.split(':').map(Number);
    return minutes >= fh * 60 + fm && minutes < th * 60 + tm;
  });
}

const walk = (fn) => {
  for (let t = 0; t <= 7 * DAY; t += STEP) fn(new Date(start.getTime() + t));
};

test('seven days of pages, and not one of them throws or shows a hole', () => {
  let steps = 0;
  walk((now) => {
    const wall = buildClubhouse(snapshot, config, { now, photoFiles: POOL });
    const html = renderClubhouse(wall, { live: false });
    steps += 1;
    assert.ok(wall.slides.length >= 1, 'a wall with no slides at all');
    // Never a blank screen, and never a hole where data should be.
    for (const hole of ['undefined', 'NaN', 'Invalid Date', 'null–null']) {
      assert.ok(!html.includes(hole), `"${hole}" reached the wall at ${now.toISOString()}`);
    }
    assert.ok(html.length < 400_000, `page grew to ${html.length} bytes`);
  });
  assert.equal(steps, 673);
});

test('a result stops being shown rather than starting to read as this week\'s', () => {
  // Trust rule 1, tested over time instead of at an instant. Every result on screen must
  // carry a date inside the nine-day window, on every one of the 673 pages.
  walk((now) => {
    const wall = buildClubhouse(snapshot, config, { now, photoFiles: POOL });
    // Nine days back for a result, and nine days either side for a called-off match,
    // because "next Saturday is off" is worth a slide and last March is not.
    const label = (d) => longDate(new Date(now.getTime() + d * DAY), tz);
    const played = new Set(Array.from({ length: 10 }, (_, d) => label(-d)));
    const calledOff = new Set(Array.from({ length: 19 }, (_, d) => label(d - 9)));
    for (const slide of wall.slides) {
      if (!['result', 'awaiting', 'calledoff'].includes(slide.kind)) continue;
      assert.ok(slide.date, `a ${slide.kind} slide with no date at ${now.toISOString()}`);
      const allowed = slide.kind === 'calledoff' ? calledOff : played;
      assert.ok(allowed.has(slide.date),
        `${slide.kind} dated "${slide.date}" still on screen at ${now.toISOString()}`);
    }
  });
});

test('by the end of a week with no new data the heartbeat goes quiet, not stale', () => {
  const dayOne = buildClubhouse(snapshot, config, { now: start, photoFiles: POOL });
  const dayEight = buildClubhouse(snapshot, config, {
    now: new Date(start.getTime() + 7 * DAY), photoFiles: POOL,
  });
  const results = (w) => w.slides.filter((s) => s.kind === 'result').length;
  assert.ok(results(dayOne) >= 1, 'the fixture week should open with a result');
  assert.ok(results(dayEight) < results(dayOne),
    'last Saturday\'s results were still on screen eight days later');
  // And the screen is still worth looking at: the club's own name, the table, the
  // countdown and the photographs do not depend on the league publishing anything.
  const kinds = new Set(dayEight.slides.map((s) => s.kind));
  for (const kind of ['identity', 'countdown', 'photo', 'table']) {
    assert.ok(kinds.has(kind), `nothing left to show on day eight: no ${kind}`);
  }
});

test('the blackout keeps the week\'s schedule, and two implementations agree', () => {
  let open = 0;
  let closed = 0;
  const transitions = [];
  let last = null;
  walk((now) => {
    const shipped = isOpen(hours, now, tz);
    assert.equal(shipped, openByHand(now), `hours disagree at ${now.toISOString()}`);
    if (last !== null && shipped !== last) transitions.push({ now, to: shipped });
    last = shipped;
    if (shipped) open += 1; else closed += 1;
  });
  // A clubhouse screen is off most of the week, which is the point: a screen that lights
  // up during a committee meeting is how installations get unplugged.
  assert.ok(closed > open, 'the card was lit for more of the week than it was dark');
  // Five configured open days in the example week, so ten edges either side of them.
  assert.equal(transitions.length, 10, `expected ten edges in the week, saw ${transitions.length}`);
  // Nothing lit on the two closed days.
  walk((now) => {
    const { weekday } = zoneParts(now, tz);
    if (DAY_KEYS[weekday] === 'mon' || DAY_KEYS[weekday] === 'wed') {
      assert.equal(isOpen(hours, now, tz), false, `lit on a closed day at ${now.toISOString()}`);
    }
  });
});

test('the countdown changes face every day because the date does', () => {
  const faces = new Set();
  for (let d = 0; d < 7; d += 1) {
    const now = new Date(start.getTime() + d * DAY);
    const wall = buildClubhouse(snapshot, config, { now, photoFiles: POOL });
    const slide = wall.slides.find((s) => s.kind === 'countdown');
    const expected = countdownWords(daysToSaturday(now, tz));
    assert.deepEqual({ lead: slide.lead, tail: slide.tail }, expected);
    faces.add(`${slide.lead} ${slide.tail}`);
  }
  assert.equal(faces.size, 7, 'two days of the week showed the same countdown');
});

test('the Wednesday test: a week of walls, each day\'s photographs its own', () => {
  const byDay = new Map();
  walk((now) => {
    const key = zoneParts(now, tz).dateKey;
    const wall = buildClubhouse(snapshot, config, { now, photoFiles: POOL });
    const photos = wall.slides.filter((s) => s.kind === 'photo').map((s) => s.file).join(',');
    if (byDay.has(key)) {
      // Same day, same wall: the loop must not reshuffle under the room's feet.
      assert.equal(byDay.get(key), photos, `the photographs changed during ${key}`);
    } else {
      byDay.set(key, photos);
    }
  });
  assert.equal(byDay.size, 8, 'the walk should cover eight local days');
  const days = [...byDay.values()];
  assert.equal(new Set(days).size, days.length, 'two days of the week showed the same photographs');
  for (const photos of days) assert.equal(photos.split(',').length, 12, 'not a dozen photographs');
});

test('the six-metre test holds every day of the week, not just on the full page', () => {
  // The loop's shape changes through the week as results drop out, so the page that gets
  // measured on Sunday is not the page the room sees on Thursday.
  for (let d = 0; d < 8; d += 1) {
    const now = new Date(start.getTime() + d * DAY);
    const wall = buildClubhouse(snapshot, config, { now, photoFiles: POOL });
    const html = renderClubhouse(wall, { live: false });
    const report = measurePage(html, BASELINE);
    assert.deepEqual(report.failures, [],
      `day ${d}: ${report.failures.map((f) => `${f.kind}/${f.selector}`).join(', ')}`);
  }
});
