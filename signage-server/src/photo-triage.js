// Is a photograph big enough, and the right shape, for the wall?
//
// This module exists to answer one question that nobody has ever answered about the club's
// Facebook page: **how many of those images are actually usable on a television.** The
// brief's number — four hundred is a season, twelve is wallpaper by Thursday — is the
// largest open risk in the archive-wall idea, and it is a counting job, not a coding job.
//
// Two of the brief's three usability tests are pure arithmetic on width and height, so they
// run here with no eyes and no download:
//
//   * "landscape, or croppable to landscape"
//   * "big enough not to look soft at 1080p"
//
// The third — "a photograph of people or a pitch", *not* a fixture list, a poster, a sponsor
// logo or a league result card — needs somebody to look. That is honest to say out loud: the
// number this module produces is an **upper bound** on the usable pool, because a poster is
// very often large and landscape. What it buys is that the human eye-pass starts from the
// images that could possibly qualify, grouped by album, instead of from everything.
//
// No dependencies, by design: the signage server has none, and a counting tool is not the
// place to acquire the first one.

// The wall is a 1080p television, so every slide is finally 1920×1080.
export const TARGET_WIDTH = 1920;
export const TARGET_HEIGHT = 1080;
const TARGET_RATIO = TARGET_WIDTH / TARGET_HEIGHT; // 16:9

// Below this, a 16:9 crop has to be stretched past 1.5× to fill the screen and starts to
// look like a photograph of a photograph. Between this and 1920 it is upscaled but holds up
// at six metres — which is why it is reported as its own band rather than silently passed or
// silently failed. Where the club draws the line is the club's call, not this file's.
export const SOFT_WIDTH = 1280;

/**
 * The width of the largest 16:9 crop that fits inside `width`×`height`.
 *
 * This is the one number that matters, and it folds "landscape or croppable to landscape"
 * and "big enough" into a single comparison. A 3000×2000 photograph crops to 3000 wide; a
 * 1080×1920 phone portrait crops to 1080 wide (not 1920 — you cannot crop height you do not
 * have), so the portrait is correctly judged on what survives the crop rather than on its
 * longest side. An extreme panorama or a sliver-tall image falls out the bottom on its own.
 */
export function croppedWidth(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 0;
  return Math.floor(Math.min(w, h * TARGET_RATIO));
}

/** `landscape`, `square`, or `portrait` — reported because it predicts how harsh the crop is. */
export function orientation(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 'unknown';
  const ratio = w / h;
  if (ratio > 1.05) return 'landscape';
  if (ratio < 0.95) return 'portrait';
  return 'square';
}

// Sizes that a camera does not produce but a design tool does. Hitting one of these exactly
// is not proof of a poster — a photograph can be cropped to a square by hand — so this only
// ever raises a hint for the eye-pass, and never decides a band. It is here because on a
// village club's page the fixture cards and the sponsor graphics really do come out of Canva
// at exactly these sizes, and sorting them to the top of the review list saves real minutes.
const GRAPHIC_SIZES = [
  [1080, 1080], // square social post — the usual fixture card and result card
  [1200, 630], // link/share card
  [851, 315], // Facebook page cover
  [1200, 1200],
  [940, 788],
  [1080, 1350], // portrait "story-ish" post
  [1080, 1920], // full story
];

/** True if the dimensions are exactly a common design-tool canvas. A hint, never a verdict. */
export function looksLikeGraphic(width, height) {
  return GRAPHIC_SIZES.some(([w, h]) => Number(width) === w && Number(height) === h);
}

/**
 * Band one image by what the screen can do with it.
 *
 * - `full`  — a 16:9 crop fills 1920×1080 with pixels to spare. No upscaling.
 * - `soft`  — fills the screen only by upscaling, but survives a two-second glance at six
 *             metres. Usable; worth counting separately so the club can decide.
 * - `small` — below 1280 across the crop. This is the band that looks like a mistake on a
 *             television, and it is where thumbnails and web-sized images land.
 * - `unknown` — we could not read the dimensions. Never guessed, never quietly dropped.
 */
export function band(width, height) {
  const cw = croppedWidth(width, height);
  if (!cw) return 'unknown';
  if (cw >= TARGET_WIDTH) return 'full';
  if (cw >= SOFT_WIDTH) return 'soft';
  return 'small';
}

/**
 * Describe one candidate image.
 *
 * `item` is `{ id?, name?, album?, width, height, source? }` — the shape both routes can
 * produce: a Graph API photo node's largest rendition, or a file read off an export.
 */
