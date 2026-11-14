// One wall, built from the example club file, for the tools that need to look at a real
// page: the six-metre measurement and the static preview.
//
// The example season runs to a fixed date, so "now" is pinned to the Sunday evening after
// its last played Saturday. That is the fullest the loop ever gets — results, an
// unpublished one, a called-off one, next Saturday, the table, form and the division all
// have something in them — which is the right page to measure and the right one to show.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { buildClubhouse, zoneParts } from '../src/clubhouse.js';
import { renderClubhouse } from '../src/clubhouse-render.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The Sunday evening after the last result in the file, in the club's own timezone. */
function sundayAfterLastResult(events, tz) {
  const played = events
    .filter((e) => e.status === 'final' && e.home.score !== null && e.away.score !== null)
    .map((e) => Date.parse(e.start))
    .sort((a, b) => a - b);
  const last = played.at(-1) ?? Date.now();
  const { weekday } = zoneParts(new Date(last), tz);
  const toSunday = (7 - weekday) % 7 || 7; // the next Sunday, never the same day
  const d = new Date(last + toSunday * 86_400_000);
  d.setUTCHours(19, 30, 0, 0);
  return d;
}

/**
 * @returns {{ wall, html, now, config, photoFiles }}
 */
export async function buildFixtureWall({ photoFiles = [], live = false, rotateSeconds } = {}) {
  const config = JSON.parse(await readFile(resolve(root, 'clubhouse.example.json'), 'utf8'));
  // The manual source reads a path relative to the server's working directory.
  config.leagues = config.leagues.map((l) => ({ ...l, file: resolve(root, l.file) }));

  const store = new Store(config, { log: () => {} });
  await store.refresh();
  const snapshot = store.snapshot();
  const tz = config.timezone ?? 'Europe/London';
  const now = sundayAfterLastResult(snapshot.leagues[0]?.events ?? [], tz);

  const wall = buildClubhouse(snapshot, config, { now, photoFiles });
  const html = renderClubhouse(wall, {
    live,
    rotateSeconds: rotateSeconds ?? config.clubhouse?.rotateSeconds,
  });
  return { wall, html, now, config, photoFiles };
}
