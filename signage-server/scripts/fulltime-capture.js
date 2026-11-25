#!/usr/bin/env node
// One real Full-Time snippet feed, saved and read out loud.
//
//   npm run fulltime:capture -- --code=123456 [--kind=results] [--out=dir]
//
// Why this exists: the Full-Time adapter was written against a support article rather than
// against an observed response, because nobody has handed us a snippet code yet. Two things
// in it are therefore assumptions — the request URL and the payload format — and this script
// is how they stop being assumptions. Run it the hour a code arrives.
//
// It saves the raw body byte for byte (so the capture can be re-read later without asking
// the FA for anything again), then says which of the three payload branches the body took,
// how many rows came out, and what the adapter made of the first few. If it refuses the
// body, that is the useful answer too: the format is not one of the three guesses, and the
// fix is `parsePayload` rather than a shrug.
//
// Politeness: one request per run. This script is the only thing in the repo that reaches
// Full-Time without the weekly cache in front of it, and it is run by hand.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  normalizeFeeds, feedUrl, parsePayload, rowsFrom, eventsFromRows, standingsFromRows,
} from '../src/sources/fulltime.js';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);

const code = args.get('code');
if (!code) {
  console.error('usage: npm run fulltime:capture -- --code=<lrcode> [--kind=results|fixtures|table|team] [--endpoint=URL] [--out=dir]');
  console.error('\nThe code is the `lrcode` out of the embed snippet the league generates in');
  console.error('Full-Time under Media → Code snippets. See signage-server/FULL_TIME.md.');
  process.exit(2);
}

const kind = args.get('kind') ?? 'results';
const outDir = args.get('out') ?? 'captures';
const league = {
  key: 'capture',
  name: 'Full-Time capture',
  feeds: [{ code, kind }],
  ...(args.get('endpoint') ? { endpoint: args.get('endpoint') } : {}),
  ...(args.get('urlTemplate') ? { urlTemplate: args.get('urlTemplate') } : {}),
};

const [feed] = normalizeFeeds(league, { log: (m) => console.error(m) });
if (!feed) process.exit(2);

const url = feedUrl(feed, league);
console.log(`GET ${url}`);

let res;
let body;
try {
  res = await fetch(url, {
    headers: { accept: '*/*', 'user-agent': 'PitchTribe-Signage/1.0 (+https://pitchtribe.co.uk)' },
    signal: AbortSignal.timeout(20_000),
  });
  body = await res.text();
} catch (err) {
  // A stack trace is no use to somebody running this once, at a kitchen table, with the
  // code in an email beside them.
  console.error(`\nThe request did not complete: ${err.cause?.code ?? err.name} — ${err.cause?.message ?? err.message}`);
  console.error('Either this machine cannot reach the internet, or the host in --endpoint is wrong.');
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const raw = join(outDir, `fulltime-${kind}-${code}-${stamp}.txt`);
await writeFile(raw, body, 'utf8');

console.log(`HTTP ${res.status} ${res.headers.get('content-type') ?? ''} · ${body.length} bytes`);
console.log(`saved  ${raw}`);
if (!res.ok) {
  console.error('\nNot a usable response. Worth knowing which it is:');
  console.error('  401/403 — the code is not public, or it is scoped to a referring page');
  console.error('  404     — the endpoint guess in feedUrl() is wrong (try --endpoint=…)');
  console.error('  200 but a login page — the same thing wearing a different number');
  process.exit(1);
}

let parsed;
try {
  parsed = parsePayload(body);
} catch (err) {
  console.error(`\nREFUSED: ${err.message}`);
  console.error('The body is none of the three shapes parsePayload knows. That is the finding:');
  console.error(`read ${raw}, then teach parsePayload the real shape and delete the guesses.`);
  process.exit(1);
}

console.log(`\nshape  ${parsed.shape}   ← the branch that is real; the other two can go`);

const standings = feed.carries === 'standings';
const rows = rowsFrom(parsed, { standings });
console.log(`rows   ${rows.length}`);
if (!rows.length) {
  console.error('\nParsed, but no rows found. rowsFrom() is looking in the wrong place —');
  console.error('the capture says where they really are.');
  process.exit(1);
}
console.log(`fields ${Object.keys(rows[0]).join(', ')}`);

if (standings) {
  const table = standingsFromRows(rows, feed, league);
  if (!table) {
    console.error('\nRows, but no readable table row in them (every row needs a team and points).');
    process.exit(1);
  }
  console.log(`\n${table.name} — ${table.rows.length} rows`);
  for (const r of table.rows.slice(0, 5)) {
    console.log(`  ${String(r.position).padStart(2)} ${r.team.padEnd(24)} P${r.played ?? '?'} Pts${r.points ?? '?'}${r.note ? `  (${r.note})` : ''}`);
  }
} else {
  const log = [];
  const events = eventsFromRows(rows, feed, league, { log: (m) => log.push(m) });
  console.log(`\n${events.length} of ${rows.length} rows became matches`);
  for (const e of events.slice(0, 6)) {
    const score = e.home.score === null ? ' v ' : ` ${e.home.score}–${e.away.score} `;
    console.log(`  ${e.start.slice(0, 16)}${e.kickoffKnown ? '' : ' (no KO published)'}  ${e.home.name}${score}${e.away.name}  [${e.status}${e.statusText ? ` · ${e.statusText}` : ''}]`);
  }
  // Every refusal matters here: each one is a row the wall would not show, and the reason.
  for (const line of log) console.log(`  ! ${line}`);
}

console.log(`\nNext: commit the capture under test/fixtures/ and pin a test to it, so the real`);
console.log('format is what the adapter is checked against rather than a guess at it.');
