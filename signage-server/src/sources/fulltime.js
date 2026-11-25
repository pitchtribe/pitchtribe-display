// Grassroots results, fixtures, form and the league table, read from the FA Full-Time
// **code-snippet feeds** that a club's own league issues to it. One read a week, cached.
// We do not scrape the public Full-Time pages — the route decision, and the reasons it is
// not a matter of taste, are in ../../FULL_TIME.md. Read that before changing this file.
//
// Config shape (one league entry, several snippet codes):
//   {
//     "key": "club",
//     "source": "fulltime",
//     "name": "Bedfordshire County League",
//     "club": { "name": "Caldecote FC", "aliases": ["Caldecote"] },
//     "refreshHours": 168,                 // one read a week; politeness is a requirement here
//     "feeds": [
//       { "code": "123456", "kind": "table",    "competition": "Premier Division" },
//       { "code": "123457", "kind": "results",  "competition": "Premier Division", "team": "First XI" },
//       { "code": "123458", "kind": "fixtures", "competition": "Premier Division", "team": "First XI" },
//       { "code": "123459", "kind": "results",  "competition": "Division One",     "team": "Reserves" },
//       { "code": "123460", "kind": "results",  "competition": "Premier Division" }   // no team: the division
//     ]
//   }
//
// `code` is the `lrcode` out of the embed snippet (Media → Code snippets in Full-Time).
// `kind` is which of the six feed types it is; `team` says which of the club's sides the
// feed is scoped to, because a team feed does not say so itself. A feed with no `team` is
// division-wide — that is what fills the "around the division" slide.
//
// ---------------------------------------------------------------------------------------
// UNVERIFIED, AND DELIBERATELY SO IN ONE PLACE ONLY
//
// Nobody has yet handed us a real `lrcode`, so nothing here has met a real feed response.
// Two things are therefore assumptions rather than observations: the request URL, and the
// payload format. Both are confined to `feedUrl()` and `parsePayload()`:
//
//   * `feedUrl()` is driven by config (`endpoint`, `codeParam`, `urlTemplate`), so a
//     wrong guess is fixed in a config line, not in a release.
//   * `parsePayload()` accepts the three shapes a widget loader of this vintage can
//     return — bare JSON, JSONP/assignment, or table markup — and **refuses anything it
//     does not recognise** rather than half-reading it. When one capture tells us which
//     branch is live, the other two can be deleted.
//
// `npm run fulltime:capture -- --code=<id>` saves one real response and says which branch
// it took. Run it the hour a code arrives; see ../../FULL_TIME.md.
// ---------------------------------------------------------------------------------------

import { plainText } from '../sources.js';
import { normalizeClub, normalizeRow, normalizeStandings, normalizeStatus } from './manual.js';

/** The six feed types Full-Time offers, mapped to what each one contributes here. */
export const FEED_KINDS = {
  table: 'standings',
  results: 'events',
  fixtures: 'events',
  team: 'events',            // Team Fixtures/Results — one side, both halves
  'club-fixtures': 'events',
  'club-results': 'events',
};

const HOUR = 3_600_000;
const DEFAULT_ENDPOINT = 'https://fulltime-league.thefa.com/client/api/cs1.js';
const DEFAULT_REFRESH_HOURS = 168;  // one week
const DEFAULT_RETRY_HOURS = 1;      // a transient failure recovers; it does not hammer
const CREDIT = 'Results from The FA Full-Time';

const slug = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** First present value among several spellings of the same field. Keys are compared with
    punctuation and case thrown away, so `matchDate`, `match_date` and `MatchDate` all hit. */
