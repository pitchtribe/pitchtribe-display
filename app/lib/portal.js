'use strict';
/* Guest Wi-Fi captive portal — the only part of PitchTribe guests can reach.

   Runs as its own process and its own user (portal-server.js, systemd unit
   pitchtribe-portal, user pitchtribe-portal) with CAP_NET_ADMIN so it can add
   a guest's address to the nftables set that lets them online.

   Everything it touches lives in DATA_DIR/portal, the one directory it can
   write, and it never opens db.json. That matters because this is the process
   exposed to an untrusted network: writing a single file in DATA_DIR is by
   design a root account (see remote-access), and db.json holds the dashboard
   password hash, the session signing secret and every API key. So the
   dashboard hands the portal what it needs — DATA_DIR/portal/settings.json and
   a copy of the club's logo — instead of the portal reaching in for it.

   Unapproved guests' web traffic is redirected here by nftables. Any request
   for another host gets a redirect to the portal, which is what makes phones
   and laptops pop up their "sign in to network" sheet. */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const express = require('express');
const { DEFAULT_PORTAL, renderSplash, renderConnected, renderMessage, themeCss } = require('./portal-page');

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i;

const SESSIONS = 'portal-sessions.json';
const GUESTS = 'portal-guests.jsonl';
/** The portal's own directory: the only place it may write. */
const portalPath = (dataDir) => path.join(dataDir, 'portal');
// Group-readable (0640), so the dashboard can read the guest list and stats
// without the two services sharing a user or a writable directory.
const SHARED_MODE = 0o640;

