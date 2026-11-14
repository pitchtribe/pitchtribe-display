// The clubhouse wall: turns one club's snapshot into a loop of single-idea slides.
//
// Everything here is a pure function of (snapshot, config, now) plus a list of photo
// filenames, so the whole loop is testable without a browser or a television. The HTML
// lives in clubhouse-render.js; the rules about what may appear on screen live here.
//
// Three rules from the brief are enforced in this file, not in the markup:
//   1. Every result carries its date.
//   2. Nothing is ever interpolated — an unpublished result says so ("Result to follow").
//   3. Grassroots states survive the trip: the league's own words are shown as written.

const DAY = 86_400_000;
// Exported because clubhouse-render.js ships the pure helpers below to the browser as
// their own source text, so the card keeps its own hours and countdown offline without
// a second copy of the rules living in the page.
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PHOTO_TYPES = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);

/** Local calendar parts in `tz` — the clubhouse's clock, not the server's. */
export function zoneParts(date, tz = 'Europe/London') {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS.indexOf(p.weekday),
    dateKey: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** "Saturday 7 November", the way the room says it. */
export function longDate(iso, tz = 'Europe/London') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

export function kickoffTime(iso, tz = 'Europe/London') {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

// ------------------------------------------------------------------ which side is us
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * A test for "is this one of our sides". Deliberately a prefix-ish contains on the club
 * name so "Caldecote FC", "Caldecote FC Reserves" and "Caldecote FC 'A'" all match one
 * config line; add `aliases` for anything that doesn't share the name.
 */
export function clubMatcher(club) {
  const names = [club?.name ?? club, ...(club?.aliases ?? [])].map(norm).filter(Boolean);
  return (name) => {
    const n = norm(name);
    return !!n && names.some((c) => n.includes(c));
  };
}

/** Our side, their side, and which end of the ground we were at. */
export function sides(event, isUs) {
  const weAreHome = isUs(event.home.name);
  const us = weAreHome ? event.home : event.away;
  const them = weAreHome ? event.away : event.home;
  return { us, them, homeAway: weAreHome ? 'home' : 'away' };
}

export function outcome(event, isUs) {
  const { us, them } = sides(event, isUs);
  if (us.score === null || them.score === null) return null;
  if (us.score > them.score) return 'W';
  if (us.score < them.score) return 'L';
  return 'D';
}

// --------------------------------------------------------------------- the selectors
const involvesUs = (isUs) => (e) => isUs(e.home.name) || isUs(e.away.name);
const played = (e) => e.status === 'final' && e.home.score !== null && e.away.score !== null;

/**
 * Our results from the last `withinDays` — the heartbeat. Newest first.
 * Anything older is archive, and an archive result on screen reads as this week's.
 */
export function ourResults(events, isUs, { now = new Date(), withinDays = 9, limit = 3 } = {}) {
  const floor = now.getTime() - withinDays * DAY;
  return events
    .filter(involvesUs(isUs))
    .filter(played)
    .filter((e) => Date.parse(e.start) >= floor && Date.parse(e.start) <= now.getTime())
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
    .slice(0, limit);
}

/**
 * Our matches called off around now — a good slide, in the league's own words.
 *
 * Bounded at both ends. A postponement that was meant to be played in March is not news
 * in November, and with only a floor the earliest one in the file would hold a slide all
 * season.
 */
export function ourCalledOff(events, isUs, { now = new Date(), withinDays = 9, limit = 2 } = {}) {
  const floor = now.getTime() - withinDays * DAY;
  const ceiling = now.getTime() + withinDays * DAY;
  return events
    .filter(involvesUs(isUs))
    .filter((e) => e.status === 'postponed' && Date.parse(e.start) >= floor && Date.parse(e.start) <= ceiling)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, limit);
}

/** Played, but the league hasn't published it. Never guessed at. */
export function ourAwaiting(events, isUs, { now = new Date(), withinDays = 9, limit = 2 } = {}) {
  const floor = now.getTime() - withinDays * DAY;
  return events
    .filter(involvesUs(isUs))
    .filter((e) => e.awaitingResult && Date.parse(e.start) <= now.getTime() && Date.parse(e.start) >= floor)
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
    .slice(0, limit);
}

/** The next fixture for each of our sides, soonest first. */
export function ourNext(events, isUs, { now = new Date(), limit = 2 } = {}) {
  const upcoming = events
    .filter(involvesUs(isUs))
    .filter((e) => e.status === 'scheduled' && !e.awaitingResult && Date.parse(e.start) > now.getTime())
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const seen = new Set();
  const out = [];
  for (const e of upcoming) {
    const key = e.team || '';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/** Last five, oldest to newest — the whole point of keeping a season in the file. */
export function form(events, isUs, { team = null, limit = 5, now = new Date() } = {}) {
  const recent = events
    .filter(involvesUs(isUs))
    .filter(played)
    .filter((e) => Date.parse(e.start) <= now.getTime())
    .filter((e) => team === null || (e.team || '') === team)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(-limit);
  return recent.map((e) => ({ mark: outcome(e, isUs), start: e.start, id: e.id }));
}

/** The sides that actually played, in the order they first appear. */
export function teams(events, isUs, { now = new Date() } = {}) {
  const out = [];
  for (const e of events.filter(involvesUs(isUs))) {
    if (Date.parse(e.start) > now.getTime()) continue;
    const key = e.team || '';
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** Our row plus `around` either side — never a twenty-row grid. */
export function tableWindow(standings, isUs, { around = 2 } = {}) {
  if (!standings?.rows?.length) return null;
  const rows = standings.rows;
  const i = rows.findIndex((r) => isUs(r.team));
  const size = around * 2 + 1;
  let from = i < 0 ? 0 : Math.max(0, i - around);
  if (i >= 0) from = Math.min(from, Math.max(0, rows.length - size));
  const window = rows.slice(from, from + size).map((r) => ({ ...r, us: isUs(r.team) }));
  return { name: standings.name, updated: standings.updated, rows: window, found: i >= 0 };
}

/** Everyone else's results — the only genuinely new thing midweek, and the bar argument. */
export function divisionResults(events, isUs, { now = new Date(), withinDays = 9 } = {}) {
  const floor = now.getTime() - withinDays * DAY;
  return events
    .filter((e) => !involvesUs(isUs)(e))
    .filter(played)
    .filter((e) => Date.parse(e.start) >= floor && Date.parse(e.start) <= now.getTime())
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
}

// ---------------------------------------------------------------------- the countdown
/** Days until the coming Saturday in `tz`; 0 on Saturday itself. */
export function daysToSaturday(now = new Date(), tz = 'Europe/London') {
  const { weekday } = zoneParts(now, tz);
  return (6 - weekday + 7) % 7;
}

export function countdownWords(days) {
  if (days === 0) return { lead: 'Today', tail: 'is matchday' };
  if (days === 1) return { lead: 'Tomorrow', tail: 'is matchday' };
  return { lead: String(days), tail: days === 1 ? 'day to Saturday' : 'days to Saturday' };
}

// ------------------------------------------------------------------- opening hours
/**
 * Opening hours as the card keeps them (never the television):
 *   { "sat": [["12:00", "23:30"]], "tue": [["19:00", "23:00"]] }
 * A window may cross midnight. Missing day = closed all day. No hours at all = always
 * open, which is the wrong answer for a clubhouse but the right one for a test bench.
 */
export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return Math.min(h * 60 + min, 1440);
}

export function isOpen(hours, now = new Date(), tz = 'Europe/London') {
  if (!hours || !Object.keys(hours).length) return true;
  const { weekday, minutes } = zoneParts(now, tz);
  const windows = (day) => (hours[DAY_KEYS[day]] ?? []).map(([a, b]) => [toMinutes(a), toMinutes(b)])
    .filter(([a, b]) => a !== null && b !== null);

  for (const [open, close] of windows(weekday)) {
    if (close > open && minutes >= open && minutes < close) return true;
    if (close <= open && minutes >= open) return true; // runs past midnight
  }
  // Last night's window still running into this morning.
  const yesterday = (weekday + 6) % 7;
  for (const [open, close] of windows(yesterday)) {
    if (close <= open && minutes < close) return true;
  }
  return false;
}

// ------------------------------------------------------------------------- the photos
/** Deterministic shuffle: same day, same order; next day, a different wall. */
export function seededShuffle(list, seed) {
  let s = 0;
  for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function isPhotoName(name) {
  const dot = String(name).lastIndexOf('.');
  return dot > 0 && PHOTO_TYPES.has(String(name).slice(dot).toLowerCase());
}

/**
 * A dozen of the pool, reshuffled daily. Indifferent to how many arrive: twelve photos
 * and four hundred photos run the same code — four hundred just means Wednesday looks
 * nothing like Sunday.
 */
export function pickPhotos(files, { dateKey = '', count = 12 } = {}) {
  const pool = files.filter(isPhotoName).sort();
  if (!pool.length) return [];
  return seededShuffle(pool, dateKey).slice(0, Math.max(1, count));
}

// -------------------------------------------------------------------------- the loop
const chunk = (list, n) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

/** Weave the photographs through the football so the loop never reads as two halves. */
export function interleave(data, photos) {
  const out = [];
  const max = Math.max(data.length, photos.length);
  for (let i = 0; i < max; i += 1) {
    if (i < data.length) out.push(data[i]);
    if (i < photos.length) out.push(photos[i]);
  }
  return out;
}

/**
 * Build the loop.
 *
 * @param snapshot  Store.snapshot()
 * @param config    full server config; `config.clubhouse` holds this screen's settings
 * @param opts      { now, photoFiles }
 */
export function buildClubhouse(snapshot, config = {}, { now = new Date(), photoFiles = [] } = {}) {
  const ch = config.clubhouse ?? {};
  const tz = config.timezone ?? 'Europe/London';
  const league = snapshot.leagues.find((l) => l.key === ch.league) ?? snapshot.leagues[0] ?? null;
  const club = ch.club ? { name: ch.club, aliases: ch.aliases ?? [] } : league?.club ?? null;
  const isUs = clubMatcher(club ?? { name: '' });
  const events = league?.events ?? [];
  const title = ch.name ?? club?.name ?? config.title ?? 'The Club';

  const data = [];

  // 1 — the heartbeat: what happened on Saturday, dated, one slide each.
  for (const e of ourResults(events, isUs, { now })) {
    const { us, them, homeAway } = sides(e, isUs);
    data.push({
      kind: 'result',
      date: longDate(e.start, tz),
      competition: e.competition || e.leagueName || '',
      team: e.team || '',
      us: us.name, them: them.name, homeAway,
      ourScore: us.score, theirScore: them.score,
      mark: outcome(e, isUs),
      statusText: e.statusText || 'FT',
    });
  }

  // 2 — the honest placeholder, and the league's own words for a called-off match.
  for (const e of ourAwaiting(events, isUs, { now })) {
    const { them, homeAway } = sides(e, isUs);
    data.push({
      kind: 'awaiting',
      date: longDate(e.start, tz),
      competition: e.competition || e.leagueName || '',
      team: e.team || '',
      them: them.name, homeAway,
    });
  }
  for (const e of ourCalledOff(events, isUs, { now })) {
    const { them, homeAway } = sides(e, isUs);
    data.push({
      kind: 'calledoff',
      date: longDate(e.start, tz),
      competition: e.competition || e.leagueName || '',
      team: e.team || '',
      them: them.name, homeAway,
      statusText: e.statusText || 'Postponed',
    });
  }

  // 3 — next Saturday: the most-read slide in the building on a Thursday.
  for (const e of ourNext(events, isUs, { now })) {
    const { them, homeAway } = sides(e, isUs);
    data.push({
      kind: 'next',
      date: longDate(e.start, tz),
      // A feed that published no kick-off time gets none printed. Midday is where an
      // undated-time match is parked so the calendar day can't slip; it is not 12:00 KO.
      kickoff: e.kickoffKnown === false ? '' : kickoffTime(e.start, tz),
      competition: e.competition || e.leagueName || '',
      team: e.team || '',
      them: them.name, homeAway,
      venue: homeAway === 'away' ? e.venue || '' : '',
    });
  }

  // 4 — the table, five rows of it.
  const table = tableWindow(league?.standings, isUs);
  if (table) data.push({ kind: 'table', ...table, updatedLabel: longDate(table.updated, tz) });

  // 5 — form, per side that has played.
  for (const team of teams(events, isUs, { now })) {
    const marks = form(events, isUs, { team, now });
    if (marks.length < 2) continue; // one game is not form
    data.push({ kind: 'form', team, marks: marks.map((m) => m.mark) });
  }

  // 6 — around the division, four at a time.
  for (const group of chunk(divisionResults(events, isUs, { now }), 4)) {
    data.push({
      kind: 'division',
      name: league?.standings?.name ?? league?.name ?? '',
      results: group.map((e) => ({
        home: e.home.name, away: e.away.name,
        homeScore: e.home.score, awayScore: e.away.score,
        date: longDate(e.start, tz),
      })),
    });
  }

  // 7 — whose screen this is, and the week's rhythm if the club typed one in.
  data.push({
    kind: 'identity',
    name: title,
    strapline: ch.strapline ?? '',
    badge: ch.badge ? 'badge' : '',
  });
  if (ch.rhythm?.length) data.push({ kind: 'rhythm', lines: ch.rhythm.map(String).slice(0, 4) });

  // 8 — the countdown, whose face changes every day because the date does.
  const days = daysToSaturday(now, tz);
  data.push({ kind: 'countdown', days, ...countdownWords(days) });

  const photos = pickPhotos(photoFiles, {
    dateKey: zoneParts(now, tz).dateKey,
    count: Number(ch.photosPerLoop) || 12,
  }).map((file) => ({ kind: 'photo', file }));

  return {
    title,
    tz,
    hours: ch.openingHours ?? null,
    colours: {
      primary: ch.colours?.primary ?? '#1b4d9b',
      ink: ch.colours?.ink ?? '#ffffff',
      accent: ch.colours?.accent ?? '#ffd34d',
    },
    credit: league?.credit ?? '',
    source: {
      league: league?.key ?? null,
      fetchedAt: league?.fetchedAt ?? null,
      error: league?.error ?? null,
      updatedAt: snapshot.updatedAt ?? null,
    },
    slides: interleave(data, photos),
  };
}
