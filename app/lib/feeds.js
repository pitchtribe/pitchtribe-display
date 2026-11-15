'use strict';
/* Embeds the signage-server engine (../signage-server, an ES module) in the app:
   sports fixtures/scores plus widgets (weather, jokes, quiz, history…).
   - Configured from dashboard settings (settings.sports, settings.widgets).
   - Its routes (display page, JSON API, SSE, widgets, MCP) are served at /feeds.
   - "Live scores" and widget slides get their data from here, inlined in screen
     manifests; when that data changes, screens are told to refetch.
   - One club's wall (GET /feeds/clubhouse) comes from a club file on the card
     rather than from the dashboard: see `clubFile` below and CLUBHOUSE.md. */
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const LEAGUE_KEY_RE = /^[\w.-]{1,40}$/;
const SHOW = {
  all: undefined,
  live: 'live',
  results: 'final',
  fixtures: 'scheduled,postponed',
};

class Feeds extends EventEmitter {
  constructor({ fetchImpl, log = console.error, publicUrl = '', clubFile = '' } = {}) {
    super();
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.publicUrl = publicUrl;
    // The club's own wall config, if this card has one. A file and not a dashboard
    // setting on purpose: one club, one card, typed in once at install (CLUBHOUSE.md).
    this.clubFile = clubFile;
    this.club = null;
    this.service = null;
    this.lib = null;
    this.catalog = [];
    this.widgetKinds = [];
    this.sportsOn = false;
    this.pending = null; // settings waiting for the module to load
    this.ready = import('pitchtribe-signage-server').then((lib) => {
      this.lib = lib;
      // Dashboard offers the feed-backed leagues; club fixtures are a "Fixtures" slide in the app.
      this.catalog = lib
        .exampleConfig()
        .leagues.filter((l) => (l.source ?? 'espn') === 'espn')
        .map(({ key, name, path, source }) => ({ key, name, path, source: source ?? 'espn' }));
      this.widgetKinds = lib.WIDGET_KINDS;
      if (this.pending) this.configure(...this.pending);
    });
    this.ready.catch((err) => log('[feeds] failed to load the signage-server engine:', err));
  }

  /**
   * The club file, re-read on every configure so dropping a new one in and
   * restarting is the whole job. A missing file is the normal case — most cards
   * are playlist players, not one club's wall — so it is not an error. A broken
   * one is: it is said out loud and the card carries on without the wall, because
   * a dashboard that will not start is worse than a wall that is not configured.
   */
  loadClub() {
    if (!this.clubFile) return null;
    let raw;
    try {
      raw = fs.readFileSync(this.clubFile, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`[feeds] cannot read ${this.clubFile}: ${err.message}`);
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.log(`[feeds] ${this.clubFile} is not valid JSON, so the clubhouse wall stays unconfigured: ${err.message}`);
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.clubhouse) {
      this.log(`[feeds] ${this.clubFile} has no "clubhouse" section, so the clubhouse wall stays unconfigured`);
      return null;
    }
    // Its own leagues — the `manual` club file, or a `fulltime` feed — keyed like the rest.
    const leagues = (Array.isArray(parsed.leagues) ? parsed.leagues : []).filter(
      (l) => l && typeof l.key === 'string' && LEAGUE_KEY_RE.test(l.key),
    );
    return { ...parsed, leagues };
  }

