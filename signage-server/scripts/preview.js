#!/usr/bin/env node
// The wall as one static file, for people without a Raspberry Pi.
//
//   node scripts/preview.js out.html [secondsPerSlide]
//
// Renders the real page from the example club file, pinned to the Sunday evening after
// its last result so every slide type has something in it, and with the live-reload
// plumbing left out so the file works opened from a disk.
//
// Two things the preview cannot be honest about on its own, so they are said here: there
// are no photograph slides, because the example pool is empty; and after about three
// minutes it shows the "no internet" strip, because a file opened from a disk genuinely
// cannot reach a server. That is the card's offline behaviour working, not failing.
import { writeFile } from 'node:fs/promises';
import { buildFixtureWall } from './wall-fixture.js';

const out = process.argv[2] ?? 'clubhouse-wall-preview.html';
const rotateSeconds = Number(process.argv[3]) || undefined;

const { html, wall, now } = await buildFixtureWall({ live: false, rotateSeconds });
await writeFile(out, html, 'utf8');

const kinds = wall.slides.reduce((acc, s) => ({ ...acc, [s.kind]: (acc[s.kind] ?? 0) + 1 }), {});
console.log(`${out} — ${wall.slides.length} slides, pinned to ${now.toISOString()}`);
console.log(Object.entries(kinds).map(([k, n]) => `${k}×${n}`).join(' · '));