/** Allow a guest IP through the firewall for `minutes` (nftables set with timeout). */
function nftAllow(ip, minutes) {
  return new Promise((resolve, reject) => {
    execFile('nft', ['add', 'element', 'inet', 'pitchtribe_portal', 'allowed', `{ ${ip} timeout ${minutes}m }`], { timeout: 5000 }, (err, _out, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve());
  });
}

/** Best-effort MAC lookup from the kernel's neighbour table. */
function macFor(ip) {
  try {
    const line = fs.readFileSync('/proc/net/arp', 'utf8').split('\n').find((l) => l.split(/\s+/)[0] === ip);
    const mac = line && line.split(/\s+/)[3];
    return mac && mac !== '00:00:00:00:00:00' ? mac : '';
  } catch {
    return '';
  }
}

function createPortalApp({
  dataDir,
  portalHost = process.env.PORTAL_HOST || '10.42.0.1',
  subnet = process.env.PORTAL_SUBNET || '10.42.', // 10.42.0.0/22, see portal-apply.sh
  allow = nftAllow,
  mac = macFor,
  now = () => Date.now(),
  log = console.error,
} = {}) {
  const portalDir = portalPath(dataDir);
  const settingsFile = path.join(portalDir, 'settings.json');
  const logoFile = path.join(portalDir, 'logo');
  const sessionsFile = path.join(portalDir, SESSIONS);
  const guestsFile = path.join(portalDir, GUESTS);
  const publicDir = path.join(__dirname, '..', 'public', 'portal');
  try { fs.mkdirSync(portalDir, { recursive: true, mode: 0o770 }); } catch (err) { log('[portal]', err.message); }

  // ---- settings (re-read when the dashboard rewrites them)
  let cache = { mtime: 0, data: null };
  function state() {
    try {
      const st = fs.statSync(settingsFile);
      if (st.mtimeMs !== cache.mtime) cache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
    } catch (err) {
      if (!cache.data) log('[portal] cannot read settings:', err.message);
    }
    const d = cache.data || {};
    const portal = { ...DEFAULT_PORTAL, ...(d.portal || {}) };
    return { club: d.club || 'Our club', portal, logo: fs.existsSync(logoFile) };
  }

  // ---- sessions (mirrors the nftables set so pages can say "you're online")
  let sessions = {};
  let stats = { days: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    sessions = saved.sessions || {};
    stats = saved.stats || { days: {} };
  } catch { /* first run */ }
  function persist() {
    const t = now();
    for (const [ip, s] of Object.entries(sessions)) if (s.expires < t) delete sessions[ip];
    const keepFrom = new Date(t - 60 * 86400000).toISOString().slice(0, 10);
    for (const day of Object.keys(stats.days)) if (day < keepFrom) delete stats.days[day];
    const tmp = `${sessionsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date(t).toISOString(), sessions, stats }, null, 1), { mode: SHARED_MODE });
    fs.chmodSync(tmp, SHARED_MODE);
    fs.renameSync(tmp, sessionsFile);
  }
  const heartbeat = setInterval(() => { try { persist(); } catch (err) { log('[portal]', err.message); } }, 60_000);
  heartbeat.unref();

  const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const active = (ip) => sessions[ip] && sessions[ip].expires > now() ? sessions[ip] : null;
  const css = ['/portal.css', '/theme.css'];

  // ---- per-IP limiter for the accept form
  const hits = new Map();
  const limited = (ip) => {
    const t = now();
    const h = (hits.get(ip) || []).filter((x) => t - x < 60_000);
    h.push(t);
    hits.set(ip, h);
    return h.length > 10;
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' http:; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    next();
  });

  // Requests for any other host (captive-portal probes, the page the guest was
  // trying to open) are sent to the portal. That redirect is what triggers the
  // phone's sign-in sheet.
  app.use((req, res, next) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (host !== portalHost) return res.redirect(302, `http://${portalHost}/`);
    next();
  });

  app.get('/portal.css', (req, res) => res.type('text/css').sendFile(path.join(publicDir, 'portal.css')));
  app.get('/theme.css', (req, res) => res.type('text/css').send(themeCss(state().portal.accent)));
  app.get('/logo', (req, res) => {
    if (!state().logo) return res.status(404).end();
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    // The dashboard puts a copy here; the portal has no access to the media
    // folder, and should not need it to show a crest on the sign-in page.
    res.sendFile(logoFile);
  });

  const pageOpts = (s) => ({ club: s.club, portal: s.portal, logoUrl: s.logo ? '/logo' : null, css });

  app.post('/accept', express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
    const s = state();
    const ip = clientIp(req);
    if (!s.portal.enabled) return res.status(503).send(renderMessage({ ...pageOpts(s), title: 'Guest Wi-Fi is switched off', text: 'Please ask at the bar.' }));
    if (limited(ip)) return res.status(429).send(renderMessage({ ...pageOpts(s), title: 'Too many attempts', text: 'Please wait a minute and try again.' }));
    const body = req.body || {}; // no body at all (e.g. an empty POST) is just an unticked form
    const values = { email: String(body.email || '').trim().slice(0, 200), consent: body.consent === 'yes' };
    const fail = (error) => res.status(400).send(renderSplash({ ...pageOpts(s), error, values }));
    if (body.terms !== 'yes') return fail('Please agree to the terms of use to connect.');
    const wantsEmail = s.portal.collectEmail === 'optional' || s.portal.collectEmail === 'required';
    if (wantsEmail && values.email && !EMAIL.test(values.email)) return fail('That email address doesn’t look right.');
    if (s.portal.collectEmail === 'required' && !values.email) return fail('Please enter your email address to connect.');
    const m = IPV4.exec(ip);
    if (!m || !ip.startsWith(subnet) || m.slice(1).some((n) => Number(n) > 255)) {
      return res.status(400).send(renderMessage({ ...pageOpts(s), title: 'Connect to the guest Wi-Fi first', text: `This page only works on the “${s.portal.ssid}” network.` }));
    }
    const minutes = Math.min(Math.max(Number(s.portal.sessionMinutes) || 120, 5), 24 * 60);
    try {
      await allow(ip, minutes);
    } catch (err) {
      log('[portal] could not open the firewall:', err.message);
      return res.status(500).send(renderMessage({ ...pageOpts(s), title: 'Sorry, something went wrong', text: 'Please try again in a moment, or ask at the bar.' }));
    }
    const t = now();
    const device = mac(ip);
    sessions[ip] = { started: t, expires: t + minutes * 60_000, mac: device };
    const day = new Date(t).toISOString().slice(0, 10);
    stats.days[day] = (stats.days[day] || 0) + 1;
    if (wantsEmail && values.email) {
      fs.appendFileSync(guestsFile, `${JSON.stringify({ at: new Date(t).toISOString(), email: values.email, consent: values.consent })}\n`, { mode: SHARED_MODE });
    }
    try { persist(); } catch (err) { log('[portal]', err.message); }
    res.send(renderConnected({ ...pageOpts(s), minutesLeft: minutes }));
  });

  app.use((req, res) => {
    const s = state();
    if (!s.portal.enabled) return res.status(503).send(renderMessage({ ...pageOpts(s), title: 'Guest Wi-Fi is switched off', text: 'Please ask at the bar.' }));
    const session = active(clientIp(req));
    if (session) return res.send(renderConnected({ ...pageOpts(s), minutesLeft: Math.ceil((session.expires - now()) / 60_000) }));
    res.send(renderSplash(pageOpts(s)));
  });

  const close = () => clearInterval(heartbeat);
  return { app, close, sessions, stats, persist };
}

