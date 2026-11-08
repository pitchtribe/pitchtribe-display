'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const express = require('express');

const { Store, newId } = require('./store');
const { Hub } = require('./hub');
const { DEFAULT_PORTAL, renderSplash, themeCss } = require('./portal-page');
const { readPortalFiles } = require('./portal');
const { mountBackupRoutes } = require('./backup-routes');
const { mountRemoteAccessRoutes } = require('./remote-access-routes');
const { Feeds, LEAGUE_KEY_RE, SHOW_OPTIONS } = require('./feeds');
const auth = require('./auth');
const v = require('./validate');
const pkg = require('../package.json');
const i18n = require('../public/shared/i18n.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** Uploadable media: MIME type -> [asset type, file extension]. */
const MEDIA_TYPES = {
  'image/jpeg': ['image', '.jpg'],
  'image/png': ['image', '.png'],
  'image/gif': ['image', '.gif'],
  'image/webp': ['image', '.webp'],
  'image/avif': ['image', '.avif'],
  'image/svg+xml': ['image', '.svg'],
  'video/mp4': ['video', '.mp4'],
  'video/webm': ['video', '.webm'],
  'video/quicktime': ['video', '.mov'],
};

const ASSET_TYPES = ['image', 'video', 'url', 'notice', 'menu', 'fixtures', 'scores', 'widget'];
const TEXT_TYPES = ['url', 'notice', 'menu', 'fixtures', 'scores', 'widget'];
const WIDGET_KINDS = ['clock', 'worldclock', 'weather', 'joke', 'phrase', 'trivia', 'quiz', 'history', 'emoji', 'geoquiz', 'country', 'spotball',
  'transport', 'bankholiday', 'floods', 'carbon', 'quakes', 'currency', 'potd', 'births', 'sky', 'headlines', 'events'];
const CURRENCIES = ['AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR'];
const TOPICS = ['sport', 'film-tv', 'music', 'geography', 'culture', 'mixed'];
const WIDGET_DURATION = { clock: 15, worldclock: 15, weather: 15, joke: 14, phrase: 10, trivia: 12, quiz: 20, history: 18, emoji: 16, geoquiz: 16, country: 14, spotball: 20,
  transport: 20, bankholiday: 12, floods: 12, carbon: 14, quakes: 14, currency: 12, potd: 15, births: 15, sky: 12, headlines: 18, events: 18 };
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const GRID = { cols: 10, rows: 8 };
const DEFAULT_DURATION = { image: 10, video: 0, url: 30, notice: 12, menu: 20, fixtures: 15, scores: 15, widget: 15 };
const NOTICE_STYLES = ['default', 'accent', 'amber', 'alert', 'light'];
const ROTATIONS = [0, 90, 180, 270];
const MAX_SCREENS = 200;
const ONLINE_MS = 2.5 * 60 * 1000;

function lanUrls(port) {
  const urls = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}${port === 80 ? '' : `:${port}`}/`);
    }
  }
  return urls;
}

function createApp(opts = {}) {
  const dataDir = path.resolve(opts.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const mediaDir = path.join(dataDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const maxUploadBytes = Number(opts.maxUploadMb ?? process.env.MAX_UPLOAD_MB ?? 1024) * 1024 * 1024;
  const port = Number(opts.port ?? process.env.PORT ?? 8080);

  const store = new Store(path.join(dataDir, 'db.json'));
  const hub = new Hub();
  const limiter = new auth.LoginLimiter();
  store.on('change', (revision) => hub.broadcast('changed', { revision }));

  // signage-server engine (sports + widgets), configured from dashboard settings.
  const feeds = new Feeds({
    fetchImpl: opts.feedsFetch || opts.sportsFetch,
    log: opts.log || console.error,
    publicUrl: `${(lanUrls(port)[0] || `http://localhost:${port}/`).replace(/\/$/, '')}/feeds`,
  });
  const configureFeeds = () =>
    feeds.configure({
      sports: store.data.settings.sports,
      widgets: store.data.settings.widgets,
      title: store.data.settings.clubName || 'PitchTribe',
    });
  configureFeeds();
  // New scores: screens refetch their manifest (live-score slides carry the data).
  // New scores / weather: screens refetch their manifest (those slides carry the data).
  feeds.on('update', (source) => hub.broadcast('changed', { revision: store.data.revision, feeds: source }));

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

  // ---------- Security headers ----------
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    if (req.path.startsWith('/player')) {
      // Screens may embed arbitrary web pages (the "Web page" content type).
      res.set(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: https:; media-src 'self'; frame-src 'self' http: https:; object-src 'none'; base-uri 'none'"
      );
    } else if (req.path.startsWith('/feeds')) {
      // The engine's display page uses inline styles/script and remote team logos.
      res.set(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
      );
    } else if (!req.path.startsWith('/media/')) {
      res.set({
        'Content-Security-Policy':
          "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
        'X-Frame-Options': 'SAMEORIGIN',
      });
    }
    next();
  });

  // ---------- Signage-server engine at /feeds (sports now, widgets too) ----------
  // GET routes (display page, JSON, SSE) are open on the LAN like the player.
  // POST routes (refresh, push, MCP) need the sports API token or a dashboard login.
  app.use('/feeds', (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      const token = store.data.settings.sports?.apiToken || '';
      const given = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const tokenOk =
        token && given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
      const sessionOk = isAuthed(req) && req.get('x-pitchtribe') === '1';
      if (!tokenOk && !sessionOk) {
        res.set('WWW-Authenticate', 'Bearer').status(401).json({ error: 'Unauthorized' });
        return;
      }
    }
    feeds.handle(req, res);
  });

  app.use(express.json({ limit: '1mb' }));

  // ---------- Helpers ----------
  const data = () => store.data;
  const findOr404 = (list, id, what) => {
    const item = list.find((x) => x.id === id);
    if (!item) throw new v.HttpError(404, `${what} not found`);
    return item;
  };
  const route = (fn) => (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out && typeof out.then === 'function') out.catch(next);
    } catch (err) {
      next(err);
    }
  };

  function isAuthed(req) {
    const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
    return Boolean(data().settings.adminHash) && auth.verifyToken(token, data().settings.sessionSecret);
  }

  /** Dashboard API guard. Mutations also need a custom header, which a
      cross-site form or <img> can't send (CSRF defence alongside SameSite). */
  function requireAuth(req, res, next) {
    if (!isAuthed(req)) return res.status(401).json({ error: 'Please sign in' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-pitchtribe') !== '1') {
      return res.status(403).json({ error: 'Missing request header' });
    }
    next();
  }

  const publicSettings = () => {
    const s = data().settings;
    return { clubName: s.clubName, defaultPlaylistId: s.defaultPlaylistId, language: s.language || 'en' };
  };

  function sportsView() {
    const s = data().settings.sports;
    return {
      enabled: s.enabled,
      leagues: s.leagues,
      timezone: s.timezone,
      apiToken: s.apiToken,
      running: feeds.sportsOn,
      catalog: feeds.catalog.map(({ key, name }) => ({ key, name })),
      status: feeds.status(),
    };
  }

  function widgetsView() {
    const w = data().settings.widgets;
    return { weather: w.weather, wikipedia: w.wikipedia, trains: w.trains || null, bods: w.bods || null, kinds: feeds.widgetKinds };
  }

  const screenView = (s) => ({
    ...s,
    online: hub.isConnected(s.id) || Date.now() - (s.lastSeen || 0) < ONLINE_MS,
  });

  // ---------- Content model ----------
  function sanitizeAsset(type, body, existing = {}) {
    const a = {
      name: v.str(body.name ?? existing.name, { max: 120, required: true, field: 'Name' }),
      duration: v.int(body.duration ?? existing.duration, {
        min: type === 'video' ? 0 : 1,
        max: 86400,
        fallback:
          type === 'widget'
            ? WIDGET_DURATION[(body.content && body.content.kind) || (existing.content && existing.content.kind)] || 15
            : DEFAULT_DURATION[type],
      }),
    };
    if (type === 'image' || type === 'video') {
      a.fit = v.oneOf(body.fit ?? existing.fit, ['contain', 'cover'], 'contain');
    }
    if (type === 'video') a.muted = v.bool(body.muted, existing.muted ?? true);
    if (type === 'url') a.url = v.httpUrl(body.url ?? existing.url);

    const c = { ...(existing.content || {}), ...(body.content || {}) };
    if (type === 'notice') {
      a.content = {
        title: v.str(c.title, { max: 200, field: 'Title' }),
        body: v.str(c.body, { max: 3000, field: 'Message' }),
        style: v.oneOf(c.style, NOTICE_STYLES, 'default'),
      };
      if (!a.content.title && !a.content.body) throw v.bad('A notice needs a title or a message');
    }
    if (type === 'menu') {
      a.content = {
        title: v.str(c.title, { max: 200, field: 'Title' }),
        text: v.str(c.text, { max: 20000, field: 'Menu' }),
      };
    }
    if (type === 'fixtures') {
      a.content = {
        title: v.str(c.title, { max: 200, field: 'Title' }),
        text: v.str(c.text, { max: 50000, field: 'Fixtures' }),
        limit: v.int(c.limit, { min: 1, max: 20, fallback: 8 }),
      };
    }
    if (type === 'widget') a.content = sanitizeWidget(c);
    if (type === 'scores') {
      const leagues = Array.isArray(c.leagues) ? c.leagues.filter((k) => typeof k === 'string' && LEAGUE_KEY_RE.test(k)) : [];
      a.content = {
        title: v.str(c.title, { max: 200, field: 'Title' }),
        leagues: [...new Set(leagues)].slice(0, 30),
        show: v.oneOf(c.show, SHOW_OPTIONS, 'all'),
        limit: v.int(c.limit, { min: 1, max: 30, fallback: 10 }),
      };
    }
    return a;
  }

  function num(value, min, max, fallback) {
    const n = Number(value);
    if (value === '' || value == null || !Number.isFinite(n)) return fallback;
    return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
  }

  function sanitizeWidget(c) {
    const kind = v.oneOf(c.kind, WIDGET_KINDS, null);
    if (!kind) throw v.bad('Choose a widget');
    const w = { kind, title: v.str(c.title, { max: 200, field: 'Title' }) };
    if (kind === 'clock') {
      w.mode = v.oneOf(c.mode, ['digital', 'analog', 'countdown'], 'digital');
      w.showDate = v.bool(c.showDate, true);
      w.target = DATETIME_RE.test(c.target || '') ? c.target : '';
      w.label = v.str(c.label, { max: 120, field: 'Countdown label' });
      if (w.mode === 'countdown' && !w.target) throw v.bad('Set the date and time to count down to');
    }
    if (kind === 'weather') w.days = v.int(c.days, { min: 0, max: 6, fallback: 3 });
    if (kind === 'quiz' || kind === 'trivia') w.topic = v.oneOf(c.topic, TOPICS, 'sport');
    if (kind === 'quiz') w.source = v.oneOf(c.source, ['bundled', 'opentdb'], 'bundled');
    if (kind === 'transport') {
      const sections = (Array.isArray(c.sections) ? c.sections : []).filter((x) => ['tracker', 'trains', 'buses', 'lines', 'roads', 'planes'].includes(x));
      if (!sections.length) throw v.bad('Choose at least one thing to show');
      w.sections = [...new Set(sections)];
      w.station = /^[A-Za-z]{3}$/.test(c.station || '') ? c.station.toUpperCase() : '';
      if (w.sections.includes('trains') && !w.station) throw v.bad('Enter the 3-letter station code (e.g. BIW for Biggleswade)');
      w.busStop = /^[A-Za-z0-9]{4,20}$/.test(c.busStop || '') ? c.busStop : '';
      if (w.sections.includes('buses') && !w.busStop) throw v.bad('Enter the TfL bus stop ID');
      w.busStopName = v.str(c.busStopName, { max: 60, field: 'Stop name' });
      w.modes = (Array.isArray(c.modes) ? c.modes : ['tube', 'elizabeth-line', 'overground', 'dlr']).filter((m) => ['tube', 'overground', 'dlr', 'elizabeth-line'].includes(m));
      w.planesRadius = v.int(c.planesRadius, { min: 2, max: 100, fallback: 15 });
      w.trackLines = [...new Set((Array.isArray(c.trackLines) ? c.trackLines : String(c.trackLines || '').split(/[\s,]+/))
        .map((l) => String(l).trim().toUpperCase()).filter((l) => /^[A-Z0-9]{1,8}$/.test(l)))].slice(0, 6);
      if (w.sections.includes('tracker') && !w.trackLines.length) throw v.bad('Enter the bus route numbers to track');
      w.trackOperator = /^[A-Za-z0-9]{2,8}$/.test(c.trackOperator || '') ? c.trackOperator.toUpperCase() : '';
      w.trackRadius = v.int(c.trackRadius, { min: 2, max: 60, fallback: 20 });
      w.trackTitle = v.str(c.trackTitle, { max: 80, field: 'Tracker heading' });
    }
    if (kind === 'bankholiday') {
      w.division = v.oneOf(c.division, ['england-and-wales', 'scotland', 'northern-ireland'], 'england-and-wales');
      w.limit = v.int(c.limit, { min: 1, max: 8, fallback: 4 });
    }
    if (kind === 'floods') w.radius = v.int(c.radius, { min: 1, max: 100, fallback: 15 });
    if (kind === 'carbon') {
      const pc = String(c.postcode || '').toUpperCase().replace(/\s+/g, '');
      if (pc && !/^[A-Z]{1,2}\d[A-Z\d]?$/.test(pc)) throw v.bad('Use the first half of a postcode, e.g. SG18');
      w.postcode = pc;
    }
    if (kind === 'quakes') {
      w.feed = v.oneOf(c.feed, ['significant_week', '4.5_week', '4.5_day', '2.5_day'], '4.5_week');
      w.limit = v.int(c.limit, { min: 1, max: 10, fallback: 6 });
    }
    if (kind === 'currency') {
      w.base = v.oneOf(c.base, CURRENCIES, 'GBP');
      w.symbols = [...new Set((Array.isArray(c.symbols) ? c.symbols : ['EUR', 'USD']).filter((x) => CURRENCIES.includes(x) && x !== w.base))].slice(0, 8);
      if (!w.symbols.length) throw v.bad('Choose at least one currency');
    }
    if (kind === 'births') w.limit = v.int(c.limit, { min: 1, max: 10, fallback: 5 });
    if (kind === 'headlines' || kind === 'events') {
      w.url = v.httpUrl(String(c.url || '').trim().replace(/^webcal:\/\//i, 'https://'));
      w.limit = v.int(c.limit, { min: 1, max: 10, fallback: 6 });
      if (kind === 'events') w.days = v.int(c.days, { min: 1, max: 365, fallback: 60 });
    }
    if (kind === 'emoji') w.category = v.oneOf(c.category, ['all', 'Film', 'TV', 'Song'], 'all');
    if (kind === 'geoquiz') w.mode = v.oneOf(c.mode, ['flags', 'capitals', 'mixed'], 'mixed');
    if (kind === 'worldclock') {
      const zones = (Array.isArray(c.zones) ? c.zones : []).slice(0, 8).map((z) => {
        const tz = v.str(z && z.tz, { max: 60, field: 'Time zone' });
        try {
          new Intl.DateTimeFormat('en-GB', { timeZone: tz });
        } catch {
          throw v.bad(`Unknown time zone: ${tz}`);
        }
        return { label: v.str(z.label, { max: 40, required: true, field: 'City name' }), tz };
      });
      if (!zones.length) throw v.bad('Choose at least one city');
      w.zones = zones;
    }
    if (['joke', 'phrase', 'trivia', 'quiz', 'emoji'].includes(kind)) {
      w.extra = v.str(c.extra, { max: 20000, field: 'Your own lines' });
      w.only = v.bool(c.only, false);
      if (w.only && !w.extra) throw v.bad('Add some lines of your own, or untick “Only show mine”');
    }
    if (kind === 'history') {
      w.scope = v.oneOf(c.scope, ['day', 'week', 'month'], 'day');
      w.topic = v.oneOf(c.topic, ['sport', 'entertainment', 'all'], 'sport');
      w.general = v.bool(c.general, false);
      w.limit = v.int(c.limit, { min: 1, max: 12, fallback: 5 });
    }
    if (kind === 'spotball') {
      const img = data().assets.find((x) => x.id === c.imageId);
      if (!img || img.type !== 'image') throw v.bad('Choose a photo for the game');
      w.imageId = img.id;
      w.x = num(c.x, 0, 100, null);
      w.y = num(c.y, 0, 100, null);
      if (w.x === null || w.y === null) throw v.bad('Tap the photo to mark where the ball is');
      w.radius = num(c.radius, 2, 20, 6);
      w.cover = v.bool(c.cover, true);
      w.grid = v.bool(c.grid, true);
      w.revealAt = DATETIME_RE.test(c.revealAt || '') ? c.revealAt : '';
      w.prize = v.str(c.prize, { max: 200, field: 'Prize' });
    }
    return w;
  }

  const gridCell = (x, y) =>
    `${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.min(GRID.cols - 1, Math.floor((x / 100) * GRID.cols))]}${Math.min(GRID.rows - 1, Math.floor((y / 100) * GRID.rows)) + 1}`;

  /** Spot the ball: the answer only leaves the server once it's revealed. */
  function spotballData(asset, assets) {
    const c = asset.content;
    const img = assets.get(c.imageId);
    if (!img || img.type !== 'image') return { error: 'The photo for this game has been deleted.' };
    const revealed = Boolean(c.revealAt) && Date.now() >= new Date(c.revealAt).getTime();
    let patch = null;
    if (c.cover) {
      // Blur a patch that contains the ball without being centred on it.
      const h = crypto.createHash('sha256').update(asset.id).digest();
      const off = (b) => ((b / 255) - 0.5) * 0.8 * c.radius;
      const clamp = (n) => Math.min(100, Math.max(0, Math.round(n * 100) / 100));
      patch = { x: clamp(c.x + off(h[0])), y: clamp(c.y + off(h[1])), r: Math.round(c.radius * 1.6 * 100) / 100 };
    }
    return {
      src: mediaUrl(img),
      grid: c.grid ? GRID : null,
      patch,
      prize: c.prize,
      revealAt: c.revealAt,
      revealed,
      answer: revealed ? { x: c.x, y: c.y, cell: gridCell(c.x, c.y) } : null,
    };
  }

  /** Live data inlined into a slide (scores, widgets). */
  function slideData(asset, assets) {
    if (asset.type === 'scores') return feeds.events(asset.content);
    if (asset.type !== 'widget') return undefined;
    const c = asset.content;
    if (c.kind === 'spotball') return spotballData(asset, assets);
    if (c.kind === 'clock' || c.kind === 'worldclock') return undefined;
    const { kind, title, ...opts } = c; // every widget option goes to the engine
    return feeds.widget(kind, opts);
  }

  function sanitizePlaylist(body, existing) {
    const assets = new Set(data().assets.map((a) => a.id));
    const items = Array.isArray(body.items) ? body.items : existing.items;
    if (items.length > 500) throw v.bad('Too many items in one playlist');
    return {
      name: v.str(body.name ?? existing.name, { max: 80, required: true, field: 'Playlist name' }),
      showClock: v.bool(body.showClock, existing.showClock ?? true),
      ticker: v.str(body.ticker ?? existing.ticker, { max: 2000, field: 'Ticker' }),
      items: items
        .filter((it) => it && assets.has(it.assetId))
        .map((it) => ({
          id: typeof it.id === 'string' && /^[\w-]{1,32}$/.test(it.id) ? it.id : newId(),
          assetId: it.assetId,
          enabled: v.bool(it.enabled, true),
          duration: it.duration === null || it.duration === '' || it.duration === undefined ? null : v.int(it.duration, { min: 0, max: 86400 }),
          schedule: v.schedule(it.schedule),
        })),
    };
  }

  function mediaUrl(asset) {
    return asset.file ? `/media/${asset.file.filename}` : undefined;
  }

  function buildManifest(playlist, screen) {
    const d = data();
    const assets = new Map(d.assets.map((a) => [a.id, a]));
    const items = [];
    for (const it of playlist ? playlist.items : []) {
      const a = assets.get(it.assetId);
      if (!a || !it.enabled) continue;
      items.push({
        id: it.id,
        assetId: a.id,
        type: a.type,
        name: a.name,
        duration: it.duration ?? a.duration,
        schedule: it.schedule,
        src: mediaUrl(a),
        url: a.url,
        fit: a.fit,
        muted: a.muted,
        content: a.content,
        data: slideData(a, assets),
        updatedAt: a.updatedAt,
      });
    }
    return {
      revision: d.revision,
      generatedAt: new Date().toISOString(),
      clubName: d.settings.clubName || 'PitchTribe',
      language: (screen && screen.language) || d.settings.language || 'en',
      screen: screen ? { id: screen.id, name: screen.name, rotation: screen.rotation || 0 } : null,
      playlist: playlist
        ? { id: playlist.id, name: playlist.name, showClock: playlist.showClock, ticker: playlist.ticker }
        : null,
      items,
      dashboardUrls: lanUrls(port),
    };
  }

  // ---------- Player (screens) — no login, LAN only ----------
  function screenFor(req, { register }) {
    const id = req.params.screenId;
    if (!v.SCREEN_ID_RE.test(id)) throw v.bad('Invalid screen id');
    let screen = data().screens.find((s) => s.id === id);
    if (!screen && register) {
      if (data().screens.length >= MAX_SCREENS) throw new v.HttpError(429, 'Too many screens');
      screen = store.touch(
        (d) => {
          const s = {
            id,
            name: id,
            playlistId: d.settings.defaultPlaylistId,
            rotation: 0,
            createdAt: new Date().toISOString(),
            lastSeen: Date.now(),
          };
          d.screens.push(s);
          return s;
        },
        { immediate: true }
      );
    }
    if (screen) {
      const w = v.int(req.query.w, { min: 0, max: 16384 });
      const h = v.int(req.query.h, { min: 0, max: 16384 });
      store.touch(() => {
        screen.lastSeen = Date.now();
        screen.ip = req.ip;
        screen.userAgent = v.str(req.get('user-agent'), { max: 300 }).slice(0, 300);
        if (w && h) screen.resolution = `${w}×${h}`;
      });
    }
    return screen;
  }

  app.get(
    '/api/player/:screenId/manifest',
    route((req, res) => {
      const screen = screenFor(req, { register: true });
      const playlist = data().playlists.find((p) => p.id === screen.playlistId) || null;
      res.set('Cache-Control', 'no-store').json(buildManifest(playlist, screen));
    })
  );

  app.get(
    '/api/player/:screenId/events',
    route((req, res) => {
      const screen = screenFor(req, { register: false });
      hub.add(req, res, screen ? screen.id : req.params.screenId);
    })
  );

  // ---------- Auth ----------
  app.get('/api/auth/status', (req, res) => {
    const setupRequired = !data().settings.adminHash;
    res.set('Cache-Control', 'no-store').json({
      setupRequired,
      authenticated: isAuthed(req),
      clubName: data().settings.clubName,
      // A freshly flashed card: offer to restore a backup instead of starting again.
      ...(setupRequired ? { restore: backups.setupInfo() } : {}),
    });
  });

  app.post(
    '/api/auth/setup',
    route((req, res) => {
      if (data().settings.adminHash) throw new v.HttpError(409, 'Already set up');
      const clubName = v.str(req.body.clubName, { max: 80, required: true, field: 'Club name' });
      const password = String(req.body.password || '');
      if (password.length < 8) throw v.bad('Password must be at least 8 characters');
      store.mutate((d) => {
        d.settings.clubName = clubName;
        d.settings.adminHash = auth.hashPassword(password);
        const now = new Date().toISOString();
        const welcome = {
          id: newId(),
          type: 'notice',
          name: 'Welcome notice',
          duration: 12,
          content: {
            title: `Welcome to ${clubName}`,
            body: 'This screen is powered by PitchTribe.\nOpen the dashboard to add notices, menus, fixtures, photos and videos.',
            style: 'accent',
          },
          createdAt: now,
          updatedAt: now,
        };
        d.assets.push(welcome);
        const main = {
          id: newId(),
          name: 'Main',
          showClock: true,
          ticker: '',
          items: [{ id: newId(), assetId: welcome.id, enabled: true, duration: null, schedule: v.schedule({}) }],
          createdAt: now,
          updatedAt: now,
        };
        d.playlists.push(main);
        d.settings.defaultPlaylistId = main.id;
        for (const s of d.screens) if (!s.playlistId) s.playlistId = main.id;
      });
      res.set('Set-Cookie', auth.sessionCookie(auth.issueToken(data().settings.sessionSecret), req)).json({ ok: true });
    })
  );

  app.post(
    '/api/auth/login',
    route((req, res) => {
      if (limiter.blocked(req.ip)) throw new v.HttpError(429, 'Too many attempts — wait 15 minutes and try again');
      if (!auth.verifyPassword(req.body.password, data().settings.adminHash)) {
        limiter.fail(req.ip);
        throw new v.HttpError(401, 'Wrong password');
      }
      limiter.reset(req.ip);
      res.set('Set-Cookie', auth.sessionCookie(auth.issueToken(data().settings.sessionSecret), req)).json({ ok: true });
    })
  );

  app.post('/api/auth/logout', (req, res) => {
    res.set('Set-Cookie', auth.clearCookie()).json({ ok: true });
  });

  // ---------- Dashboard API ----------
  const api = express.Router();
  api.use(requireAuth);

  // Backups: USB stick (via the root helper) and download/restore a file.
  const backups = mountBackupRoutes({
    app, api, dataDir, mediaDir, store, version: pkg.version,
    setupRequired: () => !data().settings.adminHash,
    onRestored: () => configureFeeds(),
  });

  // Remote access: switch SSH on or off (via the root helper).
  mountRemoteAccessRoutes({ api, dataDir, limiter, adminHash: () => data().settings.adminHash, hashPassword: opts.hashSshPassword });

  api.get('/state', (req, res) => {
    const d = data();
    res.set('Cache-Control', 'no-store').json({
      version: pkg.version,
      revision: d.revision,
      settings: publicSettings(),
      assets: d.assets.map((a) => ({ ...a, src: mediaUrl(a) })),
      playlists: d.playlists,
      screens: d.screens.map(screenView),
      dashboardUrls: lanUrls(port),
      maxUploadMb: Math.round(maxUploadBytes / 1024 / 1024),
      languages: i18n.LANGUAGES.map(({ code, name }) => ({ code, name })),
      sports: sportsView(),
      widgets: widgetsView(),
    });
  });

  api.put(
    '/settings',
    route((req, res) => {
      const clubName = v.str(req.body.clubName, { max: 80, required: true, field: 'Club name' });
      const defaultPlaylistId = req.body.defaultPlaylistId || null;
      if (defaultPlaylistId) findOr404(data().playlists, defaultPlaylistId, 'Playlist');
      const language = req.body.language === undefined ? data().settings.language : v.oneOf(req.body.language, i18n.codes, 'en');
      const retitle = clubName !== data().settings.clubName;
      store.mutate((d) => {
        d.settings.clubName = clubName;
        d.settings.defaultPlaylistId = defaultPlaylistId;
        d.settings.language = language;
      });
      if (retitle) configureFeeds(); // the engine only uses the club name; keep its caches otherwise
      res.json(publicSettings());
    })
  );

  api.post(
    '/settings/password',
    route((req, res) => {
      if (!auth.verifyPassword(req.body.current, data().settings.adminHash)) throw v.bad('Current password is wrong');
      const next = String(req.body.next || '');
      if (next.length < 8) throw v.bad('New password must be at least 8 characters');
      store.touch(
        (d) => {
          d.settings.adminHash = auth.hashPassword(next);
          d.settings.sessionSecret = crypto.randomBytes(32).toString('hex');
        },
        { immediate: true }
      );
      res.set('Set-Cookie', auth.sessionCookie(auth.issueToken(data().settings.sessionSecret), req)).json({ ok: true });
    })
  );

  api.put(
    '/settings/sports',
    route((req, res) => {
      const known = new Set(feeds.catalog.map((l) => l.key));
      const leagues = Array.isArray(req.body.leagues) ? [...new Set(req.body.leagues.filter((k) => known.has(k)))] : [];
      const timezone = v.str(req.body.timezone || 'Europe/London', { max: 60, field: 'Timezone' });
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
      } catch {
        throw v.bad('Unknown timezone — use a name like Europe/London');
      }
      store.mutate((d) => {
        Object.assign(d.settings.sports, { enabled: v.bool(req.body.enabled, false), leagues, timezone });
      });
      configureFeeds();
      res.json(sportsView());
    })
  );

  api.put(
    '/settings/widgets',
    route((req, res) => {
      let weather = null;
      const wb = req.body.weather;
      if (wb && typeof wb === 'object') {
        const latitude = num(wb.latitude, -90, 90, null);
        const longitude = num(wb.longitude, -180, 180, null);
        if (latitude === null || longitude === null) throw v.bad('Choose a place for the weather');
        weather = {
          place: v.str(wb.place, { max: 120, field: 'Place' }),
          latitude,
          longitude,
          windUnit: v.oneOf(wb.windUnit, ['mph', 'kmh'], 'mph'),
          provider: v.oneOf(wb.provider, ['metno', 'openmeteo'], 'metno'),
        };
      }
      // Keys stay on the server: they never appear in screen manifests.
      const tb = req.body.trains || {};
      const trains = tb.url || tb.token
        ? { url: tb.url ? v.httpUrl(tb.url) : '', token: v.str(tb.token, { max: 200, field: 'Rail token' }) }
        : null;
      const bodsKey = v.str(req.body.bods && req.body.bods.apiKey, { max: 200, field: 'Bus Open Data key' });
      store.mutate((d) => {
        d.settings.widgets = { weather, wikipedia: v.bool(req.body.wikipedia, true), trains, bods: bodsKey ? { apiKey: bodsKey } : null };
      });
      configureFeeds();
      res.json(widgetsView());
    })
  );

  api.get(
    '/geocode',
    route(async (req, res) => {
      try {
        res.json(await feeds.geocode(v.str(req.query.q, { max: 100 })));
      } catch {
        throw new v.HttpError(502, 'Place search needs an internet connection');
      }
    })
  );

  api.post(
    '/settings/sports/token',
    route((req, res) => {
      store.touch((d) => { d.settings.sports.apiToken = crypto.randomBytes(24).toString('base64url'); }, { immediate: true });
      res.json(sportsView());
    })
  );

  api.post(
    '/sports/refresh',
    route(async (req, res) => {
      await feeds.refresh();
      res.json(sportsView());
    })
  );

  // Guest Wi-Fi portal -------------------------------------------------------
  const portalSettings = () => ({ ...DEFAULT_PORTAL, ...(data().settings.portal || {}) });
  const SSID_RE = /^[\x20-\x7e]{1,32}$/;

  /** Network bits for the root helper (pitchtribe-portal-apply), which a systemd
      path unit runs whenever this file changes. */
  function writePortalNetwork(p) {
    const file = path.join(dataDir, 'portal-network.json');
    const net = {
      enabled: p.enabled, ssid: p.ssid, radio: p.radio, band: p.band, channel: p.channel,
      accessPoints: p.accessPoints, downMbps: p.downMbps, upMbps: p.upMbps,
    };
    let old = null;
    try { old = fs.readFileSync(file, 'utf8'); } catch { /* first time */ }
    const next = `${JSON.stringify(net, null, 2)}\n`;
    if (old !== next) {
      fs.writeFileSync(`${file}.tmp`, next);
      fs.renameSync(`${file}.tmp`, file);
    }
  }

  /** What pitchtribe-portal-apply found the last time it ran (portal-hw.js status). */
  function portalHardware() {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'portal-hardware.json'), 'utf8')); } catch { return null; }
  }

  /** Is the guest Wi-Fi helper on this Pi? Without it these settings are saved
      and never applied, and the dashboard has to say so rather than report
      "Saved — the Wi-Fi updates in a few seconds" and leave the club waiting
      for a network that will never appear. Cards built from the PitchTribe
      image have it; a Pi installed by hand only does with PITCHTRIBE_PORTAL=1. */
  const portalApplyBin = opts.portalApplyBin || process.env.PORTAL_APPLY_BIN || '/usr/local/bin/pitchtribe-portal-apply';
  const portalInstalled = () => fs.existsSync(portalApplyBin);

  api.get('/portal', (req, res) => {
    const files = readPortalFiles(dataDir);
    res.set('Cache-Control', 'no-store').json({
      settings: portalSettings(),
      installed: portalInstalled(),
      hardware: portalHardware(),
      stats: { active: files.active, today: files.today, week: files.week, serviceSeenAt: files.serviceSeenAt, days: files.days },
      guests: { count: files.guests.length, consented: files.guests.filter((g) => g.consent).length },
    });
  });

  api.put(
    '/portal',
    route((req, res) => {
      const b = req.body || {};
      const cur = portalSettings();
      const ssid = v.str(b.ssid ?? cur.ssid, { max: 32, required: true, field: 'Network name' });
      if (!SSID_RE.test(ssid)) throw v.bad('Use plain letters, numbers and punctuation for the network name (up to 32)');
      const accent = /^#[0-9a-f]{6}$/i.test(b.accent || '') ? b.accent : cur.accent;
      const logo = b.logoAssetId ? data().assets.find((a) => a.id === b.logoAssetId && a.type === 'image') : null;
      if (b.logoAssetId && !logo) throw v.bad('Choose a logo from your images');
      const band = v.oneOf(String(b.band ?? cur.band), ['2.4', '5'], '2.4');
      const channels = band === '5' ? [36, 40, 44, 48] : [1, 6, 11];
      const radio = v.oneOf(b.radio ?? cur.radio, ['auto', 'builtin', 'usb', 'off'], 'auto');
      const accessPoints = v.bool(b.accessPoints, cur.accessPoints);
      const enabled = v.bool(b.enabled, cur.enabled);
      if (enabled && radio === 'off' && !accessPoints) throw v.bad('Choose a Wi-Fi radio, or switch on ceiling access points — otherwise there is nothing to broadcast the guest Wi-Fi');
      const next = {
        enabled,
        ssid,
        radio,
        band,
        channel: v.oneOf(Number(b.channel ?? cur.channel), channels, channels[band === '5' ? 0 : 1]),
        accessPoints,
        sessionMinutes: v.int(b.sessionMinutes ?? cur.sessionMinutes, { min: 15, max: 1440, fallback: 120 }),
        downMbps: v.int(b.downMbps ?? cur.downMbps, { min: 1, max: 200, fallback: 10 }),
        upMbps: v.int(b.upMbps ?? cur.upMbps, { min: 1, max: 100, fallback: 3 }),
        headline: v.str(b.headline ?? cur.headline, { max: 120, required: true, field: 'Headline' }),
        message: v.str(b.message ?? cur.message, { max: 1000, field: 'Message' }),
        terms: v.str(b.terms ?? cur.terms, { max: 6000, required: true, field: 'Terms of use' }),
        accent,
        logoAssetId: logo ? logo.id : null,
        redirectUrl: b.redirectUrl ? v.httpUrl(b.redirectUrl) : '',
        collectEmail: v.oneOf(b.collectEmail ?? cur.collectEmail, ['off', 'optional', 'required'], 'off'),
        consentText: v.str(b.consentText ?? cur.consentText, { max: 300, required: true, field: 'Consent wording' }),
      };
      store.touch((d) => { d.settings.portal = next; }, { immediate: true });
      writePortalNetwork(next);
      res.json({ settings: next });
    })
  );

  api.get('/portal/guests.csv', (req, res) => {
    const { guests } = readPortalFiles(dataDir);
    const q = (x) => `"${String(x).replace(/"/g, '""')}"`;
    const rows = [['connected_at', 'email', 'marketing_consent'], ...guests.map((g) => [g.at, g.email, g.consent ? 'yes' : 'no'])];
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="wifi-guests.csv"', 'Cache-Control': 'no-store' })
      .send(`${rows.map((r) => r.map(q).join(',')).join('\r\n')}\r\n`);
  });

  api.delete('/portal/guests', (req, res) => {
    fs.rmSync(path.join(dataDir, 'portal-guests.jsonl'), { force: true });
    res.json({ ok: true });
  });

  // Splash preview for the dashboard (same renderer the portal uses).
  api.get('/portal/preview', (req, res) => {
    const p = { ...portalSettings(), ...(req.query.accent && /^#[0-9a-f]{6}$/i.test(req.query.accent) ? { accent: req.query.accent } : {}) };
    const logo = p.logoAssetId ? data().assets.find((a) => a.id === p.logoAssetId) : null;
    res.set('Cache-Control', 'no-store').type('html').send(renderSplash({
      club: data().settings.clubName,
      portal: p,
      logoUrl: logo ? mediaUrl(logo) : null,
      css: ['/portal-assets/portal.css', `/api/portal/theme.css?accent=${encodeURIComponent(p.accent)}`],
      preview: true,
    }));
  });
  api.get('/portal/theme.css', (req, res) => res.type('text/css').send(themeCss(req.query.accent || portalSettings().accent)));

  // Assets ------------------------------------------------------------------
  api.post(
    '/assets/upload',
    route(async (req, res) => {
      const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const kind = MEDIA_TYPES[mime];
      if (!kind) throw new v.HttpError(415, 'Unsupported file type. Use JPG, PNG, GIF, WebP, SVG, MP4, WebM or MOV.');
      const declared = Number(req.get('content-length') || 0);
      if (declared > maxUploadBytes) throw new v.HttpError(413, 'File is too large');
      let originalName = 'Upload';
      try {
        originalName = decodeURIComponent(req.get('x-filename') || 'Upload');
      } catch {
        /* keep default */
      }
      const [type, ext] = kind;
      const id = newId();
      const filename = `${id}${ext}`;
      const final = path.join(mediaDir, filename);
      const tmp = `${final}.part`;
      let size = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          if (size > maxUploadBytes) cb(new v.HttpError(413, 'File is too large'));
          else cb(null, chunk);
        },
      });
      try {
        await pipeline(req, counter, fs.createWriteStream(tmp));
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err.status ? err : new v.HttpError(400, 'Upload interrupted');
      }
      if (size === 0) {
        fs.rmSync(tmp, { force: true });
        throw v.bad('The file is empty');
      }
      fs.renameSync(tmp, final);
      const now = new Date().toISOString();
      const name = originalName.replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 120) || 'Upload';
      const asset = {
        id,
        type,
        ...sanitizeAsset(type, { name, duration: req.query.duration }),
        file: { filename, mime, size, originalName: originalName.slice(0, 200) },
        createdAt: now,
        updatedAt: now,
      };
      store.mutate((d) => d.assets.push(asset));
      res.status(201).json({ ...asset, src: mediaUrl(asset) });
    })
  );

  api.post(
    '/assets',
    route((req, res) => {
      const type = req.body.type;
      if (!TEXT_TYPES.includes(type)) throw v.bad('Unknown content type');
      const now = new Date().toISOString();
      const asset = { id: newId(), type, ...sanitizeAsset(type, req.body), createdAt: now, updatedAt: now };
      const playlistId = req.body.addToPlaylist;
      const playlist = playlistId ? findOr404(data().playlists, playlistId, 'Playlist') : null;
      store.mutate((d) => {
        d.assets.push(asset);
        if (playlist) playlist.items.push({ id: newId(), assetId: asset.id, enabled: true, duration: null, schedule: v.schedule({}) });
      });
      res.status(201).json(asset);
    })
  );

  api.patch(
    '/assets/:id',
    route((req, res) => {
      const asset = findOr404(data().assets, req.params.id, 'Content');
      const next = sanitizeAsset(asset.type, req.body, asset);
      store.mutate(() => Object.assign(asset, next, { updatedAt: new Date().toISOString() }));
      res.json({ ...asset, src: mediaUrl(asset) });
    })
  );

  api.delete(
    '/assets/:id',
    route((req, res) => {
      const asset = findOr404(data().assets, req.params.id, 'Content');
      store.mutate((d) => {
        d.assets = d.assets.filter((a) => a.id !== asset.id);
        for (const p of d.playlists) p.items = p.items.filter((it) => it.assetId !== asset.id);
      });
      if (asset.file) fs.rmSync(path.join(mediaDir, path.basename(asset.file.filename)), { force: true });
      res.json({ ok: true });
    })
  );

  // Playlists ---------------------------------------------------------------
  api.post(
    '/playlists',
    route((req, res) => {
      const now = new Date().toISOString();
      const playlist = {
        id: newId(),
        ...sanitizePlaylist({ ...req.body, items: [] }, { items: [] }),
        createdAt: now,
        updatedAt: now,
      };
      store.mutate((d) => {
        d.playlists.push(playlist);
        if (!d.settings.defaultPlaylistId) d.settings.defaultPlaylistId = playlist.id;
      });
      res.status(201).json(playlist);
    })
  );

  api.put(
    '/playlists/:id',
    route((req, res) => {
      const playlist = findOr404(data().playlists, req.params.id, 'Playlist');
      const next = sanitizePlaylist(req.body, playlist);
      store.mutate(() => Object.assign(playlist, next, { updatedAt: new Date().toISOString() }));
      res.json(playlist);
    })
  );

  api.delete(
    '/playlists/:id',
    route((req, res) => {
      const playlist = findOr404(data().playlists, req.params.id, 'Playlist');
      store.mutate((d) => {
        d.playlists = d.playlists.filter((p) => p.id !== playlist.id);
        const fallback = d.playlists[0]?.id ?? null;
        if (d.settings.defaultPlaylistId === playlist.id) d.settings.defaultPlaylistId = fallback;
        for (const s of d.screens) if (s.playlistId === playlist.id) s.playlistId = d.settings.defaultPlaylistId;
      });
      res.json({ ok: true });
    })
  );

  // Screens -----------------------------------------------------------------
  api.patch(
    '/screens/:id',
    route((req, res) => {
      const screen = findOr404(data().screens, req.params.id, 'Screen');
      const update = {};
      if (req.body.name !== undefined) update.name = v.str(req.body.name, { max: 80, required: true, field: 'Screen name' });
      if (req.body.playlistId !== undefined) {
        update.playlistId = req.body.playlistId || null;
        if (update.playlistId) findOr404(data().playlists, update.playlistId, 'Playlist');
      }
      if (req.body.rotation !== undefined) update.rotation = v.oneOf(Number(req.body.rotation), ROTATIONS, 0);
      if (req.body.language !== undefined) update.language = v.oneOf(req.body.language, i18n.codes, '');
      store.mutate(() => Object.assign(screen, update));
      res.json(screenView(screen));
    })
  );

  api.delete(
    '/screens/:id',
    route((req, res) => {
      const screen = findOr404(data().screens, req.params.id, 'Screen');
      store.mutate((d) => {
        d.screens = d.screens.filter((s) => s.id !== screen.id);
      });
      res.json({ ok: true });
    })
  );

  api.post(
    '/screens/:id/command',
    route((req, res) => {
      const screen = findOr404(data().screens, req.params.id, 'Screen');
      const command = v.oneOf(req.body.command, ['identify', 'reload'], null);
      if (!command) throw v.bad('Unknown command');
      const delivered = hub.send(screen.id, command, { name: screen.name, id: screen.id });
      res.json({ delivered });
    })
  );

  // Preview any playlist in a browser tab without registering a screen.
  api.get(
    '/preview/:playlistId/manifest',
    route((req, res) => {
      const playlist = findOr404(data().playlists, req.params.playlistId, 'Playlist');
      res.set('Cache-Control', 'no-store').json(buildManifest(playlist, null));
    })
  );

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---------- Static ----------
  app.use(
    '/media',
    express.static(mediaDir, {
      immutable: true,
      maxAge: '365d',
      index: false,
      dotfiles: 'deny',
      setHeaders(res) {
        // Uploaded files (incl. SVG) can never run script in our origin.
        res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
      },
    })
  );
  app.use('/shared', express.static(path.join(PUBLIC_DIR, 'shared'), { maxAge: 0 }));
  app.use('/player', express.static(path.join(PUBLIC_DIR, 'player'), { maxAge: 0 }));
  app.use('/admin', express.static(path.join(PUBLIC_DIR, 'admin'), { maxAge: 0 }));
  app.use('/portal-assets', express.static(path.join(PUBLIC_DIR, 'portal'), { maxAge: 0 }));
  app.get('/favicon.svg', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'shared', 'favicon.svg')));
  app.get('/', (req, res) => res.redirect('/admin/'));
  app.get('/healthz', (req, res) => res.json({ ok: true, version: pkg.version }));

  // ---------- Errors ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return res.end();
    const message = status >= 500 ? 'Something went wrong' : err.type === 'entity.parse.failed' ? 'Invalid JSON' : err.message;
    res.status(status).json({ error: message });
  });

  const close = () => {
    feeds.close();
    hub.close();
    store.flush();
  };

  return { app, store, hub, feeds, sports: feeds, close, dataDir };
}

module.exports = { createApp, MEDIA_TYPES, ASSET_TYPES };
