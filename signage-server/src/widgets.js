// Widgets for club screens: weather, jokes, phrases, trivia, quiz questions and
// "this day / week / month in history". Bundled content packs (data/widgets/*.json)
// work offline; weather (Open-Meteo) and general history (Wikipedia "On this day")
// are fetched live, cached, and fall back gracefully when the internet is down.
//
//   const widgets = createWidgets({ config });
//   widgets.peek('joke')             // sync: cached/bundled data now (kicks off any fetch)
//   await widgets.get('weather')     // async: waits for live data
//   widgets.on('update', ...)        // live data arrived or changed
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { ROOT } from './config.js';
import { createSources, BANK_HOLIDAY_DIVISIONS } from './sources.js';
import { createSafeFetch } from './egress.js';

export const WIDGET_KINDS = [
  { kind: 'clock', name: 'Clock', description: 'Digital or analogue clock, or a countdown to kick-off', source: 'screen' },
  { kind: 'weather', name: 'Weather', description: 'Current conditions and a short forecast (Open-Meteo, no API key)', source: 'live' },
  { kind: 'joke', name: 'Joke', description: 'Family-friendly sports jokes with a punchline reveal', source: 'bundled' },
  { kind: 'phrase', name: 'Phrase', description: 'Club-spirit phrases in big type', source: 'bundled' },
  { kind: 'trivia', name: 'Did you know?', description: 'Trivia facts: sport, film & TV, music, geography or culture', source: 'bundled' },
  { kind: 'quiz', name: 'Quiz', description: 'Multiple-choice questions with an answer reveal: sport, film & TV, music, geography or culture', source: 'bundled' },
  { kind: 'history', name: 'On this day', description: 'This day, week or month in sporting or TV/film/music history (plus general history from Wikipedia)', source: 'bundled+live' },
  { kind: 'emoji', name: 'Emoji quiz', description: 'Guess the film, TV show or song from emojis', source: 'bundled' },
  { kind: 'geoquiz', name: 'Flags & capitals', description: 'Geography quiz: name the country from its flag, or its capital city', source: 'bundled' },
  { kind: 'country', name: 'Country of the day', description: 'A country’s flag, capital, continent and currency', source: 'bundled' },
  { kind: 'worldclock', name: 'World clocks', description: 'The time in cities around the world', source: 'screen' },
  { kind: 'transport', name: 'Transport hub', description: 'Live bus tracker (England), train departures (National Rail), London buses, tube/rail line status, London roads and planes overhead', source: 'live' },
  { kind: 'bankholiday', name: 'Bank holidays', description: 'Upcoming UK bank holidays (GOV.UK)', source: 'live' },
  { kind: 'floods', name: 'Flood warnings', description: 'Environment Agency flood warnings near the ground (England)', source: 'live' },
  { kind: 'carbon', name: 'Grid carbon', description: 'How green the electricity is right now (Carbon Intensity API)', source: 'live' },
  { kind: 'quakes', name: 'Earthquakes', description: 'Recent earthquakes worldwide (USGS)', source: 'live' },
  { kind: 'currency', name: 'Exchange rates', description: 'Daily reference exchange rates (European Central Bank)', source: 'live' },
  { kind: 'potd', name: 'Picture of the day', description: 'Wikimedia Commons picture of the day', source: 'live' },
  { kind: 'births', name: 'Born on this day', description: 'Famous birthdays today (Wikipedia)', source: 'live' },
  { kind: 'sky', name: 'Sunrise, sunset & moon', description: 'Sun times and moon phase for the ground (calculated, no internet needed)', source: 'screen' },
  { kind: 'headlines', name: 'News headlines', description: 'Headlines from any RSS or Atom feed, e.g. your club or league website', source: 'live' },
  { kind: 'events', name: 'Calendar', description: 'Upcoming events from any iCal (.ics) calendar, e.g. Google Calendar or your league', source: 'live' },
];

