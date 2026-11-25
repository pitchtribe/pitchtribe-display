#!/usr/bin/env node
// How many usable photographs does the club actually have?
//
//   npm run photos:count -- --dir=~/caldecote-export      # a Page export, unpacked
//   npm run photos:count -- --token=EAAG... [--page=100054578283967]
//
// Why this exists: the archive wall is most of what the screen shows from Sunday to Friday,
// and nobody has ever counted the pool it would draw on. Four hundred usable photographs is
// a screen that looks different every day for a season; twelve is wallpaper by Thursday. The
// count decides version one's slide mix, so it comes before any harvesting code — and if the
// honest answer is under about sixty, that is the cheapest bad news available.
//
// It counts. It does not harvest, downscale, de-duplicate or write a pool. Nothing in this
// script modifies anything, and in `--token` mode it downloads no image data at all: Graph
// reports each photograph's dimensions in the listing, so the arithmetic runs on metadata.
//
// Both routes are supported because both are live options and the export is the better one —
// see signage-server/FACEBOOK_PHOTOS.md for which to ask the club for and why.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { homedir } from 'node:os';
import { triage, imageSize, largestImage, TARGET_WIDTH, SOFT_WIDTH } from '../src/photo-triage.js';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);

const USAGE = `usage:
  npm run photos:count -- --dir=<unpacked export folder>
  npm run photos:count -- --token=<page access token> [--page=<page id>]

  --dir     Count an export the club's Page admin produced (Meta Accounts Centre →
            "Download your information", Photos and videos, media quality High). Reads
            image headers off disk; no network, no credential, best picture quality.
  --token   Count over the Graph API with a Page access token from somebody who can
            MODERATE the Page. Reads metadata only — no images are downloaded.
  --page    Page id for --token mode (default: the club's own Page).
  --json    Print the full machine-readable report instead of the summary.
  --limit   Stop after N photographs (--token mode), for a quick look.

See signage-server/FACEBOOK_PHOTOS.md.`;

if (args.has('help') || (!args.has('dir') && !args.has('token'))) {
  console.error(USAGE);
  process.exit(args.has('help') ? 0 : 2);
}

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

// ----------------------------------------------------------------------------- the two routes

/**
 * Walk an unpacked export. Albums come out as the folder names the export used, which is
 * what makes the eye-pass quick: "Sponsors" and "Fixtures" can be dismissed wholesale.
 */
async function fromDir(root) {
  const out = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`! cannot read ${dir}: ${err.message}`);
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!PHOTO_EXT.has(extname(entry.name).toLowerCase())) continue;
      // Only the head of the file is read: every format carries its dimensions in the first
      // few hundred bytes, and a 6 MB photograph should not cost 6 MB to count.
      let size = null;
      try {
        const fh = await readFile(full, { flag: 'r' });
        size = imageSize(fh.subarray(0, Math.min(fh.length, 65536)));
      } catch (err) {
        console.error(`! cannot read ${entry.name}: ${err.message}`);
      }
      const album = relative(root, dir) || '(export root)';
      out.push({
        id: relative(root, full),
        album,
        name: entry.name,
        width: size?.width ?? 0,
        height: size?.height ?? 0,
      });
    }
  };
  await walk(root);
  return out;
}

/**
 * Page every uploaded photograph out of Graph. `type=uploaded` matters: the default is
 * `profile`, which returns the Page's profile pictures and nothing else — the single most
 * likely way to get a wrong, reassuringly small number out of this endpoint.
 */
async function fromGraph(token, pageId, limit) {
  const fields = 'id,name,album{name},images{width,height},created_time';
  let url = `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/photos`
    + `?type=uploaded&limit=100&fields=${encodeURIComponent(fields)}`
    + `&access_token=${encodeURIComponent(token)}`;
  const out = [];
  let pages = 0;

  while (url) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.error) {
      const e = body?.error ?? {};
      console.error(`\nGraph refused the request: HTTP ${res.status} ${e.type ?? ''} ${e.message ?? ''}`.trimEnd());
      if (e.code === 104 || e.code === 190) {
        console.error('\nThat is the token, not the Page. A Page access token is needed, from an');
        console.error('account that can MODERATE the Page, with pages_read_engagement.');
        console.error('See "What to ask the club for" in signage-server/FACEBOOK_PHOTOS.md.');
      }
      if (e.code === 100 && e.error_subcode === 33) {
        console.error('\nThe id is not visible to this token. Check --page, and that the token');
        console.error('belongs to an admin of that Page rather than to a personal profile.');
      }
      process.exit(1);
    }
    for (const node of body.data ?? []) {
      const big = largestImage(node);
      out.push({
        id: node.id,
        album: node.album?.name ?? '(no album)',
        name: node.name ?? null,
        created: node.created_time ?? null,
        width: big?.width ?? 0,
        height: big?.height ?? 0,
      });
    }
    pages += 1;
    process.stderr.write(`\r  read ${out.length} photographs (${pages} page${pages === 1 ? '' : 's'})…`);
    if (limit && out.length >= limit) break;
    url = body.paging?.next ?? null;
  }
  process.stderr.write('\n');
  return limit ? out.slice(0, limit) : out;
}

