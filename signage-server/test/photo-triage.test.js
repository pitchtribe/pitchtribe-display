// The counting rules, and the header readers they depend on.
//
// The count is the deliverable this whole issue turns on, so the arithmetic that produces it
// is pinned here rather than trusted. The cases that matter are the ones where a careless
// rule would give a wrong number in a reassuring direction: phone portraits, panoramas,
// Graph's size ladder, and the `type=uploaded` trap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  croppedWidth, orientation, band, looksLikeGraphic, describe, triage,
  imageSize, largestImage, TARGET_WIDTH, SOFT_WIDTH,
} from '../src/photo-triage.js';

test('a 16:9 crop can only be as wide as the height allows', () => {
  // Landscape with height to spare: the full width survives.
  assert.equal(croppedWidth(3000, 2000), 3000);
  // Exactly 16:9 already.
  assert.equal(croppedWidth(1920, 1080), 1920);
  // A phone portrait is judged on what survives the crop, not on its longest side. This is
  // the case a "max(w, h)" rule gets wrong, and it would inflate the count with images that
  // land on the wall as a soft letterboxed sliver.
  assert.equal(croppedWidth(1080, 1920), 1080);
  // A wide panorama is limited by its own height.
  assert.equal(croppedWidth(8000, 1000), Math.floor(1000 * (16 / 9)));
});

test('unreadable or nonsense dimensions are zero, never a guess', () => {
  for (const bad of [[0, 0], [-5, 100], [100, 0], [NaN, 100], ['', ''], [undefined, undefined]]) {
    assert.equal(croppedWidth(bad[0], bad[1]), 0, `${bad}`);
  }
  assert.equal(band(0, 0), 'unknown');
  assert.equal(orientation(0, 0), 'unknown');
});

test('orientation tolerates a few pixels off square', () => {
  assert.equal(orientation(1920, 1080), 'landscape');
  assert.equal(orientation(1080, 1920), 'portrait');
  assert.equal(orientation(1000, 1000), 'square');
  assert.equal(orientation(1020, 1000), 'square'); // a hand-cropped "square" is still square
});

test('bands follow the screen, and the boundaries are inclusive at the bottom', () => {
  assert.equal(band(1920, 1080), 'full');
  assert.equal(band(4032, 3024), 'full');
  assert.equal(band(1919, 1079), 'soft'); // one pixel short of full is soft, not full
  assert.equal(band(SOFT_WIDTH, Math.ceil(SOFT_WIDTH / (16 / 9))), 'soft');
  assert.equal(band(1279, 719), 'small');
  assert.equal(band(640, 480), 'small');
  // A portrait big enough in pixels but not after the crop is correctly 'soft', and a
  // sliver-tall image falls to 'small' without needing a special rule.
  assert.equal(band(1500, 2000), 'soft');
  assert.equal(band(2000, 300), 'small');
});

test('design-canvas sizes are a hint, and only on an exact match', () => {
  assert.equal(looksLikeGraphic(1080, 1080), true); // the fixture card
  assert.equal(looksLikeGraphic(1200, 630), true);
  assert.equal(looksLikeGraphic(851, 315), true);
  assert.equal(looksLikeGraphic(1081, 1080), false); // near is not a match
  assert.equal(looksLikeGraphic(4032, 3024), false); // a real camera
  // The hint never changes the band — it is advice for the eye-pass, not a filter. Here the
  // band happens to be 'small' on its own arithmetic: a 1080 square crops to 1080×607, which
  // is the useful surprise in this whole module. The square fixture card that fills a phone
  // screen is *not* a 1080p slide, and counting it as one would inflate the pool.
  assert.equal(describe({ width: 1080, height: 1080 }).band, 'small');
  assert.equal(describe({ width: 1080, height: 1080 }).graphicHint, true);
  // A genuinely large poster does pass mechanically, which is exactly why the headline
  // number is an upper bound and not an answer.
  assert.equal(describe({ width: 2000, height: 2000 }).band, 'full');
});

