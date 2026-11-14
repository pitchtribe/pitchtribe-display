// The club's own results, fixtures and league table from a local JSON file — the source
// for grassroots teams no public feed covers. Edit the file and the next refresh picks it
// up; nothing is fetched, so it works with the broadband down.
//
// This is also the source PitchTribe v1 ships on (board decision, 14 November 2026) while
// the sanctioned Full-Time feed waits for its snippet codes — see ../../FULL_TIME.md.
//
// File format (every field optional unless marked):
//   {
//     "name": "Bedfordshire County League",     // league name shown on slides
//     "club": "Caldecote FC",                   // or { "name": …, "aliases": [...] } — which side is "us"
//     "credit": "Results from the league's published results",
//     "events": [{
//       "id": "1xi-2026-11-07",
//       "start": "2026-11-07T14:00:00Z",        // REQUIRED — a result with no date is not shown
//       "status": "final",                      // a word from STATUS_WORDS below, or a whole phrase
//                                               // ("Postponed — pitch unplayable") — both are read
//       "statusText": "Postponed — pitch unplayable",   // the league's own words, kept as written
//       "competition": "Premier Division",
//       "team": "First XI",                     // which of the club's sides
//       "home": "Caldecote FC", "away": "Cranfield United",
//       "homeScore": 3, "awayScore": 2,
//       "venue": "Harvey Close"
//     }],
//     "standings": {
//       "name": "Premier Division",
//       "updated": "2026-11-08",
//       "rows": [{ "position": 1, "team": "…", "played": 11, "won": 8, "drawn": 2, "lost": 1,
//                  "goalsFor": 29, "goalsAgainst": 12, "points": 26, "note": "−3 points deducted" }]
//     }
//   }
import { readFile } from 'node:fs/promises';

/** The four statuses the rest of the subsystem sorts and renders on. */
export const CORE_STATUSES = new Set(['scheduled', 'live', 'final', 'postponed']);

/**
 * Grassroots results are messier than a scoreline: postponed, abandoned, waterlogged,
 * walkover, a cup tie the league doesn't carry. The display sorts on exactly four
 * statuses (STATUS_ORDER in ../store.js), so every one of these words maps onto one of
 * the four and the league's own wording rides along in `statusText`.
 *
 * `awaiting` is the honest placeholder: the match was played, the volunteer secretary
 * has not published the score yet. It is not a fifth status — it sorts as `scheduled`
 * and sets `awaitingResult`, because inventing a 0–0 would break trust rule 1.
 */
export const STATUS_WORDS = {
  final: 'final', played: 'final', result: 'final', ft: 'final', 'full-time': 'final', fulltime: 'final',
  walkover: 'final', awarded: 'final',
  scheduled: 'scheduled', fixture: 'scheduled', upcoming: 'scheduled', unplayed: 'scheduled', tbc: 'scheduled',
  live: 'live', inprogress: 'live', 'in-progress': 'live', playing: 'live', ko: 'live',
  postponed: 'postponed', 'called-off': 'postponed', cancelled: 'postponed', canceled: 'postponed',
  abandoned: 'postponed', waterlogged: 'postponed', frozen: 'postponed', void: 'postponed',
  awaiting: 'awaiting', pending: 'awaiting', 'result-to-follow': 'awaiting', 'to-follow': 'awaiting',
};

/**
 * When a league writes the whole phrase in the status cell — "Postponed — pitch
 * unplayable", which the brief holds up as a *good* slide — no single word matches, so the
 * phrase is read word by word. Several of the four can be mentioned in one phrase
 * ("Fixture postponed", "Played — result to follow"), so the one that wins is the one that
 * says something happened to the match, in this order. A bare "scheduled" is the thing any
 * other word overrides, which is why it is last.
 */
const PHRASE_ORDER = ['postponed', 'awaiting', 'live', 'final', 'scheduled'];

const slug = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');

/** Every known status word this phrase mentions, matched on whole words only — so "void"
    is found in "match void by committee" but not in "avoided". */
function wordsIn(raw) {
  const tokens = String(raw ?? '').toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
  const found = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    // Up to three tokens joined, because some keys are hyphenated: "called-off",
    // "in-progress", "result-to-follow".
    for (let n = 1; n <= 3 && i + n <= tokens.length; n += 1) {
      const mapped = STATUS_WORDS[tokens.slice(i, i + n).join('-')];
      if (mapped) found.add(mapped);
    }
  }
  return found;
}
const sentence = (s) => {
  const words = String(s ?? '').trim().replace(/[-_]+/g, ' ');
  return words ? words[0].toUpperCase() + words.slice(1) : '';
};
const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Map one league's wording onto a core status.
 *
 * @returns {{ status: string, statusText: string, awaitingResult: boolean, unknown: boolean }}
 *   `unknown` is true when the league's wording matched nothing we know, so the caller can
 *   log the phrase. That log is how we find out what a real league actually writes.
 */
