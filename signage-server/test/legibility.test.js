// The six-metre test as a test.
//
// The brief asks for this one photographed rather than asserted, and a photograph needs a
// television. What can be checked here is the half a photograph would show first: whether
// the type on the real page is big enough for the room. If this file fails, somebody has
// made the wall harder to read from six metres and the photograph would have caught it in
// week three instead of on this commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  measurePage, verticalBudget, arcminutes, minDiagonalInches, maxDistanceMetres,
  capHeightMm, screenHeightMm, styleSizes, BASELINE, GLANCE_ARCMIN, LEGIBLE_ARCMIN,
  ROLES, EXCEPTIONS,
} from '../src/legibility.js';
import { buildFixtureWall } from '../scripts/wall-fixture.js';

const wall = await buildFixtureWall({ photoFiles: ['one.jpg', 'two.jpg'] });

test('the arithmetic agrees with the trade rule it comes from', () => {
  // One inch of letter height per ten feet of distance is the familiar signage rule for
  // comfortable reading. If this file's maths is right, that lands near 29 arcminutes.
  const inchCapOnBaseline = 25.4 / (BASELINE.diagonalInches * 25.4 * 0.49029 * 0.70 / 100);
  const arc = arcminutes(inchCapOnBaseline, { diagonalInches: BASELINE.diagonalInches, distanceMetres: 3.048 });
  assert.ok(arc > 28 && arc < 29.5, `one inch at ten feet should be about 28.6', got ${arc.toFixed(1)}'`);

  // A 16:9 43-inch screen is 535mm tall, so 1vh is 5.35mm and cap height 0.7 of that.
  assert.ok(Math.abs(screenHeightMm(43) - 535) < 2);
  assert.ok(Math.abs(capHeightMm(10, 43) - 37.5) < 0.5);
});

test('screen size and viewing distance are two ways of saying the same thing', () => {
  // Whatever screen a size needs at six metres, standing at six metres in front of that
  // screen must be exactly the limit of the glance tier.
  const needed = minDiagonalInches(8, { distanceMetres: 6, arcmin: GLANCE_ARCMIN });
  const reach = maxDistanceMetres(8, { diagonalInches: needed, arcmin: GLANCE_ARCMIN });
  assert.ok(Math.abs(reach - 6) < 0.01, `round trip gave ${reach}m`);
});

test('every size on the wall comes from the stylesheet, not from this test', () => {
  const sizes = styleSizes(wall.html);
  // The classes the renderer actually uses, all found, none invented here.
  for (const key of Object.keys(ROLES)) {
    assert.ok(typeof sizes[key] === 'number', `no font-size parsed for .${key}`);
  }
});

test('the wall passes the six-metre test on a plain 43-inch clubhouse television', () => {
  const report = measurePage(wall.html, BASELINE);
  assert.deepEqual(report.failures, [], report.failures.map((f) => `${f.kind}/${f.selector}: ${f.why}`).join('\n'));

  // Every slide type the loop can produce was measured, not just the easy ones.
  const kinds = new Set(report.slides.map((s) => s.kind));
  for (const kind of ['result', 'awaiting', 'calledoff', 'next', 'table', 'form', 'division', 'identity', 'rhythm', 'countdown']) {
    assert.ok(kinds.has(kind), `${kind} slide never appeared on the fixture wall, so it went unmeasured`);
  }
});

test('the one idea on each slide clears a two-second glance, with named exceptions only', () => {
  const report = measurePage(wall.html, BASELINE);
  for (const slide of report.slides) {
    if (!slide.idea) continue;
    const exempt = EXCEPTIONS[slide.idea.selector];
    if (exempt) {
      // An exception has to be a decision, so it must carry a reason and still clear the
      // floor for a fact — "we chose not to" is allowed, "nobody looked" is not.
      assert.ok(exempt.why.length > 40, `${slide.kind}: exception without a reason`);
      assert.ok(slide.idea.arcmin >= LEGIBLE_ARCMIN, `${slide.kind}: under the fact floor too`);
      continue;
    }
    assert.ok(slide.idea.arcmin >= GLANCE_ARCMIN,
      `${slide.kind}: its one idea is ${slide.idea.arcmin.toFixed(1)}', under ${GLANCE_ARCMIN}'`);
  }
});

test('the list slides reach the glance tier on a 65-inch set — the install number', () => {
  const report = measurePage(wall.html, BASELINE);
  for (const kind of ['table', 'division', 'rhythm']) {
    const slide = report.slides.find((s) => s.kind === kind);
    assert.ok(slide.glanceMinDiagonal <= 65,
      `${kind} needs a ${slide.glanceMinDiagonal.toFixed(0)}" screen to glance at six metres`);
  }
  // And the four that carry the heartbeat read at a glance on the small set.
  for (const kind of ['result', 'next', 'form', 'countdown', 'identity', 'calledoff']) {
    const slide = report.slides.find((s) => s.kind === kind);
    assert.ok(slide.glanceMaxDistance >= 6,
      `${kind} only glances to ${slide.glanceMaxDistance.toFixed(1)}m on a 43-inch screen`);
  }
});

test('text with no declared purpose fails the measurement', () => {
  // The guard that matters in six months: somebody adds a line to a slide, picks a size
  // by eye, and nobody notices it is unreadable. An unclassified class is a failure.
  const mutated = wall.html
    .replace('<style>', '<style>\n  .smallprint{font-size:1.4vh}')
    .replace('<p class="date"', '<p class="smallprint">Sponsored by someone</p>\n<p class="date"');
  const report = measurePage(mutated, BASELINE);
  assert.ok(report.failures.some((f) => f.selector === 'smallprint' && /no role/.test(f.why)),
    'unclassified text passed the measurement');
});

test('shrinking the date fails the measurement — trust rule 1 has a floor now', () => {
  const shrunk = wall.html.replace('.date{font-size:6.4vh', '.date{font-size:4vh');
  const report = measurePage(shrunk, BASELINE);
  assert.ok(report.failures.some((f) => f.selector === 'date'), 'a 4vh date passed');
});

test('nothing overflows the screen, which is silently clipped', () => {
  const report = measurePage(wall.html, BASELINE);
  for (const slide of report.slides) {
    const budget = verticalBudget(slide, { wrapAt: 2 });
    assert.ok(budget.usedVh < budget.limitVh,
      `${slide.kind} needs about ${budget.usedVh.toFixed(0)}vh and the screen has 100`);
  }
});

test('the smallest thing on the wall is still the line saying when the data was read', () => {
  const sizes = styleSizes(wall.html);
  const others = Object.entries(sizes).filter(([k]) => k !== 'footer').map(([, v]) => v);
  assert.ok(sizes.footer <= Math.min(...others), 'something on the wall is smaller than the provenance line');
});