export const TOPICS = ['sport', 'film-tv', 'music', 'geography', 'culture', 'mixed'];
export const HISTORY_TOPICS = ['sport', 'entertainment', 'all'];
const TOPIC_PACKS = {
  quiz: { sport: 'quiz', 'film-tv': 'quiz-film-tv', music: 'quiz-music', geography: 'quiz-geography', culture: 'quiz-culture' },
  trivia: { sport: 'trivia', 'film-tv': 'trivia-film-tv', music: 'trivia-music', geography: 'trivia-geography', culture: 'trivia-culture' },
};
export const TOPIC_LABELS = { sport: 'Sport', 'film-tv': 'Film & TV', music: 'Music', geography: 'Geography', culture: 'Culture', mixed: 'General knowledge' };
const KINDS = new Set(WIDGET_KINDS.map((k) => k.kind));

const PACK_DIR = resolve(ROOT, 'data', 'widgets');
const packs = {};
const pack = (name) => (packs[name] ??= JSON.parse(readFileSync(resolve(PACK_DIR, `${name}.json`), 'utf8')).items);

const WEATHER_TTL = 15 * 60_000;
const HISTORY_TTL = 12 * 3600_000;
const RETRY_MS = 2 * 60_000;
const MAX_CACHE_KEYS = 200;
const UA = 'PitchTribe-Signage/1.0 (club digital signage; https://pitchtribe.media)';