export function pick(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  const flat = new Map(Object.entries(obj).map(([k, v]) => [key(k), v]));
  for (const name of names) {
    const v = flat.get(key(name));
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// ----------------------------------------------------------------------- config → feeds

/** Config `feeds` → a checked list. A bad entry is named and dropped, never guessed at. */
export function normalizeFeeds(league, { log = () => {} } = {}) {
  const out = [];
  for (const [i, raw] of (league.feeds ?? []).entries()) {
    const feed = typeof raw === 'string' ? { code: raw } : (raw ?? {});
    const code = String(feed.code ?? feed.lrcode ?? '').trim();
    const kind = slug(feed.kind ?? feed.type ?? 'results');
    if (!code) { log(`[fulltime] ${league.key}: feed ${i} skipped — no snippet code`); continue; }
    if (!/^[\w-]+$/.test(code)) { log(`[fulltime] ${league.key}: feed ${i} skipped — "${code}" is not a snippet code`); continue; }
    if (!FEED_KINDS[kind]) {
      log(`[fulltime] ${league.key}: feed ${code} skipped — unknown kind "${kind}" (${Object.keys(FEED_KINDS).join(', ')})`);
      continue;
    }
    out.push({
      code,
      kind,
      carries: FEED_KINDS[kind],
      team: String(feed.team ?? '').trim(),
      competition: String(feed.competition ?? feed.division ?? '').trim(),
      label: `${kind}/${code}`,
    });
  }
  return out;
}

/** The request for one snippet. Every part of it is overridable from config, because every
    part of it is an assumption until one real code has been through it. */
export function feedUrl(feed, league = {}) {
  const endpoint = String(league.endpoint ?? DEFAULT_ENDPOINT);
  if (league.urlTemplate) {
    return String(league.urlTemplate)
      .replaceAll('{endpoint}', endpoint)
      .replaceAll('{code}', encodeURIComponent(feed.code))
      .replaceAll('{kind}', encodeURIComponent(feed.kind));
  }
  const param = String(league.codeParam ?? 'lrcode');
  const sep = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${sep}${param}=${encodeURIComponent(feed.code)}`;
}

// --------------------------------------------------------------------------- the payload

/**
 * Three shapes a loader of this kind can answer with, and nothing else.
 * @returns {{ shape: 'json'|'jsonp'|'html', data: any }}
 * @throws if the body is none of them — a half-read feed is worse than no feed.
 */
export function parsePayload(text) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('empty response');

  if (body[0] === '{' || body[0] === '[') {
    return { shape: 'json', data: JSON.parse(body) };
  }
  // JSONP (`cb({…})`) or an assignment (`var feed = {…};`) — the embed is a <script>, so
  // either is plausible and both carry the same JSON.
  const wrapped = /^[\w$.[\]'"]+\s*\(\s*([\s\S]*?)\s*\)\s*;?\s*$/.exec(body)
    ?? /^(?:var|let|const)?\s*[\w$.]+\s*=\s*([\s\S]*?);?\s*$/.exec(body);
  if (wrapped) {
    const inner = wrapped[1].trim();
    if (inner[0] === '{' || inner[0] === '[') return { shape: 'jsonp', data: JSON.parse(inner) };
  }
  if (/<t(?:able|body|r)[\s>]/i.test(body)) {
    return { shape: 'html', data: tablesFromHtml(body) };
  }
  throw new Error(`unrecognised payload (${body.length} bytes, starts "${body.slice(0, 40).replace(/\s+/g, ' ')}")`);
}

/** Every `<table>` in the markup as `{ headers, rows }`, rows keyed by header. */
export function tablesFromHtml(html) {
  const tables = String(html).match(/<table[\s\S]*?<\/table>/gi) ?? [];
  return tables.map((table) => {
    const trs = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    const cells = trs.map((tr) => (tr.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) ?? []).map(plainText));
    if (!cells.length) return { headers: [], rows: [] };
    // The header row is the one with <th> in it; failing that, the first row.
    const headIdx = trs.findIndex((tr) => /<th[\s>]/i.test(tr));
    const h = headIdx >= 0 ? headIdx : 0;
    const headers = cells[h].map((c, i) => key(c) || `c${i}`);
    const rows = cells
      .filter((_, i) => i !== h)
      .filter((row) => row.some((c) => c))
      .map((row) => Object.fromEntries(row.map((c, i) => [headers[i] ?? `c${i}`, c])));
    return { headers, rows };
  }).filter((t) => t.rows.length);
}

/** Does this header row describe a league table rather than a list of matches? */
export function looksLikeStandings(headers = []) {
  const h = new Set(headers);
  const has = (...names) => names.some((n) => h.has(n));
  return has('pts', 'points') && has('p', 'played', 'pl') && has('team', 'club', 'name');
}

/** The rows a feed is actually about, whatever it wrapped them in. */
export function rowsFrom(parsed, { standings = false } = {}) {
  if (parsed.shape === 'html') {
    const tables = parsed.data;
    const match = tables.find((t) => looksLikeStandings(t.headers) === standings) ?? tables[0];
    return match?.rows ?? [];
  }
  const data = parsed.data;
  if (Array.isArray(data)) return data.filter((r) => r && typeof r === 'object');
  const named = pick(data, [
    standings ? 'standings' : 'results',
    standings ? 'table' : 'fixtures',
    'rows', 'matches', 'games', 'events', 'items', 'data', 'feed', 'd',
  ]);
  if (Array.isArray(named)) return named.filter((r) => r && typeof r === 'object');
  // One level deeper: `{ data: { results: [...] } }`.
  for (const v of Object.values(data ?? {})) {
    if (Array.isArray(v) && v.some((r) => r && typeof r === 'object')) return v.filter((r) => r && typeof r === 'object');
    if (v && typeof v === 'object') {
      const inner = rowsFrom({ shape: 'json', data: v }, { standings });
      if (inner.length) return inner;
    }
  }
  return [];
}

// ------------------------------------------------------------------------------- the date

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Local wall-clock time in `tz` → an instant. Two passes, because the first guess is off
    by whatever the offset is, and an hour's correction can itself cross a DST boundary. */
export function zonedToIso({ year, month, day, hour = 0, minute = 0 }, tz = 'Europe/London') {
  let ms = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i += 1) {
    const f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ms));
    const p = Object.fromEntries(f.map(({ type, value }) => [type, value]));
    const seen = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    const drift = Date.UTC(year, month - 1, day, hour, minute) - seen;
    if (!drift) break;
    ms += drift;
  }
  return new Date(ms).toISOString();
}

/**
 * A grassroots date, as published, in the club's own timezone.
 *
 * British leagues write `07/11/2026`, so the first number is the day — getting that wrong
 * silently moves half the season. `Date.parse` is not used for the slashed forms for
 * exactly that reason.
 *
 * @returns {{ iso: string, kickoffKnown: boolean } | null} — null when there is no
 *   readable date, which per trust rule 1 means the row cannot be shown at all.
 */
export function parseFixtureDate(date, time, tz = 'Europe/London') {
  const text = plainText(date).replace(/^[a-z]{3,9}[,\s]+/i, '').trim();  // drop a leading "Sat"
  if (!text) return null;

  let parts = null;
  let timeInText = false;  // an ISO-ish date that carried its own kick-off
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2}))?/.exec(text))) {
    // ISO. If it carries a zone, it is already an instant and we keep it as one.
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) && !Number.isNaN(Date.parse(text))) {
      return { iso: new Date(text).toISOString(), kickoffKnown: m[4] !== undefined };
    }
    parts = { year: +m[1], month: +m[2], day: +m[3], hour: m[4] ? +m[4] : 0, minute: m[5] ? +m[5] : 0 };
    if (m[4] !== undefined) timeInText = true;
  } else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(text))) {
    const year = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    parts = { year, month: +m[2], day: +m[1], hour: 0, minute: 0 };
  } else if ((m = /^(\d{1,2})\s+([a-z]{3,9})\.?\s+(\d{2,4})/i.exec(text))) {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    if (!month) return null;
    const year = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    parts = { year, month, day: +m[1], hour: 0, minute: 0 };
  } else {
    return null;
  }
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return null;

  // Kick-off, if the feed published one. "14:00", "2.30pm", "19.45".
  const t = /(\d{1,2})[:.](\d{2})\s*(am|pm)?/i.exec(plainText(time) || (timeInText ? text : ''));
  let kickoffKnown = false;
  if (t) {
    let hour = +t[1];
    if (/pm/i.test(t[3] ?? '') && hour < 12) hour += 12;
    if (/am/i.test(t[3] ?? '') && hour === 12) hour = 0;
    if (hour <= 23 && +t[2] <= 59) { parts.hour = hour; parts.minute = +t[2]; kickoffKnown = true; }
  }
  // No published kick-off: sit the match at midday local so no timezone arithmetic can
  // shunt it onto the day before, and tell the screen not to print a time we invented.
  if (!kickoffKnown) parts.hour = 12;

  return { iso: zonedToIso(parts, tz), kickoffKnown };
}

// ------------------------------------------------------------------------- rows → events

const SCORE = /^\s*(\d{1,2})\s*[-–:v]\s*(\d{1,2})\s*$/i;

/** A result cell: "3 - 2", or two separate score fields, or nothing yet. */
export function readScore(row) {
  let home = pick(row, ['homeScore', 'homeGoals', 'scoreHome', 'hs', 'homescore']);
  let away = pick(row, ['awayScore', 'awayGoals', 'scoreAway', 'as', 'awayscore']);
  if (home === undefined && away === undefined) {
    const cell = plainText(pick(row, ['score', 'result', 'ft', 'fulltime', 'scoreline']) ?? '');
    const m = SCORE.exec(cell);
    if (m) { home = m[1]; away = m[2]; }
  }
  const n = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return { home: n(home), away: n(away) };
}

const side = (name, score) => ({ name: String(name || 'TBC'), short: String(name || 'TBC'), abbr: '', logo: '', score });

/**
 * One feed's rows → display events.
 *
 * Statuses go through `normalizeStatus` from the manual source, so the grassroots words a
 * league actually publishes — postponed, abandoned, waterlogged, walkover — land on the
 * four statuses the display sorts on, with the league's own wording kept in `statusText`.
 * A fifth status value would scramble the display order; see `sortEvents` in ../store.js.
 */
export function eventsFromRows(rows, feed, league, { tz = 'Europe/London', log = () => {} } = {}) {
  const out = [];
  for (const [i, row] of rows.entries()) {
    const home = plainText(pick(row, ['home', 'homeTeam', 'homeTeamName', 'hometeamname', 'h']) ?? '');
    const away = plainText(pick(row, ['away', 'awayTeam', 'awayTeamName', 'awayteamname', 'a', 'opposition', 'opponents']) ?? '');
    if (!home || !away) { log(`[fulltime] ${league.key}/${feed.label} row ${i}: skipped — no two teams in it`); continue; }

    const when = parseFixtureDate(
      pick(row, ['date', 'matchDate', 'koDate', 'kickOffDate', 'start', 'day', 'fixtureDate']),
      pick(row, ['time', 'kickOff', 'ko', 'koTime', 'kickOffTime', 'start']),
      tz,
    );
    // Trust rule 1. An undated row cannot be dated on screen, cannot be ordered against
    // the others and cannot count towards form — so it is left out, out loud.
    if (!when) {
      log(`[fulltime] ${league.key}/${feed.label} row ${i}: skipped — no readable date (${home} v ${away})`);
      continue;
    }

    const score = readScore(row);
    const rawStatus = plainText(pick(row, ['status', 'state', 'matchStatus', 'result']) ?? '')
      || (feed.kind === 'fixtures' ? 'scheduled' : score.home !== null ? 'final' : '');
    const { status, statusText, awaitingResult, unknown } = normalizeStatus(rawStatus, {
      homeScore: score.home, awayScore: score.away,
      // The league's own words, kept as written, whenever it gave us any.
      statusText: plainText(pick(row, ['statusText', 'note', 'comment', 'notes', 'reason']) ?? '') || undefined,
    });
    // Unplaceable wording is reported rather than quietly normalised: this log is how we
    // learn the vocabulary a real league uses, and what to add to STATUS_WORDS.
    if (unknown) {
      log(`[fulltime] ${league.key}/${feed.label} row ${i}: status "${rawStatus}" matched nothing known — shown as ${status}, wording kept`);
    }

    out.push({
      id: `${league.key}:${slug(when.iso.slice(0, 10))}:${slug(home)}-v-${slug(away)}`,
      league: league.key,
      leagueName: league.name ?? league.key,
      start: when.iso,
      kickoffKnown: when.kickoffKnown,
      status,
      statusText,
      awaitingResult,
      competition: plainText(pick(row, ['competition', 'division', 'comp', 'league']) ?? '') || feed.competition,
      team: feed.team,
      home: side(home, status === 'scheduled' ? null : score.home),
      away: side(away, status === 'scheduled' ? null : score.away),
      venue: plainText(pick(row, ['venue', 'ground', 'pitch', 'location']) ?? ''),
      feed: feed.code,
    });
  }
  return out;
}

/**
 * The same match often arrives twice — once from the side's own feed (which knows it was
 * the Reserves) and once from the division feed (which doesn't). Two copies would show up
 * twice around the division and count twice towards form, so they merge: a played result
 * beats a listed fixture, and anything known beats anything blank.
 */
export function mergeEvents(events) {
  const byMatch = new Map();
  for (const ev of events) {
    const prev = byMatch.get(ev.id);
    if (!prev) { byMatch.set(ev.id, ev); continue; }
    const scored = (e) => e.home.score !== null && e.away.score !== null;
    const better = scored(ev) && !scored(prev) ? ev : prev;
    const other = better === ev ? prev : ev;
    byMatch.set(ev.id, {
      ...other, ...better,
      team: better.team || other.team,
      competition: better.competition || other.competition,
      venue: better.venue || other.venue,
      statusText: better.statusText || other.statusText,
      kickoffKnown: better.kickoffKnown || other.kickoffKnown,
    });
  }
  return [...byMatch.values()];
}

/** A table feed's rows → the standings payload the wall's table slide reads. */
export function standingsFromRows(rows, feed, league) {
  const kept = rows
    .map((row, i) => normalizeRow(row, i))
    .filter((row) => row.team && row.team !== 'TBC' && row.points !== null);
  if (!kept.length) return null;
  return normalizeStandings(
    { name: feed.competition || league.name || league.key, rows: kept },
    { ...league, name: league.name ?? league.key },
  );
}

// ------------------------------------------------------------------------------- the read

/** Per-league, per-feed memory of the last read. Module-level so the weekly clock survives
    the store's ten-minute refresh loop, which knows nothing about any of this. */
const cache = new Map();
export function resetFulltimeCache() { cache.clear(); }

async function readFeed(feed, league, { fetchImpl, tz, log }) {
  const url = feedUrl(feed, league);
  const res = await fetchImpl(url, {
    headers: { accept: '*/*', 'user-agent': 'PitchTribe-Signage/1.0 (+https://pitchtribe.co.uk)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const parsed = parsePayload(await res.text());
  if (feed.carries === 'standings') {
    const standings = standingsFromRows(rowsFrom(parsed, { standings: true }), feed, league);
    if (!standings) throw new Error(`no table rows in a ${parsed.shape} payload`);
    return { shape: parsed.shape, standings, events: [] };
  }
  const events = eventsFromRows(rowsFrom(parsed, { standings: false }), feed, league, { tz, log });
  if (!events.length) throw new Error(`no readable matches in a ${parsed.shape} payload`);
  return { shape: parsed.shape, standings: null, events };
}

/**
 * @param league  config entry: { key, name, source: 'fulltime', feeds[], club?, refreshHours? }
 * @param opts    { fetchImpl, log, now, tz } — the store's fetch and logger
 *
 * Throws only when there is nothing at all to show: no codes configured, or every feed
 * failed and none has ever succeeded. The store then keeps the last good payload on screen
 * and records the error, which is what the brief asks for — stale but dated, never blank.
 */
export async function fetchFulltime(league, { fetchImpl = fetch, log = () => {}, now = new Date(), tz } = {}) {
  const feeds = normalizeFeeds(league, { log });
  if (!feeds.length) {
    throw new Error(`no snippet codes configured — the league issues them from Media → Code snippets, see FULL_TIME.md`);
  }

  const zone = tz ?? league.timezone ?? 'Europe/London';
  const refreshMs = Math.max(1, Number(league.refreshHours ?? DEFAULT_REFRESH_HOURS)) * HOUR;
  const retryMs = Math.max(1, Number(league.retryHours ?? DEFAULT_RETRY_HOURS)) * HOUR;
  const at = now.getTime();

  let state = cache.get(league.key);
  if (!state) { state = new Map(); cache.set(league.key, state); }

  for (const feed of feeds) {
    const entry = state.get(feed.code) ?? {};
    // One read a week per feed, and at worst one retry an hour after a failure. This is
    // the politeness the route decision was bought with, so it is not negotiable here.
    const wait = entry.error ? retryMs : refreshMs;
    if (entry.triedAt && at - entry.triedAt < wait) continue;

    try {
      const value = await readFeed(feed, league, { fetchImpl: fetchImpl ?? fetch, tz: zone, log });
      state.set(feed.code, { ...entry, triedAt: at, readAt: at, error: null, value });
    } catch (err) {
      // Keep whatever this feed last gave us; the table does not vanish because the
      // results feed's code expired.
      state.set(feed.code, { ...entry, triedAt: at, error: err.message });
      log(`[fulltime] ${league.key}/${feed.label}: ${err.message}${entry.value ? ' — keeping the last good read' : ''}`);
    }
  }

  const live = feeds.map((feed) => ({ feed, entry: state.get(feed.code) ?? {} }));
  const good = live.filter(({ entry }) => entry.value);
  if (!good.length) {
    const why = live.map(({ feed, entry }) => `${feed.label}: ${entry.error ?? 'not read'}`).join('; ');
    throw new Error(`no feed could be read (${why})`);
  }

  const events = mergeEvents(good.flatMap(({ entry }) => entry.value.events));
  const standings = good.map(({ entry }) => entry.value.standings).filter(Boolean).at(-1) ?? null;
  const readAt = Math.min(...good.map(({ entry }) => entry.readAt));

  return {
    key: league.key,
    name: league.name ?? league.key,
    club: normalizeClub(league.club),
    credit: String(league.credit ?? CREDIT),
    standings,
    events,
    // What was read, when, and what broke — so a half-working wall can say so rather than
    // look complete. `fetchedAt` on the league is the store's; this is per feed.
    feeds: live.map(({ feed, entry }) => ({
      code: feed.code, kind: feed.kind, team: feed.team, competition: feed.competition,
      readAt: entry.readAt ? new Date(entry.readAt).toISOString() : null,
      shape: entry.value?.shape ?? null,
      error: entry.error ?? null,
    })),
    readAt: Number.isFinite(readAt) ? new Date(readAt).toISOString() : null,
    partial: good.length < feeds.length,
  };
}
