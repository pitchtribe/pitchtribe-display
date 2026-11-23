'use strict';
/* The live-scores slide used to shrink its type until a full round of fixtures
   "fit", then clip whatever still did not, so a club that switched on four
   leagues saw the first few matches and never knew the rest were there. It
   scrolls now, and these are the sums behind that: does every row get on screen,
   does the slide ask for long enough to show them, and does it stay bounded so
   one busy Saturday cannot park a rotation on one slide.

   The measuring and the moving need a browser; this arithmetic does not. */
const test = require('node:test');
const assert = require('node:assert/strict');
const PTScroll = require('../public/shared/scroll');

const { plan, offsetAt, MAX_MS, PAUSE_MS } = PTScroll;
// A 15s scores slide (the default duration) on a panel whose type is 34px.
const slide = { em: 34, dwellMs: 15000 };

test('content that fits does not move', () => {
  for (const distance of [0, 1, -20, NaN, undefined]) {
    const p = plan({ ...slide, distance });
    assert.equal(p.scrolls, false, `${distance}px of overflow should not scroll`);
    assert.equal(p.totalMs, 0);
    assert.equal(offsetAt(p, 99999), 0, 'nothing to scroll means nothing moves');
  }
});

test('a list taller than the screen scrolls, and every row gets there', () => {
  const p = plan({ ...slide, distance: 1200 });
  assert.equal(p.scrolls, true);
  // The whole overflow is travelled, not most of it: the last match is the one
  // a clipping bug loses, so it is the one worth asserting on.
  assert.equal(offsetAt(p, p.pauseMs + p.travelMs), 1200);
  assert.equal(offsetAt(p, p.totalMs), 1200, 'and it is still there at the end of the slot');
  // It holds still at the top first, so a reader catches up before it moves.
  assert.equal(offsetAt(p, 0), 0);
  assert.equal(offsetAt(p, p.pauseMs), 0);
  assert.ok(offsetAt(p, p.pauseMs + 1) > 0, 'then it starts');
  assert.ok(offsetAt(p, p.pauseMs + p.travelMs / 2) < 1200, 'and gets there gradually');
});

test('the slide asks for the time the scroll needs', () => {
  const short = plan({ em: 34, dwellMs: 5000, distance: 2000 });
  assert.ok(short.totalMs > 5000, `a 5s slot is not enough for 2000px, got ${short.totalMs}ms`);
  // Pause at each end plus the crawl, which is distance ÷ (em × ems-per-second).
  const crawlMs = (2000 / (34 * PTScroll.EMS_PER_SEC)) * 1000;
  assert.ok(Math.abs(short.totalMs - (PAUSE_MS * 2 + crawlMs)) < 2, `expected ~${Math.round(PAUSE_MS * 2 + crawlMs)}ms, got ${short.totalMs}ms`);
});

test('a slide never gets less than the slot the playlist gave it', () => {
  // A little overflow on a long slide: the scroll must not cut the slide short.
  const p = plan({ em: 34, dwellMs: 40000, distance: 60 });
  assert.equal(p.totalMs, 40000);
  // Nor stretch into a crawl too slow to notice — it finishes, then rests.
  assert.ok(p.travelMs < 40000 - PAUSE_MS * 2, 'a generous slot should not be filled with imperceptible motion');
  assert.equal(offsetAt(p, p.pauseMs + p.travelMs), 60);
});

test('one enormous feed cannot park the rotation', () => {
  const p = plan({ em: 34, dwellMs: 15000, distance: 100000 });
  assert.equal(p.totalMs, MAX_MS, 'the ask is capped');
  // Capped on time, so it goes faster rather than leaving rows unseen.
  assert.equal(offsetAt(p, p.pauseMs + p.travelMs), 100000);
  assert.ok(p.pauseMs + p.travelMs <= MAX_MS, 'and still finishes inside the slot it asked for');
});

test('the pace is set in the panel\'s own type size, not in pixels', () => {
  // The same list on a bigger panel is bigger in both directions, so the reading
  // time should come out the same: that is what makes one speed work on any TV.
  const small = plan({ em: 20, dwellMs: 1, distance: 1000 });
  const big = plan({ em: 40, dwellMs: 1, distance: 2000 });
  assert.equal(small.totalMs, big.totalMs);
});

test('offsetAt is clamped at both ends', () => {
  const p = plan({ ...slide, distance: 500 });
  assert.equal(offsetAt(p, -5000), 0, 'never above the top');
  assert.equal(offsetAt(p, 10 ** 9), 500, 'never below the bottom');
  assert.equal(offsetAt(null, 1000), 0, 'and survives being asked without a plan');
});