export function normalizeStatus(raw, { homeScore = null, awayScore = null, statusText } = {}) {
  const word = slug(raw) || 'scheduled';
  const scored = homeScore !== null && awayScore !== null;

  let mapped = STATUS_WORDS[word];
  let phrase = false;
  if (!mapped) {
    const found = wordsIn(raw);
    mapped = PHRASE_ORDER.find((s) => found.has(s));
    phrase = Boolean(mapped);
  }
  // Nothing recognised. A published score is still a published score, so it is shown as a
  // result with the league's own words beside it — hiding data the league did publish
  // would be its own breach of trust rule 1. With no score there is nothing to show but
  // the fixture.
  const unknown = !mapped;
  if (unknown) mapped = scored ? 'final' : 'scheduled';

  // A "final" with no score on it is not a result, it is a result we don't have yet.
  const awaitingResult = mapped === 'awaiting' || (mapped === 'final' && !scored);
  const status = awaitingResult ? 'scheduled' : mapped;

  let text = statusText;
  if (!text) {
    // A phrase, or wording we could not place, is kept exactly as the league wrote it —
    // trust rule 3. Only our own single-word vocabulary gets tidied into a caption.
    if (phrase || (unknown && slug(raw))) text = String(raw).trim();
    else if (awaitingResult) text = 'Result to follow';
    else if (status === 'final') text = word === 'walkover' || word === 'awarded' ? sentence(word) : 'FT';
    else if (status === 'postponed') text = sentence(word);
    else text = '';
  }
  return { status, statusText: text, awaitingResult, unknown };
}

const side = (name, score) => ({
  name: String(name ?? 'TBC'),
  short: String(name ?? 'TBC'),
  abbr: '',
  logo: '',
  score: num(score),
});

/** `club` may be a plain name or `{ name, aliases }`. */
export function normalizeClub(club) {
  if (!club) return null;
  if (typeof club === 'string') return { name: club, aliases: [] };
  return {
    name: String(club.name ?? ''),
    aliases: (club.aliases ?? []).map(String).filter(Boolean),
  };
}

/** One table row, tolerant of the short column names leagues publish (P, W, D, L, F, A, Pts). */
export function normalizeRow(row = {}, i = 0) {
  const goalsFor = num(row.goalsFor ?? row.for ?? row.f);
  const goalsAgainst = num(row.goalsAgainst ?? row.against ?? row.a);
  const gd = num(row.goalDifference ?? row.gd);
  return {
    position: num(row.position ?? row.pos) ?? i + 1,
    team: String(row.team ?? row.name ?? 'TBC'),
    played: num(row.played ?? row.p),
    won: num(row.won ?? row.w),
    drawn: num(row.drawn ?? row.d),
    lost: num(row.lost ?? row.l),
    goalsFor,
    goalsAgainst,
    goalDifference: gd ?? (goalsFor !== null && goalsAgainst !== null ? goalsFor - goalsAgainst : null),
    points: num(row.points ?? row.pts),
    // The league's own footnote for this row, e.g. "−3 points deducted". Never computed.
    note: row.note ? String(row.note) : '',
  };
}

export function normalizeStandings(standings, league) {
  if (!standings) return null;
  const rows = (standings.rows ?? standings.table ?? []).map(normalizeRow);
  if (!rows.length) return null;
  return {
    name: String(standings.name ?? league.name ?? league.key),
    updated: standings.updated ?? standings.updatedAt ?? null,
    rows,
  };
}

/**
 * @param league  config entry: { key, name, source: 'manual', file, club? }
 * @param opts    { log } — the store's logger; a bad row is reported, never guessed at
 */
export async function fetchManual(league, { log = () => {} } = {}) {
  const data = JSON.parse(await readFile(league.file, 'utf8'));
  const name = league.name ?? data.name ?? league.key;
  const events = [];

  (data.events ?? []).forEach((ev, i) => {
    const id = `${league.key}:${ev.id ?? i}`;
    const homeScore = num(ev.homeScore);
    const awayScore = num(ev.awayScore);
    const { status, statusText, awaitingResult, unknown } = normalizeStatus(ev.status, {
      homeScore, awayScore, statusText: ev.statusText,
    });
    if (unknown) {
      log(`[manual] ${id}: status "${ev.status}" matched nothing known — shown as ${status}, wording kept as written`);
    }

    // Trust rule 1: every result carries its date. An undated row cannot be dated on
    // screen, cannot be ordered against the others and cannot count towards form — so
    // it is left out, and said out loud in the log rather than dropped silently.
    const start = ev.start ? new Date(ev.start) : null;
    if (!start || Number.isNaN(start.getTime())) {
      log(`[manual] ${id}: skipped — "start" is missing or unreadable (every result carries its date)`);
      return;
    }

    events.push({
      id,
      league: league.key,
      leagueName: name,
      start: start.toISOString(),
      status,
      statusText,
      awaitingResult,
      competition: String(ev.competition ?? ev.comp ?? ''),
      team: String(ev.team ?? ''),
      home: side(ev.home, status === 'scheduled' ? null : homeScore),
      away: side(ev.away, status === 'scheduled' ? null : awayScore),
      venue: String(ev.venue ?? ''),
    });
  });

  return {
    key: league.key,
    name,
    club: normalizeClub(league.club ?? data.club),
    credit: String(league.credit ?? data.credit ?? ''),
    standings: normalizeStandings(data.standings, { ...league, name }),
    events,
  };
}