export function describe(item = {}) {
  const width = Number(item.width) || 0;
  const height = Number(item.height) || 0;
  return {
    id: item.id ?? null,
    album: item.album ?? null,
    name: item.name ?? null,
    width,
    height,
    croppedWidth: croppedWidth(width, height),
    orientation: orientation(width, height),
    band: band(width, height),
    graphicHint: looksLikeGraphic(width, height),
  };
}

/**
 * Count a whole pool.
 *
 * Returns the bands, the album breakdown and the two numbers the brief actually asked for:
 * `mechanicalPass` (full + soft — the upper bound on usable) and `needsEye` (how many of
 * those still have to be looked at, because arithmetic cannot tell a team photo from a
 * fixture list).
 */
export function triage(items = []) {
  const rows = items.map(describe);
  const bands = { full: 0, soft: 0, small: 0, unknown: 0 };
  const albums = new Map();

  for (const row of rows) {
    bands[row.band] += 1;
    const key = row.album ?? '(no album)';
    const entry = albums.get(key) ?? { album: key, total: 0, pass: 0, graphicHints: 0 };
    entry.total += 1;
    if (row.band === 'full' || row.band === 'soft') entry.pass += 1;
    if (row.graphicHint) entry.graphicHints += 1;
    albums.set(key, entry);
  }

  const mechanicalPass = bands.full + bands.soft;
  return {
    total: rows.length,
    bands,
    mechanicalPass,
    graphicHints: rows.filter((r) => r.graphicHint).length,
    needsEye: mechanicalPass,
    albums: [...albums.values()].sort((a, b) => b.pass - a.pass || b.total - a.total),
    rows,
  };
}

// --------------------------------------------------------------- reading a file's own size
//
// Dimensions straight out of the file header, so an export can be counted without a Graph
// token and without decoding a single pixel. Only the headers are parsed — the first few
// hundred bytes are enough for every format the wall will show.

/** JPEG: walk the segment chain to the first SOF marker, which carries height then width. */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1; // resync: a padded or slightly odd file should not take the whole count down
      continue;
    }
    const marker = buf[i + 1];
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // SOF0/1/2/3, 5/6/7, 9/10/11, 13/14/15 — every frame type except DHT/JPG/DAC.
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** PNG: IHDR is always the first chunk, at a fixed offset. */
function pngSize(buf) {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** GIF: little-endian width and height at a fixed offset. */
function gifSize(buf) {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'GIF') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** WebP: three container flavours, each with the size in a different place. */
function webpSize(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') {
    return {
      width: (buf.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (buf.readUIntLE(27, 3) & 0xffffff) + 1,
    };
  }
  return null;
}

/** AVIF/HEIF: find the `ispe` box and read the primary image extent out of it. */
function avifSize(buf) {
  if (buf.length < 16 || buf.toString('ascii', 4, 8) !== 'ftyp') return null;
  const at = buf.indexOf('ispe', 0, 'ascii');
  if (at < 0 || at + 16 > buf.length) return null;
  return { width: buf.readUInt32BE(at + 8), height: buf.readUInt32BE(at + 12) };
}

/**
 * Width and height of an image from its header bytes, or null if we cannot tell.
 *
 * Null is a real answer and is reported as `unknown` rather than folded into a pass or a
 * fail — an uncounted photograph is a smaller problem than a miscounted one.
 */
export function imageSize(buf) {
  if (!buf || buf.length < 10) return null;
  return jpegSize(buf) ?? pngSize(buf) ?? gifSize(buf) ?? webpSize(buf) ?? avifSize(buf);
}

// --------------------------------------------------------- picking a rendition out of Graph
//
/**
 * The biggest rendition in a Graph API photo node's `images` array.
 *
 * Graph returns the same photograph at a ladder of sizes, largest first in practice but not
 * by contract, so this maximises rather than taking `[0]`. The largest is the one closest to
 * what the club originally uploaded, which is the whole reason for preferring this route to
 * anything that reads a public page view.
 */
export function largestImage(node = {}) {
  const images = Array.isArray(node.images) ? node.images : [];
  let best = null;
  for (const img of images) {
    const w = Number(img?.width) || 0;
    const h = Number(img?.height) || 0;
    if (!w || !h) continue;
    if (!best || w * h > best.width * best.height) best = { width: w, height: h, source: img.source };
  }
  return best;
}
