#!/usr/bin/env node
// The six-metre test, printed.
//
//   node scripts/six-metre.js                 # 43-inch screen at six metres
//   node scripts/six-metre.js 55 6            # a 55-inch screen at six metres
//
// Prints every piece of text on every slide type with its real cap height in millimetres
// and arcminutes, the tier it has to clear, and — the number worth carrying to an install
// — the smallest screen each slide's one idea reads at a glance on, and how far back it
// still reads on the screen you asked about.
//
// This is the measurable half of the design law. The photograph is still owed: no
// arithmetic here sees glare off a window, a dirty screen or a bar light above it.
import {
  measurePage, verticalBudget, BASELINE, GLANCE_ARCMIN, LEGIBLE_ARCMIN, capHeightMm,
} from '../src/legibility.js';
import { buildFixtureWall } from './wall-fixture.js';

const diagonalInches = Number(process.argv[2]) || BASELINE.diagonalInches;
const distanceMetres = Number(process.argv[3]) || BASELINE.distanceMetres;
const screen = { diagonalInches, distanceMetres };

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

const { html } = await buildFixtureWall({ photoFiles: ['one.jpg'] });
const report = measurePage(html, screen);

console.log(`\nThe six-metre test — ${diagonalInches}" 16:9 screen at ${distanceMetres} m`);
console.log(`Thresholds: an idea must clear ${GLANCE_ARCMIN}' of cap height, a fact ${LEGIBLE_ARCMIN}'. Provenance has no floor.\n`);

for (const slide of [...report.slides, report.wall]) {
  if (!slide.elements.length) continue;
  const head = slide.glanceMinDiagonal
    ? `glances on ${slide.glanceMinDiagonal.toFixed(0)}"+ at ${distanceMetres} m · reads at a glance up to ${slide.glanceMaxDistance.toFixed(1)} m on this one`
    : 'no text';
  console.log(`${slide.kind.toUpperCase()}  (${head})`);
  for (const e of slide.elements) {
    const mm = e.vh === null ? '—' : `${capHeightMm(e.vh, diagonalInches).toFixed(0)}mm`;
    const arc = e.arcmin === null ? '—' : `${e.arcmin.toFixed(1)}'`;
    const mark = e.ok ? '  ok' : 'FAIL';
    console.log(`  ${mark}  ${pad(e.selector, 12)} ${lpad(e.vh ?? '?', 5)}vh ${lpad(mm, 7)} ${lpad(arc, 7)}  ${pad(e.role ?? 'UNCLASSIFIED', 5)} ≥${lpad(e.floor ?? '-', 3)}'  ${e.text.slice(0, 34)}`);
    if (e.exception) console.log(`        exception: ${e.exception}`);
  }
  if (slide.kind !== '(whole wall)') {
    const budget = verticalBudget(slide, { wrapAt: 2 });
    console.log(`        height: about ${budget.usedVh.toFixed(0)}vh of 100 used (two-line wrap assumed)`);
  }
  console.log('');
}

if (report.pass) {
  console.log(`PASS — every idea clears ${GLANCE_ARCMIN}' and every fact ${LEGIBLE_ARCMIN}' on a ${diagonalInches}" screen at ${distanceMetres} m.`);
} else {
  console.log(`FAIL — ${report.failures.length} measurement(s) below the floor on a ${diagonalInches}" screen at ${distanceMetres} m:`);
  for (const f of report.failures) console.log(`  · ${f.kind} / ${f.selector}: ${f.why}`);
}
console.log('');
process.exitCode = report.pass ? 0 : 1;
