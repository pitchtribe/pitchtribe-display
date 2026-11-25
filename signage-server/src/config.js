import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  port: 8090,
  host: '0.0.0.0',
  publicUrl: '',
  apiToken: '',
  title: 'Sports Centre',
  timezone: 'Europe/London',
  daysBack: 3,
  daysAhead: 7,
  refreshMinutes: 10,
  liveRefreshSeconds: 60,
  rotateSeconds: 15,
  rowsPerPage: 10,
  leagues: [],
  pushTargets: [],
  weather: null, // { place, latitude, longitude, windUnit: 'mph' | 'kmh' }
  // One club's wall (GET /clubhouse) — see CLUBHOUSE.md. Null keeps this a pure feed
  // server: the clubhouse routes stay inert and `/` still goes to /display.
  clubhouse: null,
  widgets: { wikipedia: true },
  // Off by default: with `access-control-allow-origin: *` any web page open on
  // the same network could read this API from the browser of whoever visited
  // it. Screens load the display page from this origin, so they do not need it.
  cors: false,
};

/**
 * Load config from $SIGNAGE_CONFIG, ./config.json, or config.example.json (in that order).
 * PORT, HOST, PUBLIC_URL and API_TOKEN environment variables override the file.
 */
export function loadConfig(env = process.env) {
  const candidates = [env.SIGNAGE_CONFIG, resolve(ROOT, 'config.json'), resolve(ROOT, 'config.example.json')]
    .filter(Boolean);
  const file = candidates.find((p) => existsSync(p));
  const fromFile = file ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return resolveConfig(fromFile, { env, configFile: file ?? null });
}

/** The leagues shipped in config.example.json — the catalogue the PitchTribe dashboard offers. */
export function exampleConfig() {
  return JSON.parse(readFileSync(resolve(ROOT, 'config.example.json'), 'utf8'));
}

/**
 * Build a full config from a plain object (used when embedding the server in the
 * PitchTribe app). Relative `file` paths resolve against `baseDir` (default: this package).
 */
export function resolveConfig(fromFile = {}, { env = {}, configFile = null, baseDir = ROOT } = {}) {
  const config = { ...DEFAULTS, ...fromFile, configFile };

  if (env.PORT) config.port = Number(env.PORT);
  if (env.HOST) config.host = env.HOST;
  if (env.PUBLIC_URL) config.publicUrl = env.PUBLIC_URL;
  if (env.API_TOKEN) config.apiToken = env.API_TOKEN;
  if (!config.publicUrl) config.publicUrl = `http://localhost:${config.port}`;
  config.publicUrl = config.publicUrl.replace(/\/+$/, '');

  // Resolve relative paths (manual sources, the photo pool, the badge) against the server root.
  config.leagues = config.leagues.map((l) => (l.file ? { ...l, file: resolve(baseDir, l.file) } : l));
  if (config.clubhouse) {
    config.clubhouse = {
      ...config.clubhouse,
      photosDir: config.clubhouse.photosDir ? resolve(baseDir, config.clubhouse.photosDir) : '',
      badge: config.clubhouse.badge ? resolve(baseDir, config.clubhouse.badge) : '',
    };
  }
  config.pushTargets = config.pushTargets.filter((t) => t.enabled !== false);
  return config;
}
