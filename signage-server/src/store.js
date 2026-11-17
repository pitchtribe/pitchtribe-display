import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { fetchEspn } from './sources/espn.js';
import { fetchManual } from './sources/manual.js';
import { fetchFulltime } from './sources/fulltime.js';

const SOURCES = { espn: fetchEspn, manual: fetchManual, fulltime: fetchFulltime };
const STATUS_ORDER = { live: 0, final: 1, scheduled: 2, postponed: 3 };

/**
 * Holds the latest fixtures/results for every configured league, refreshes them on a
 * schedule (faster while games are live) and emits 'update' when anything changes.
 */
export class Store extends EventEmitter {
  constructor(config, { fetchImpl = fetch, log = console.error } = {}) {
    super();
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.leagues = new Map(); // key -> { key, name, events, standings, club, credit, error, fetchedAt }
    this.updatedAt = null;
    this.hash = '';
    this.timer = null;
    this.inflight = null;
  }

  /** Refresh all leagues (or one). Concurrent calls share the same in-flight refresh. */
  refresh(onlyKey) {
    if (!onlyKey && this.inflight) return this.inflight;
    const run = this.#refresh(onlyKey).finally(() => { if (!onlyKey) this.inflight = null; });
    if (!onlyKey) this.inflight = run;
    return run;
  }

  async #refresh(onlyKey) {
    const targets = this.config.leagues.filter((l) => !onlyKey || l.key === onlyKey);
    if (onlyKey && !targets.length) throw new Error(`Unknown league "${onlyKey}"`);
    // `refreshMinutes` is one timer for every league, tuned for live professional scores.
    // A source that must be read less often than that (the Full-Time feed: once a week, by
    // the terms the route decision was bought with) keeps its own clock and returns its
    // cached payload in between. See src/sources/fulltime.js.
    const opts = {
      fetchImpl: this.fetchImpl, daysBack: this.config.daysBack, daysAhead: this.config.daysAhead,
      tz: this.config.timezone, log: this.log,
    };

    await Promise.all(targets.map(async (league) => {
      const source = SOURCES[league.source ?? 'espn'];
      const prev = this.leagues.get(league.key);
      try {
        if (!source) throw new Error(`Unknown source "${league.source}"`);
        const result = await source(league, opts);
        this.leagues.set(league.key, { ...result, error: null, fetchedAt: new Date().toISOString() });
      } catch (err) {
        this.log(`[store] ${league.key}: ${err.message}`);
        // Keep the last good data on screen; just record the error.
        this.leagues.set(league.key, {
          key: league.key, name: league.name ?? league.key, events: prev?.events ?? [],
          standings: prev?.standings ?? null, club: prev?.club ?? null, credit: prev?.credit ?? '',
          fetchedAt: prev?.fetchedAt ?? null, error: err.message,
        });
      }
    }));

    const snap = this.snapshot();
    // The table counts as data: a league that only reshuffled its standings has still
    // changed, and a screen showing last week's table has to be told to redraw.
    const hash = createHash('sha1')
      .update(JSON.stringify(snap.leagues.map((l) => [l.key, l.events, l.standings ?? null])))
      .digest('hex');
    const changed = hash !== this.hash;
    this.hash = hash;
    this.updatedAt = new Date().toISOString();
    if (changed) this.emit('update', this.snapshot());
    return { changed, snapshot: this.snapshot() };
  }

  /** Ordered list of leagues (config order) with their events sorted for display. */
  snapshot() {
    const leagues = this.config.leagues
      .map((l) => this.leagues.get(l.key))
      .filter(Boolean)
      .map((l) => ({ ...l, events: sortEvents(l.events) }));
    return { updatedAt: this.updatedAt, title: this.config.title, leagues };
  }

  /** Filter events across leagues. */
  query({ league, status, team, limit } = {}) {
    const statuses = status ? String(status).split(',') : null;
    const leagues = league ? String(league).split(',') : null;
    const needle = team ? String(team).toLowerCase() : null;
    let events = this.snapshot().leagues
      .filter((l) => !leagues || leagues.includes(l.key))
      .flatMap((l) => l.events)
      .filter((e) => !statuses || statuses.includes(e.status))
      .filter((e) => !needle || [e.home.name, e.away.name, e.home.abbr, e.away.abbr]
        .some((n) => n && n.toLowerCase().includes(needle)));
    events = sortEvents(events);
    if (limit) events = events.slice(0, Number(limit));
    return events;
  }

  hasLive() {
    return [...this.leagues.values()].some((l) => l.events.some((e) => e.status === 'live'));
  }

  /** Start the polling loop: liveRefreshSeconds while anything is live, else refreshMinutes. */
  start() {
    const tick = async () => {
      try { await this.refresh(); } catch (err) { this.log(`[store] refresh failed: ${err.message}`); }
      const delay = this.hasLive()
        ? this.config.liveRefreshSeconds * 1000
        : this.config.refreshMinutes * 60_000;
      this.timer = setTimeout(tick, delay);
      this.timer.unref?.();
    };
    return tick();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Live first, then most recent results, then soonest fixtures, then postponed.
    An unrecognised status sorts last rather than making the comparator NaN — one
    `undefined - number` is enough to scramble the whole display order. */
export function sortEvents(events) {
  const rank = (e) => STATUS_ORDER[e?.status] ?? Object.keys(STATUS_ORDER).length;
  return [...events].sort((a, b) => {
    const s = rank(a) - rank(b);
    if (s) return s;
    const ta = Date.parse(a.start) || 0;
    const tb = Date.parse(b.start) || 0;
    return a.status === 'final' ? tb - ta : ta - tb;
  });
}