// ------------------------------------------------------------------------------------ report

const route = args.has('dir') ? 'export' : 'graph';
let items;
if (route === 'export') {
  const dir = expand(args.get('dir'));
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) {
    console.error(`Not a directory: ${dir}`);
    process.exit(2);
  }
  console.log(`Counting the export under ${dir}`);
  items = await fromDir(dir);
} else {
  const pageId = args.get('page') ?? '100054578283967'; // Caldecote Football Club
  console.log(`Counting uploaded photographs on Page ${pageId} over the Graph API`);
  items = await fromGraph(args.get('token'), pageId, Number(args.get('limit')) || 0);
}

const report = triage(items);

if (args.has('json')) {
  console.log(JSON.stringify({ route, ...report }, null, 2));
  process.exit(0);
}

const pct = (n) => (report.total ? `${Math.round((n / report.total) * 100)}%` : '—');

console.log(`\n${report.total} image${report.total === 1 ? '' : 's'} found.\n`);
console.log('By what the screen can do with a 16:9 crop of it:');
console.log(`  full   ${String(report.bands.full).padStart(5)}  ${pct(report.bands.full).padStart(4)}  crops to ${TARGET_WIDTH}px or wider — no upscaling`);
console.log(`  soft   ${String(report.bands.soft).padStart(5)}  ${pct(report.bands.soft).padStart(4)}  crops to ${SOFT_WIDTH}–${TARGET_WIDTH - 1}px — upscaled, holds at six metres`);
console.log(`  small  ${String(report.bands.small).padStart(5)}  ${pct(report.bands.small).padStart(4)}  under ${SOFT_WIDTH}px across the crop — looks like a mistake on a TV`);
if (report.bands.unknown) {
  console.log(`  ?      ${String(report.bands.unknown).padStart(5)}  ${pct(report.bands.unknown).padStart(4)}  dimensions unreadable — counted nowhere, not assumed good`);
}

console.log(`\nUpper bound on the usable pool: ${report.mechanicalPass}`);
console.log('  Upper bound, not the answer. Arithmetic knows size and shape; it cannot tell a');
console.log('  team photograph from a fixture list, a sponsor board or a result card, and those');
console.log(`  are usually large and landscape too. ${report.graphicHints} image(s) are exactly a design-tool`);
console.log('  canvas size, which is a hint for the eye-pass and not a verdict.');

if (report.albums.length > 1) {
  console.log('\nBy album — this is where the eye-pass should start, and what it can skip:');
  for (const a of report.albums.slice(0, 25)) {
    const hint = a.graphicHints ? `  (${a.graphicHints} design-canvas size)` : '';
    console.log(`  ${String(a.pass).padStart(5)} of ${String(a.total).padEnd(5)} ${a.album}${hint}`);
  }
  if (report.albums.length > 25) console.log(`  … and ${report.albums.length - 25} more albums`);
}

// The brief's own threshold, said back plainly, because this is the decision the count exists
// to inform and it should not need a second reading of the report to reach.
console.log('\n---');
if (report.mechanicalPass < 60) {
  console.log(`At most ${report.mechanicalPass} usable photographs — under the sixty the brief set as the floor.`);
  console.log('Report this to PIT-42 and stop: version one\'s slide mix changes, not the code.');
  console.log('A pool this shallow is wallpaper by Thursday however good the harvesting is.');
} else if (report.mechanicalPass < 150) {
  console.log(`At most ${report.mechanicalPass} usable photographs — over the floor, but not deep.`);
  console.log('Worth an eye-pass to get the real number before building the harvest: if the');
  console.log('posters and result cards take a third of these, it is close to the floor again.');
} else {
  console.log(`At most ${report.mechanicalPass} usable photographs — comfortably over the floor.`);
  console.log('An eye-pass on these confirms the real number; then the harvest is worth building.');
}
console.log('\nNext: put the number on PIT-42 before any harvesting code gets written. That');
console.log('sequencing is the point — the count is worth more than the pipeline.');