/**
 * Where one of the portal's files is. Cards set up before the portal had its
 * own user keep theirs in DATA_DIR itself, and an upgrade must not look like
 * the guest list was lost, so the old place is still read if the new one is
 * empty. deploy/install.sh moves them across.
 */
function portalFile(dataDir, name) {
  const now = path.join(portalPath(dataDir), name);
  if (fs.existsSync(now)) return now;
  const legacy = path.join(dataDir, name);
  return fs.existsSync(legacy) ? legacy : now;
}

/** Read the portal's files for the dashboard (stats, active sessions, guest list). */
function readPortalFiles(dataDir, now = Date.now()) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(portalFile(dataDir, SESSIONS), 'utf8')); } catch { /* not running yet */ }
  const sessions = Object.values(saved.sessions || {}).filter((s) => s.expires > now);
  let guests = [];
  try {
    guests = fs.readFileSync(portalFile(dataDir, GUESTS), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { /* none yet */ }
  const days = (saved.stats && saved.stats.days) || {};
  const today = new Date(now).toISOString().slice(0, 10);
  const weekAgo = new Date(now - 6 * 86400000).toISOString().slice(0, 10);
  return {
    serviceSeenAt: saved.updatedAt || null,
    active: sessions.length,
    today: days[today] || 0,
    week: Object.entries(days).filter(([d]) => d >= weekAgo).reduce((n, [, c]) => n + c, 0),
    days,
    guests,
  };
}

/**
 * The dashboard's half of the arrangement: hand the portal exactly what its
 * sign-in page needs, so it never reads db.json.
 *
 * Called whenever the club name, the guest Wi-Fi settings or the chosen logo
 * change. Writing only on a change keeps the portal's mtime check cheap and
 * the SD card quiet.
 */
function writePortalSettings(dataDir, { club, portal, logoPath = null }) {
  const dir = portalPath(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o770 });
  const file = path.join(dir, 'settings.json');
  const next = `${JSON.stringify({ club, portal }, null, 2)}\n`;
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* first time */ }
  if (old !== next) {
    fs.writeFileSync(`${file}.tmp`, next, { mode: SHARED_MODE });
    fs.chmodSync(`${file}.tmp`, SHARED_MODE);
    fs.renameSync(`${file}.tmp`, file);
  }

  // A copy of the logo, not a path into the media folder: the portal user has
  // no business reading the club's media, and uploads are 0600 anyway.
  const logo = path.join(dir, 'logo');
  if (logoPath && fs.existsSync(logoPath)) {
    const from = fs.statSync(logoPath);
    let to = null;
    try { to = fs.statSync(logo); } catch { /* no copy yet */ }
    if (!to || to.size !== from.size || to.mtimeMs < from.mtimeMs) {
      fs.copyFileSync(logoPath, `${logo}.tmp`);
      fs.chmodSync(`${logo}.tmp`, SHARED_MODE);
      fs.renameSync(`${logo}.tmp`, logo);
    }
  } else {
    fs.rmSync(logo, { force: true });
  }
}

module.exports = { createPortalApp, readPortalFiles, writePortalSettings, portalPath, portalFile, nftAllow, PORTAL_FILES: [SESSIONS, GUESTS] };