// ---------------------------------------------------------------- helpers
/** Deterministic PRNG from a string, so a day's selection is stable across refreshes. */
function seeded(seed) {
  let buf = createHash('sha256').update(seed).digest();
  let i = 0;
  return () => {
    if (i + 4 > buf.length) { buf = createHash('sha256').update(buf).digest(); i = 0; }
    const v = buf.readUInt32BE(i);
    i += 4;
    return v / 2 ** 32;
  };
}
export function sample(list, n, seed) {
  const rnd = seeded(seed);
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** { y, m, d, dow } for `now` in a timezone. */
function partsIn(now, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
const pad = (n) => String(n).padStart(2, '0');
/** "GB" -> 🇬🇧 (regional indicator symbols). */
export const flagEmoji = (code) => String.fromCodePoint(...[...String(code).toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
const mmdd = (m, d) => `${pad(m)}-${pad(d)}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Parse "Question | Answer" lines (or plain lines) supplied by the club. */
function extraLines(extra) {
  if (!extra) return [];
  const lines = Array.isArray(extra) ? extra : String(extra).split(/\r?\n/);
  return lines.map((l) => String(l).trim()).filter(Boolean).slice(0, 200);
}

// WMO weather codes -> [description, day icon, night icon]
const WMO = {
  0: ['Clear sky', '☀️', '🌙'], 1: ['Mainly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'], 3: ['Overcast', '☁️', '☁️'],
  45: ['Fog', '🌫️', '🌫️'], 48: ['Freezing fog', '🌫️', '🌫️'],
  51: ['Light drizzle', '🌦️', '🌧️'], 53: ['Drizzle', '🌦️', '🌧️'], 55: ['Heavy drizzle', '🌧️', '🌧️'],
  56: ['Freezing drizzle', '🌧️', '🌧️'], 57: ['Freezing drizzle', '🌧️', '🌧️'],
  61: ['Light rain', '🌦️', '🌧️'], 63: ['Rain', '🌧️', '🌧️'], 65: ['Heavy rain', '🌧️', '🌧️'],
  66: ['Freezing rain', '🌧️', '🌧️'], 67: ['Freezing rain', '🌧️', '🌧️'],
  71: ['Light snow', '🌨️', '🌨️'], 73: ['Snow', '❄️', '❄️'], 75: ['Heavy snow', '❄️', '❄️'], 77: ['Snow grains', '🌨️', '🌨️'],
  80: ['Showers', '🌦️', '🌧️'], 81: ['Heavy showers', '🌧️', '🌧️'], 82: ['Violent showers', '⛈️', '⛈️'],
  85: ['Snow showers', '🌨️', '🌨️'], 86: ['Heavy snow showers', '❄️', '❄️'],
  95: ['Thunderstorm', '⛈️', '⛈️'], 96: ['Thunderstorm with hail', '⛈️', '⛈️'], 99: ['Thunderstorm with hail', '⛈️', '⛈️'],
};
const WMO_COND = { 0: 'clear', 1: 'fair', 2: 'partly', 3: 'cloudy', 45: 'fog', 48: 'fog', 51: 'drizzle', 53: 'drizzle', 55: 'drizzle', 56: 'drizzle', 57: 'drizzle',
  61: 'lightrain', 63: 'rain', 65: 'heavyrain', 66: 'rain', 67: 'rain', 71: 'snow', 73: 'snow', 75: 'snow', 77: 'snow', 80: 'showers', 81: 'showers', 82: 'heavyrain',
  85: 'snowshowers', 86: 'snowshowers', 95: 'thunder', 96: 'thunder', 99: 'thunder' };
export function describeWeather(code, isDay = true) {
  const [text, day, night] = WMO[code] ?? ['Unknown', '🌡️', '🌡️'];
  return { text, icon: isDay ? day : night, cond: WMO_COND[code] || '' };
}

// ----------------------------------------------------------------- widget set
export function createWidgets({ config = {}, fetchImpl = fetch, log = console.error, lookup } = {}) {
  const emitter = new EventEmitter();
  const cache = new Map(); // key -> { data, fetchedAt, inflight, error, hash }
  // Every outbound widget fetch is checked against the Pi's own network first.
  const safeFetch = createSafeFetch({ fetchImpl, ...(lookup ? { lookup } : {}) });
  const tz = config.timezone || 'Europe/London';
  const weatherCfg = config.weather || null;
  const wikipedia = config.widgets?.wikipedia !== false;
  const provider = weatherCfg?.provider === 'openmeteo' ? 'openmeteo' : 'metno';

  async function getJson(url) {
    const res = await safeFetch(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Text body (RSS, iCal) with a 2 MB cap. */
  async function getText(url) {
    const res = await safeFetch(url, { headers: { accept: 'application/rss+xml, application/atom+xml, text/calendar, text/xml, */*', 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 2_000_000) throw new Error('Feed too large');
    return text;
  }

  /** Cached remote value; refreshes in the background once stale. */
  function remote(key, ttl, fetcher) {
    let e = cache.get(key);
    if (!e) {
      // Bounded: keys include feed addresses, and an unbounded Map keyed on
      // those is a slow memory leak on a Pi that runs for months. Oldest
      // untouched entry goes first; a live widget re-fetches on its next tick.
      if (cache.size >= MAX_CACHE_KEYS) {
        let oldestKey = null;
        let oldestAt = Infinity;
        for (const [k, v] of cache) {
          if (v.inflight) continue;
          if (v.fetchedAt < oldestAt) { oldestAt = v.fetchedAt; oldestKey = k; }
        }
        if (oldestKey !== null) cache.delete(oldestKey);
      }
      e = { data: null, fetchedAt: 0, inflight: null, error: null, hash: '' };
      cache.set(key, e);
    }
    const age = Date.now() - e.fetchedAt;
    const stale = e.error ? age > RETRY_MS : age > ttl;
    if (stale && !e.inflight) {
      e.inflight = fetcher()
        .then((data) => {
          const hash = createHash('sha1').update(JSON.stringify(data)).digest('hex');
          const changed = hash !== e.hash;
          Object.assign(e, { data, hash, error: null, fetchedAt: Date.now() });
          if (changed) emitter.emit('update', { key });
        })
        .catch((err) => {
          log(`[widgets] ${key}: ${err.message}`);
          Object.assign(e, { error: err.message, fetchedAt: Date.now() });
        })
        .finally(() => { e.inflight = null; });
    }
    return e;
  }

  const src = createSources({ remote, getJson, getText, tz, weatherCfg, trainsCfg: config.widgets?.trains, bodsCfg: config.widgets?.bods, partsIn, sample });

  // ---- weather
  // One 7-day fetch per location; slides take as many days as they show.
  function weatherEntry() {
    if (!weatherCfg || !Number.isFinite(Number(weatherCfg.latitude)) || !Number.isFinite(Number(weatherCfg.longitude))) return null;
    if (provider === 'metno') return src.metForecast();
    const windUnit = weatherCfg.windUnit === 'kmh' ? 'kmh' : 'mph';
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${Number(weatherCfg.latitude)}&longitude=${Number(weatherCfg.longitude)}`
      + '&current=temperature_2m,weather_code,wind_speed_10m,is_day'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + `&wind_speed_unit=${windUnit}&timezone=auto&forecast_days=7`;
    return remote(`weather:${weatherCfg.latitude},${weatherCfg.longitude}`, WEATHER_TTL, async () => {
      const j = await getJson(url);
      const cur = j.current ?? {};
      const d = j.daily ?? {};
      return {
        current: {
          temp: Math.round(cur.temperature_2m),
          wind: Math.round(cur.wind_speed_10m),
          ...describeWeather(cur.weather_code, cur.is_day !== 0),
        },
        days: (d.time ?? []).map((date, i) => ({
          date,
          max: Math.round(d.temperature_2m_max?.[i]),
          min: Math.round(d.temperature_2m_min?.[i]),
          rain: d.precipitation_probability_max?.[i] ?? null,
          ...describeWeather(d.weather_code?.[i], true),
        })),
        units: { temp: '°C', wind: windUnit === 'kmh' ? 'km/h' : 'mph' },
      };
    });
  }

  // ---- general history (Wikipedia "On this day", selected events)
  function wikiEntry(m, d) {
    return remote(`wiki:${mmdd(m, d)}`, HISTORY_TTL, async () => {
      const j = await getJson(`https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/selected/${pad(m)}/${pad(d)}`);
      return (j.selected ?? [])
        .filter((ev) => ev.text && Number.isFinite(Number(ev.year)))
        .map((ev) => ({ date: mmdd(m, d), year: Number(ev.year), text: String(ev.text).trim(), sport: false, tag: 'general' }));
    });
  }

  function historyData(opts, now) {
    const { y, m, d, dow } = partsIn(now, tz);
    const limit = Math.min(Math.max(Number(opts.limit) || 5, 1), 12);
    const today = new Date(Date.UTC(y, m - 1, d));
    const dayKeys = (from, count) => Array.from({ length: count }, (_, i) => {
      const t = new Date(today.getTime() + (from + i) * 86_400_000);
      return mmdd(t.getUTCMonth() + 1, t.getUTCDate());
    });
    const windows = {
      day: dayKeys(0, 1),
      week: dayKeys(-((dow + 6) % 7), 7), // Monday..Sunday
      month: null,
    };
    const inWindow = (scope, item) => (scope === 'month' ? Number(item.date.slice(0, 2)) === m : windows[scope].includes(item.date));
    const order = ['day', 'week', 'month'];
    const wanted = order.includes(opts.scope) ? opts.scope : 'day';
    const topic = HISTORY_TOPICS.includes(opts.topic) ? opts.topic : 'sport';
    const all = [
      ...(topic !== 'entertainment' ? pack('sporting-history').map((it) => ({ ...it, tag: 'sport' })) : []),
      ...(topic !== 'sport' ? pack('entertainment-history').map((it) => ({ ...it, tag: 'entertainment' })) : []),
    ];
    let scopeUsed = wanted;
    let items = all.filter((it) => inWindow(wanted, it));
    // Nothing on this exact day? Widen to the week, then the month.
    for (const wider of order.slice(order.indexOf(wanted) + 1)) {
      if (items.length) break;
      scopeUsed = wider;
      items = all.filter((it) => inWindow(wider, it));
    }
    const todayKey = mmdd(m, d);
    const dist = (it) => {
      const [im, id] = it.date.split('-').map(Number);
      return Math.abs(Date.UTC(y, im - 1, id) - today.getTime());
    };
    items = items
      .map((it) => ({ ...it, sport: it.tag === 'sport' }))
      .sort((a, b) => dist(a) - dist(b) || a.year - b.year)
      .slice(0, limit);

    let general = [];
    let generalError = null;
    if (opts.general && wikipedia) {
      const e = wikiEntry(m, d);
      if (e.data) general = sample(e.data, Math.max(limit - items.length, 2), `wiki:${y}-${todayKey}`);
      generalError = e.error;
    }
    const what = { sport: 'sporting history', entertainment: 'TV, film & music', all: 'history' }[topic];
    const label = {
      day: `On this day — ${d} ${MONTHS[m - 1]}`,
      week: `This week in ${what}`,
      month: `${MONTHS[m - 1]} in ${what}`,
    }[scopeUsed];
    return {
      topic,
      month: m,
      day: d,
      scope: wanted,
      scopeUsed,
      label,
      items: [...items, ...general].sort((a, b) => (a.date === b.date ? a.year - b.year : a.date < b.date ? -1 : 1)),
      generalError,
      ...(general.length ? { credit: 'General history: Wikipedia · CC BY-SA 4.0' } : {}),
    };
  }

  /** Flag or capital-city questions generated from countries.json. */
  function geoQuiz(mode, seed, count = 20) {
    const all = pack('countries');
    return sample(all, count, seed).map((c, i) => {
      let kind = mode === 'mixed' ? (i % 2 ? 'capitals' : 'flags') : mode;
      if (kind === 'capitals' && c.skipCapital) kind = 'flags';
      const usable = all.filter((o) => o.code !== c.code && (kind === 'flags' || !o.skipCapital));
      const near = usable.filter((o) => o.continent === c.continent);
      const wrong = sample(near.length >= 3 ? near : usable, 3, `${seed}:w:${i}`);
      const label = (o) => (kind === 'flags' ? o.name : o.capital);
      const options = sample([c, ...wrong].map(label), 4, `${seed}:o:${i}`);
      const all4 = [c, ...wrong];
      return {
        q: kind === 'flags' ? 'Which country does this flag belong to?' : `What is the capital of ${c.name}?`,
        qtype: kind === 'flags' ? 'flag' : 'capital',
        code: c.code,
        flag: flagEmoji(c.code),
        options,
        // Country codes for flag questions, so screens can show names in their own language.
        optionCodes: kind === 'flags' ? options.map((o) => all4.find((x) => x.name === o).code) : undefined,
        answer: options.indexOf(label(c)),
        topic: 'geography',
      };
    });
  }

  function packFor(kind, topic) {
    if (!TOPIC_PACKS[kind]) return pack({ joke: 'jokes', phrase: 'phrases', emoji: 'emoji' }[kind]);
    const t = TOPICS.includes(topic) ? topic : 'sport';
    const names = t === 'mixed' ? Object.entries(TOPIC_PACKS[kind]) : [[t, TOPIC_PACKS[kind][t]]];
    return names.flatMap(([tp, name]) => pack(name).map((it) => (typeof it === 'string' ? { text: it, topic: tp } : { ...it, topic: tp })));
  }

  function contentData(kind, opts, now) {
    const { y, m, d } = partsIn(now, tz);
    const topic = TOPICS.includes(opts.topic) ? opts.topic : 'sport';
    const seed = `${kind}:${topic}:${y}-${mmdd(m, d)}`;
    const extras = extraLines(opts.extra);
    let base = opts.only && extras.length ? [] : packFor(kind, topic);
    let credit;
    let note;
    if (kind === 'quiz' && opts.source === 'opentdb' && !(opts.only && extras.length)) {
      const online = src.opentdb(topic);
      if (online.items) {
        base = online.items;
        credit = 'Questions: Open Trivia Database · CC BY-SA 4.0';
      } else {
        note = online.error ? 'Online questions unavailable — showing built-in questions.' : 'Loading online questions…';
      }
    }
    if (kind === 'quiz' && !credit && (topic === 'geography' || topic === 'mixed') && !(opts.only && extras.length)) {
      base = [...base, ...geoQuiz('mixed', `${seed}:geo`, 10)];
    }
    if (kind === 'trivia') base = base.map((it) => it.text); // facts are plain strings on screen
    if (kind === 'emoji' && ['Film', 'TV', 'Song'].includes(opts.category)) base = base.filter((it) => it.category === opts.category);
    let mine = [];
    if (kind === 'joke') {
      mine = extras.map((l) => {
        const [q, ...rest] = l.split('|');
        return { q: q.trim(), a: rest.join('|').trim() };
      });
    } else if (kind === 'quiz') {
      // "Question | right answer | wrong | wrong | wrong" — options are shuffled per question.
      mine = extras
        .map((l) => l.split('|').map((s) => s.trim()).filter(Boolean))
        .filter((cols) => cols.length >= 3)
        .map((cols, i) => {
          const options = sample(cols.slice(1, 5), 4, `${seed}:mine:${i}`);
          return { q: cols[0], options, answer: options.indexOf(cols[1]) };
        });
    } else if (kind === 'emoji') {
      // "🦁👑 | The Lion King | Film"
      mine = extras
        .map((l) => l.split('|').map((s) => s.trim()))
        .filter((cols) => cols[0] && cols[1])
        .map(([emoji, answer, category]) => ({ emoji, answer, category: category || '' }));
    } else {
      mine = extras;
    }
    base = sample(base, 20, seed);
    // Club's own lines first in the rotation, mixed into the day's sample.
    return { topic, items: [...mine, ...base].slice(0, Math.max(20, mine.length)), ...(credit ? { credit } : {}), ...(note ? { note } : {}) };
  }

  function countryData(now) {
    const { y, m, d } = partsIn(now, tz);
    return {
      items: sample(pack('countries'), 20, `country:${y}-${mmdd(m, d)}`).map((c) => ({
        name: c.name, code: c.code, flag: flagEmoji(c.code), capital: c.capital, continent: c.continent, currency: c.currency,
      })),
    };
  }

  function compute(kind, opts = {}, now = new Date()) {
    if (!KINDS.has(kind)) throw Object.assign(new Error(`Unknown widget "${kind}"`), { status: 404 });
    switch (kind) {
      case 'clock':
        return { timezone: tz };
      case 'weather': {
        const days = Math.min(Math.max(Number(opts.days ?? 3), 0), 6);
        const e = weatherEntry();
        if (!e) return { error: 'No location set for the weather.' };
        if (!e.data) return { place: weatherCfg.place || '', error: e.error ? `Weather unavailable (${e.error})` : 'Loading weather…' };
        return {
          place: weatherCfg.place || '',
          ...e.data,
          days: e.data.days.slice(0, days + 1),
          fetchedAt: new Date(e.fetchedAt).toISOString(),
          stale: Boolean(e.error),
          credit: provider === 'metno' ? 'Weather: MET Norway · CC BY 4.0' : 'Weather: Open-Meteo.com · CC BY 4.0',
        };
      }
      case 'transport':
        return src.transport(opts, now);
      case 'bankholiday':
      case 'floods':
      case 'carbon':
      case 'quakes':
      case 'currency':
      case 'potd':
      case 'births':
      case 'sky':
      case 'headlines':
      case 'events':
        return src[kind](opts, now);
      case 'history':
        return historyData(opts, now);
      case 'worldclock':
        return {};
      case 'geoquiz': {
        const { y, m, d } = partsIn(now, tz);
        const mode = ['flags', 'capitals', 'mixed'].includes(opts.mode) ? opts.mode : 'mixed';
        return { mode, items: geoQuiz(mode, `geoquiz:${mode}:${y}-${mmdd(m, d)}`) };
      }
      case 'country':
        return countryData(now);
      default:
        return contentData(kind, opts, now);
    }
  }

  /** Wait for any live data this widget needs, then compute. */
  async function get(kind, opts = {}, now = new Date()) {
    compute(kind, opts, now); // starts fetches
    const pending = [...cache.values()].map((e) => e.inflight).filter(Boolean);
    await Promise.all(pending);
    return compute(kind, opts, now);
  }

  /** Place search: OpenStreetMap Nominatim (ODbL, commercial use allowed), Open-Meteo as a fallback. */
  async function geocode(q) {
    const name = String(q ?? '').trim();
    if (name.length < 2) return [];
    try {
      const list = await getJson(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=jsonv2&limit=6`);
      if (Array.isArray(list) && list.length) {
        return list.map((r) => {
          const parts = String(r.display_name || '').split(',').map((x) => x.trim());
          return { name: r.name || parts[0] || name, region: parts.slice(1).filter((x) => !/^\d/.test(x)).slice(-3).join(', '), latitude: Number(r.lat), longitude: Number(r.lon), source: 'OpenStreetMap' };
        });
      }
    } catch (err) {
      log(`[widgets] nominatim: ${err.message}`);
    }
    const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=6&language=en&format=json`);
    return (j.results ?? []).map((r) => ({
      name: r.name,
      region: [r.admin1, r.country].filter(Boolean).join(', '),
      latitude: r.latitude,
      longitude: r.longitude,
    }));
  }

  /** Warm the caches for live widgets (call at start-up / after settings change). */
  function prefetch(now = new Date()) {
    if (weatherCfg) weatherEntry();
    if (wikipedia) {
      const { m, d } = partsIn(now, tz);
      wikiEntry(m, d);
    }
  }

  return Object.assign(emitter, { kinds: WIDGET_KINDS, peek: compute, get, geocode, prefetch });
}