  /** (Re)start the engine for these settings. */
  configure({ sports = {}, widgets = {}, title = 'PitchTribe' } = {}) {
    if (!this.lib) {
      this.pending = [{ sports, widgets, title }];
      return;
    }
    this.pending = null;
    if (this.service) this.service.stop();
    const club = (this.club = this.loadClub());
    const feedLeagues = sports.enabled ? this.catalog.filter((l) => (sports.leagues || []).includes(l.key)) : [];
    this.sportsOn = feedLeagues.length > 0;
    // The card's own file wins on a key collision: it is this club's screen.
    const clubKeys = new Set((club?.leagues ?? []).map((l) => l.key));
    const leagues = [...(club?.leagues ?? []), ...feedLeagues.filter((l) => !clubKeys.has(l.key))];
    const config = this.lib.resolveConfig(
      {
        title,
        // The wall's dates, hours and countdown are the clubhouse's local time, so
        // the club file's timezone wins over the dashboard's when there is one.
        timezone: club?.timezone || sports.timezone || 'Europe/London',
        leagues,
        pushTargets: [],
        apiToken: '', // the app checks credentials before requests reach the engine
        publicUrl: this.publicUrl,
        weather: widgets.weather || null,
        widgets: { wikipedia: widgets.wikipedia !== false, trains: widgets.trains || null, bods: widgets.bods || null },
        clubhouse: club?.clubhouse ?? null,
        ...(club?.refreshMinutes ? { refreshMinutes: club.refreshMinutes } : {}),
        ...(club?.liveRefreshSeconds ? { liveRefreshSeconds: club.liveRefreshSeconds } : {}),
      },
      // Relative paths in the club file — the season file, the photo pool, the badge —
      // resolve against the file itself, not against the installed package.
      this.clubFile ? { baseDir: path.dirname(this.clubFile) } : undefined,
    );
    const opts = { config, log: (...a) => this.log('[feeds]', ...a) };
    if (this.fetchImpl) opts.fetchImpl = this.fetchImpl;
    this.service = this.lib.createSignageService(opts);
    this.service.store.on('update', () => this.emit('update', 'sports'));
    this.service.widgets.on('update', () => this.emit('update', 'widgets'));
    // Any league at all needs the refresh loop: without it the club file is never
    // read and the wall shows the countdown and nothing else.
    if (leagues.length > 0) this.service.start();
    this.service.widgets.prefetch();
    this.emit('update', 'config');
  }

  /**
   * True when this card is one club's wall rather than a playlist player — that is, when a
   * club file was found *and* parsed *and* had a `clubhouse` section in it.
   *
   * Nothing in the dashboard reads this yet; it exists so that "did the club file take?"
   * is one question with one answer, asked by the tests and by anyone debugging a card
   * that came up showing the wrong screen. Reaching into `feeds.club` to work it out again
   * is how two slightly different definitions of "configured" start to disagree.
   */
  get clubhouseOn() {
    return Boolean(this.club?.clubhouse);
  }

  /** Express-style handler for /feeds/*. */
  handle(req, res) {
    if (!this.service) {
      res.status(503).json({ error: 'Starting up — try again in a moment' });
      return;
    }
    this.service.handler(req, res);
  }

  // ---------------------------------------------------------------- sports
  /** Events for a "Live scores" slide, trimmed to what the player draws; null when sports are off. */
  events({ leagues = [], show = 'all', limit = 10 } = {}) {
    if (!this.service || !this.sportsOn) return null;
    const list = this.service.store.query({
      league: leagues.length ? leagues.join(',') : undefined,
      status: SHOW[show],
      limit,
    });
    return list.map((e) => ({
      id: e.id,
      league: e.league,
      leagueName: e.leagueName,
      start: e.start,
      status: e.status,
      statusText: e.statusText,
      home: { name: e.home.short || e.home.name, logo: e.home.logo, score: e.home.score },
      away: { name: e.away.short || e.away.name, logo: e.away.logo, score: e.away.score },
    }));
  }

  /** Per-league status for the dashboard. */
  status() {
    if (!this.service || !this.sportsOn) return [];
    return this.service.store.snapshot().leagues.map((l) => ({
      key: l.key,
      name: l.name,
      events: l.events.length,
      live: l.events.filter((e) => e.status === 'live').length,
      fetchedAt: l.fetchedAt,
      error: l.error,
    }));
  }

  refresh() {
    // Not gated on `sportsOn`: a club card has no dashboard leagues at all, and
    // "refresh now" has to re-read its club file like any other source.
    if (!this.service || this.service.config.leagues.length === 0) return Promise.resolve(null);
    return this.service.store.refresh();
  }

  // --------------------------------------------------------------- widgets
  /** Widget data right now (cached/bundled); starts any live fetch in the background. */
  widget(kind, opts) {
    if (!this.service) return { error: 'Starting up…' };
    try {
      return this.service.widgets.peek(kind, opts);
    } catch (err) {
      return { error: err.message };
    }
  }

  geocode(q) {
    if (!this.service) return Promise.resolve([]);
    return this.service.widgets.geocode(q);
  }

  close() {
    if (this.service) this.service.stop();
    this.service = null;
  }
}

module.exports = { Feeds, LEAGUE_KEY_RE, SHOW_OPTIONS: Object.keys(SHOW) };