test('triage totals, bands and album rollup agree with each other', () => {
  const report = triage([
    { album: 'Match day', width: 4032, height: 3024 },     // full
    { album: 'Match day', width: 3000, height: 2000 },     // full
    { album: 'Match day', width: 1600, height: 900 },      // soft
    { album: 'Match day', width: 800, height: 600 },        // small
    { album: 'Sponsors', width: 1080, height: 1080 },       // small (crops to 607 tall) + hint
    { album: 'Sponsors', width: 851, height: 315 },         // small + graphic hint
    { album: 'Fixtures', width: 0, height: 0 },             // unknown
  ]);

  assert.equal(report.total, 7);
  assert.deepEqual(report.bands, { full: 2, soft: 1, small: 3, unknown: 1 });
  // The bands must account for every image exactly once, or the headline number is a lie.
  const summed = Object.values(report.bands).reduce((a, b) => a + b, 0);
  assert.equal(summed, report.total);
  assert.equal(report.mechanicalPass, 3);
  assert.equal(report.graphicHints, 2);

  const byName = new Map(report.albums.map((a) => [a.album, a]));
  assert.deepEqual(
    { total: byName.get('Match day').total, pass: byName.get('Match day').pass },
    { total: 4, pass: 3 },
  );
  assert.equal(byName.get('Sponsors').graphicHints, 2);
  // An unknown-dimension image is counted in its album's total but never in its pass.
  assert.deepEqual(
    { total: byName.get('Fixtures').total, pass: byName.get('Fixtures').pass },
    { total: 1, pass: 0 },
  );
  // Albums are ordered by what they contribute, so the eye-pass starts at the top.
  assert.equal(report.albums[0].album, 'Match day');
});

test('an empty pool reports zero rather than throwing', () => {
  const report = triage([]);
  assert.equal(report.total, 0);
  assert.equal(report.mechanicalPass, 0);
  assert.deepEqual(report.albums, []);
});

test('the largest Graph rendition wins, whatever order the ladder arrives in', () => {
  const node = {
    images: [
      { width: 320, height: 240, source: 'small.jpg' },
      { width: 2048, height: 1536, source: 'big.jpg' },
      { width: 1280, height: 960, source: 'mid.jpg' },
    ],
  };
  assert.deepEqual(largestImage(node), { width: 2048, height: 1536, source: 'big.jpg' });
  // Graph lists largest-first in practice but does not promise to, which is why this
  // maximises instead of taking images[0].
  assert.equal(largestImage({ images: [] }), null);
  assert.equal(largestImage({}), null);
  // Renditions missing their dimensions are skipped, not treated as zero-area winners.
  assert.deepEqual(
    largestImage({ images: [{ source: 'x.jpg' }, { width: 100, height: 100, source: 'y.jpg' }] }),
    { width: 100, height: 100, source: 'y.jpg' },
  );
});

// ------------------------------------------------------------------- header readers
// Minimal real headers, built by hand, so the readers are checked against bytes rather
// than against a library that would have to be added to check them.

test('PNG dimensions come out of IHDR', () => {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(1920, 16);
  buf.writeUInt32BE(1080, 20);
  assert.deepEqual(imageSize(buf), { width: 1920, height: 1080 });
});

test('JPEG dimensions come out of the first frame header, past other segments', () => {
  // SOI, then an APP0/JFIF segment to skip, then a DQT to skip, then SOF0.
  const parts = [
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),       // APP0, length 4
    Buffer.from([0xff, 0xdb, 0x00, 0x05, 0x00, 0x00, 0x00]), // DQT, length 5
    // SOF0: length, precision, height(2), width(2), components
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x0c, 0x00, 0x15, 0xc0, 0x03]),
  ];
  assert.deepEqual(imageSize(Buffer.concat(parts)), { width: 5568, height: 3072 });
});

test('JPEG progressive frames are read too', () => {
  // SOF2 is what a re-encoded Facebook download very often is; missing it would report a
  // large share of a real export as 'unknown'.
  const buf = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc2, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03]),
  ]);
  assert.deepEqual(imageSize(buf), { width: 1920, height: 1080 });
});

test('GIF and WebP headers are read, and a stray file is simply unknown', () => {
  const gif = Buffer.alloc(10);
  gif.write('GIF89a', 0, 'ascii');
  gif.writeUInt16LE(640, 6);
  gif.writeUInt16LE(480, 8);
  assert.deepEqual(imageSize(gif), { width: 640, height: 480 });

  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8 ', 12, 'ascii');
  webp.writeUInt16LE(1600, 26);
  webp.writeUInt16LE(900, 28);
  assert.deepEqual(imageSize(webp), { width: 1600, height: 900 });

  // A Thumbs.db or a notes.txt costs nothing and must not throw.
  assert.equal(imageSize(Buffer.from('this is not an image at all')), null);
  assert.equal(imageSize(Buffer.alloc(0)), null);
  assert.equal(imageSize(null), null);
});

test('a truncated JPEG is unknown rather than an exception', () => {
  // Counting a real export must not die on one damaged file.
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00])), null);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00])), null);
});

test('the sixty-photograph floor is what the brief set it at', () => {
  // Not a behaviour of the module, but the number the report compares against, kept next to
  // the rules so that moving it is a deliberate edit with a test beside it.
  assert.equal(TARGET_WIDTH, 1920);
  assert.equal(SOFT_WIDTH, 1280);
});
