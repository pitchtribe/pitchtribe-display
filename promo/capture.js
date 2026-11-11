#!/usr/bin/env node
'use strict';
/* Records the PitchTribe player and dashboard for the promo video.

   Player captures are deterministic: Chromium's clock is driven by the
   script (CDP virtual time), one screenshot per 1/60 s, piped into ffmpeg.
   Slides change on the exact frame the playlist says, every run, regardless
   of how fast this machine is. Dashboard and Wi-Fi captures step the same
   way, with scripted taps and drags at fixed frame numbers.

   Usage (after `node seed.js` against the same instance):
     node capture.js            all shots
     node capture.js loop hero  only some shots

   Shots:
     loop       loop-full-1080p.webm           the "Promo reel" playlist, one clean pass
     hero       hero-NN-<slide>.webm           6 s per slide type, for the Hero cut
     vertical   vertical-full-1080x1920.webm   the reel on the portrait-rotated screen
     dashboard  act4-dashboard-390x844.webm    phone dashboard: drag, duration, Preview
     wifi       wifi-splash-390x844.webm/.png  the guest Wi-Fi splash page

   Env:
     BASE      instance URL                     default http://127.0.0.1:8090
     PASSWORD  dashboard password               default promo-reel-2026
     FPS       frames per second                default 60
     OUT       output directory                 default ./out
     KEEP_LOGOS=1  keep team logos on the Live scores slide (hidden by default,
                   so no third-party crests end up in the film). */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const ffmpegPath = require('ffmpeg-static');

const BASE = (process.env.BASE || 'http://127.0.0.1:8090').replace(/\/$/, '');
const PASSWORD = process.env.PASSWORD || 'promo-reel-2026';
const FPS = Number(process.env.FPS || 60);
const OUT = path.resolve(process.env.OUT || path.join(__dirname, 'out'));
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'seed.json'), 'utf8'));

// Hide third-party club crests and the mouse cursor in player captures.
const PLAYER_CSS = `
  html, body, * { cursor: none !important; }
  ${process.env.KEEP_LOGOS ? '' : '.score-row .logo { display: none !important; }'}
`;

// Hero clips: slide name in the "Promo hero clips" playlist -> file stem.
// Each slide holds for HERO_HOLD s; the clip starts 1 s in (after the fade).
const HERO = [
  ['Promo — Quiz night', 'hero-05-notice'],
  ['Promo — Fixtures', 'hero-06-fixtures'],
  ['Promo — Bar & Kitchen', 'hero-07-menu-board'],
  ['Promo — Live scores', 'hero-08-live-scores'],
  ['Promo — Weather', 'hero-09a-widget-weather'],
  ['Promo — Buses', 'hero-09b-widget-buses'],
  ['Promo — Quiz', 'hero-09c-widget-quiz'],
];
const HERO_HOLD = 8;
const HERO_CLIP = 6;
const HERO_OFFSET = 1;
const WATCHDOG_MS = 20000;

// ----------------------------------------------------------------- helpers
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start ffmpeg reading PNG frames on stdin, writing a VP9 .webm (plus a
    .png poster of the first frame when `poster` is set). */
function encoder(file, { width, height, transpose } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const filters = [];
  if (transpose != null) filters.push(`transpose=${transpose}`);
  if (width && height) filters.push(`scale=${width}:${height}:flags=lanczos`);
  filters.push('format=yuv420p');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(FPS), '-i', 'pipe:0',
    '-vf', filters.join(','),
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '24', '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1', '-threads', '4',
    '-r', String(FPS), file,
  ];
  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => {
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code} for ${file}`))));
    proc.on('error', reject);
  });
  let exited = false;
  done.catch(() => {}).finally(() => { exited = true; });
  proc.stdin.on('error', () => {}); // a dead ffmpeg is reported by `done`, not an EPIPE throw
  return {
    write(buf) {
      if (exited) return done;
      if (!proc.stdin.write(buf)) return Promise.race([new Promise((r) => proc.stdin.once('drain', r)), done]);
      return Promise.resolve();
    },
    async end() { proc.stdin.end(); await done; },
  };
}

/** Cut [from, from+len) seconds out of a finished recording (re-encoded so cuts are exact). */
function cut(src, dst, from, len) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(from), '-t', String(len), '-i', src,
      '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '24', '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1', '-threads', '4', dst], { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg cut exited ${c}`))));
  });
}

/** A page whose clock only moves when we say so. */
class SteppedPage {
  constructor(page, cdp) {
    this.page = page;
    this.cdp = cdp;
    this.frame = 0;
  }
  static async open(context, { width, height }) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const sp = new SteppedPage(page, cdp);
    // Track in-flight requests so a stalled frame can say what it waited on.
    sp.inflight = new Map();
    page.on('request', (r) => sp.inflight.set(r, r.url()));
    for (const ev of ['requestfinished', 'requestfailed']) page.on(ev, (r) => sp.inflight.delete(r));
    return sp;
  }
  /** Freeze the clock at the current real time. Call before goto(). */
  async freeze() {
    await this.cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause', initialVirtualTime: Date.now() / 1000 });
  }
  /** Let virtual time run until `ms` have passed and the network is idle.
      If a fetch never settles (watchdog), carry on with the clock anyway so a
      stuck feed costs one log line rather than the whole capture. */
  async advance(ms) {
    const budgetExpired = (policy) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`virtual time stalled (${policy}); in flight: ${[...this.inflight.values()].join(', ') || 'nothing'}`)), WATCHDOG_MS);
      this.cdp.once('Emulation.virtualTimeBudgetExpired', () => { clearTimeout(timer); resolve(); });
      this.cdp.send('Emulation.setVirtualTimePolicy', { policy, budget: ms, maxVirtualTimeTaskStarvationCount: 100000 }).catch(reject);
    });
    try {
      await budgetExpired('pauseIfNetworkFetchesPending');
    } catch (err) {
      log('warning:', err.message);
      await budgetExpired('advance');
    }
  }
  async screenshot() {
    const shot = () => this.cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
    const timeout = () => new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot stalled')), WATCHDOG_MS));
    let data;
    try {
      ({ data } = await Promise.race([shot(), timeout()]));
    } catch (err) {
      log('warning:', err.message, '- retrying once');
      ({ data } = await Promise.race([shot(), timeout()]));
    }
    return Buffer.from(data, 'base64');
  }
  /** Advance one frame, grab it. */
  async step(enc) {
    await this.advance(1000 / FPS);
    await enc.write(await this.screenshot());
    this.frame += 1;
  }
  async run(enc, seconds, onFrame) {
    const n = Math.round(seconds * FPS);
    for (let i = 0; i < n; i++) {
      if (onFrame) await onFrame(this.frame, this.frame / FPS);
      await this.step(enc);
      if (this.frame % (FPS * 5) === 0) log(`  ${this.frame / FPS}s`);
    }
  }
}

async function signIn(context) {
  const res = await context.request.post(`${BASE}/api/auth/login`, { data: { password: PASSWORD }, headers: { 'x-pitchtribe': '1' } });
  if (!res.ok()) throw new Error(`Sign-in failed: HTTP ${res.status()}`);
}

/** Create (or reuse) a capture-only playlist from named assets. */
async function ensurePlaylist(context, name, rows, extras = {}) {
  const api = async (method, url, data) => {
    const r = await context.request.fetch(`${BASE}/api${url}`, { method, data, headers: { 'x-pitchtribe': '1' } });
    if (!r.ok()) throw new Error(`${method} ${url} -> ${r.status()}`);
    return r.json();
  };
  const state = await api('GET', '/state');
  const items = rows.map(([asset, duration]) => ({ assetId: seed.assets[asset], enabled: true, duration }));
  const existing = state.playlists.find((p) => p.name === name);
  const body = { name, showClock: false, ticker: '', ...extras, items };
  if (existing) return api('PUT', `/playlists/${existing.id}`, body);
  const created = await api('POST', '/playlists', { name, showClock: body.showClock, ticker: body.ticker });
  return api('PUT', `/playlists/${created.id}`, body);
}

async function playerPage(context, url, size) {
  const sp = await SteppedPage.open(context, size);
  await sp.freeze();
  await sp.page.goto(url, { waitUntil: 'commit' });
  // Let the page boot, fetch the manifest and its first slide's data.
  await sp.advance(1500);
  await sp.page.addStyleTag({ content: PLAYER_CSS });
  await sp.page.waitForSelector('#stage .slide.in', { timeout: 15000 });
  return sp;
}

// One pass of the 30 s reel plus the first second of the next loop.
const LOOP_SECONDS = Number(process.env.LOOP_SECONDS || 31);

// ------------------------------------------------------------------- shots
async function shotLoop(browser) {
  const context = await browser.newContext({ bypassCSP: true, viewport: { width: 1920, height: 1080 } });
  await signIn(context);
  const file = path.join(OUT, 'loop-full-1080p.webm');
  log('loop: ', file);
  const sp = await playerPage(context, `${BASE}/player/?preview=${seed.playlists.reel}`, { width: 1920, height: 1080 });
  const enc = encoder(file);
  // Preview starts at item 0, so the recording begins as the first slide fades in.
  await sp.run(enc, LOOP_SECONDS);
  await enc.end();
  await context.close();
  return [file];
}

async function shotHero(browser) {
  const context = await browser.newContext({ bypassCSP: true, viewport: { width: 1920, height: 1080 } });
  await signIn(context);
  const pl = await ensurePlaylist(context, 'Promo hero clips', HERO.map(([name]) => [name, HERO_HOLD]), { showClock: true, ticker: '' });
  const master = path.join(OUT, 'hero-master.webm');
  log('hero master:', master);
  const sp = await playerPage(context, `${BASE}/player/?preview=${pl.id}`, { width: 1920, height: 1080 });
  const enc = encoder(master);
  const stills = [];
  await sp.run(enc, HERO.length * HERO_HOLD, async (frame, t) => {
    // A poster still 3 s into each slide.
    const k = Math.floor(t / HERO_HOLD);
    if (Math.abs(t - (k * HERO_HOLD + 3)) < 1 / (FPS * 2)) {
      const png = path.join(OUT, `${HERO[k][1]}.png`);
      fs.writeFileSync(png, await sp.screenshot());
      stills.push(png);
    }
  });
  await enc.end();
  await context.close();
  const files = [];
  for (let k = 0; k < HERO.length; k++) {
    const dst = path.join(OUT, `${HERO[k][1]}.webm`);
    log('hero clip:', dst);
    await cut(master, dst, k * HERO_HOLD + HERO_OFFSET, HERO_CLIP);
    files.push(dst);
  }
  fs.unlinkSync(master);
  return [...files, ...stills];
}

async function shotVertical(browser) {
  // A real registered screen with Rotation = Portrait (90°). The player draws
  // a rotated picture on its 1920x1080 canvas; turning that back upright gives
  // the 1080x1920 frame a portrait TV shows.
  const context = await browser.newContext({ bypassCSP: true, viewport: { width: 1920, height: 1080 } });
  const file = path.join(OUT, 'vertical-full-1080x1920.webm');
  log('vertical:', file);
  const sp = await playerPage(context, `${BASE}/player/?screen=${seed.screens.portrait}`, { width: 1920, height: 1080 });
  const rotated = await sp.page.evaluate(() => document.getElementById('root').className);
  if (!/rotate-90/.test(rotated)) throw new Error(`Screen ${seed.screens.portrait} is not rotated (root class "${rotated}")`);
  const enc = encoder(file, { transpose: 2 }); // 90° counter-clockwise -> upright portrait
  await sp.run(enc, LOOP_SECONDS);
  await enc.end();
  const still = path.join(OUT, 'vertical-poster-1080x1920.png');
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '10', '-i', file, '-frames:v', '1', still], { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('poster failed'))));
  });
  await context.close();
  return [file, still];
}

async function shotDashboard(browser) {
  // Phone viewport, 3x pixel density so the video is sharp when framed in a phone.
  const context = await browser.newContext({ bypassCSP: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  await signIn(context);
  const file = path.join(OUT, 'act4-dashboard-390x844.webm');
  log('dashboard:', file);
  const sp = await SteppedPage.open(context, { width: 390, height: 844 });
  const { page } = sp;
  await sp.freeze();
  await page.goto(`${BASE}/admin/#/playlists/${seed.playlists.clubhouse}`, { waitUntil: 'commit' });
  await sp.advance(1500);
  await page.addStyleTag({ content: 'html, body, * { cursor: none !important; }' });
  await page.waitForSelector('.items .item', { timeout: 15000 });

  const enc = encoder(file);
  const rows = () => page.locator('.items .item');

  // Beat 1 (0-1.5 s): hold on the playlist.
  await sp.run(enc, 1.5);

  // Beat 2: drag the Quiz night notice (row 2) above the Bar & Kitchen menu (row 1).
  const from = rows().nth(1);
  const to = rows().nth(0);
  const grip = from.locator('.grip');
  const g = await grip.boundingBox();
  const t = await to.boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await sp.run(enc, 0.3);
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    const y = g.y + g.height / 2 + ((t.y + 8) - (g.y + g.height / 2)) * (i / steps);
    await page.mouse.move(g.x + g.width / 2, y);
    await sp.step(enc);
  }
  await sp.run(enc, 0.3);
  await page.mouse.up();
  await sp.run(enc, 0.2);
  // Chromium's synthetic drag does not always complete HTML5 drag-and-drop in
  // a stepped page; if the order did not change, finish the move with the
  // product's own drop handler so the screen shows the real result.
  const firstName = async () => rows().nth(0).locator('strong').textContent();
  if ((await firstName()) !== 'Promo — Quiz night') {
    await page.evaluate(() => {
      const items = document.querySelectorAll('.items .item');
      const dt = new DataTransfer();
      items[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      items[0].classList.add('drop-before');
      items[0].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
      items[1].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    });
  }
  await sp.run(enc, 1.2);

  // Beat 3: change the seconds field on the (now second) row from 10 to 15.
  const dur = rows().nth(1).locator('.dur input');
  await dur.scrollIntoViewIfNeeded();
  await dur.click();
  await sp.run(enc, 0.4);
  await page.keyboard.press('Control+A');
  await page.keyboard.type('15', { delay: 0 });
  await sp.run(enc, 1.0);

  // Beat 4: save, so the "Saved" state and the Live now badge are on screen together.
  await page.locator('button.btn.primary', { hasText: 'Save changes' }).click();
  await sp.run(enc, 1.5);

  // Beat 5: tap Preview (it opens a new tab; the film cuts to the TV here).
  const preview = page.locator('a.btn', { hasText: 'Preview' });
  await preview.scrollIntoViewIfNeeded();
  await sp.run(enc, 0.3);
  await preview.hover();
  await sp.run(enc, 0.2);
  await preview.click({ noWaitAfter: true });
  await sp.run(enc, 1.0);
  await enc.end();

  // Put the demo playlist back the way the seed left it.
  const api = (m, u, d) => context.request.fetch(`${BASE}/api${u}`, { method: m, data: d, headers: { 'x-pitchtribe': '1' } });
  const state = await (await api('GET', '/state')).json();
  const pl = state.playlists.find((p) => p.id === seed.playlists.clubhouse);
  const order = ['Promo — Bar & Kitchen', 'Promo — Quiz night', 'Promo — Fixtures', 'Promo — Weather', 'Promo — Live scores'];
  pl.items = order.map((n) => ({ ...pl.items.find((it) => it.assetId === seed.assets[n]), duration: 10 }));
  await api('PUT', `/playlists/${pl.id}`, pl);
  await context.close();
  return [file];
}

async function shotWifi(browser) {
  const context = await browser.newContext({ bypassCSP: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  await signIn(context);
  const webm = path.join(OUT, 'wifi-splash-390x844.webm');
  const png = path.join(OUT, 'wifi-splash-390x844.png');
  log('wifi:', webm);
  const sp = await SteppedPage.open(context, { width: 390, height: 844 });
  await sp.freeze();
  await sp.page.goto(`${BASE}/api/portal/preview`, { waitUntil: 'commit' });
  await sp.advance(1500);
  await sp.page.addStyleTag({ content: 'html, body, * { cursor: none !important; }' });
  fs.writeFileSync(png, await sp.screenshot());
  const enc = encoder(webm);
  await sp.run(enc, 5);
  await enc.end();
  await context.close();
  return [webm, png];
}

const SHOTS = { loop: shotLoop, hero: shotHero, vertical: shotVertical, dashboard: shotDashboard, wifi: shotWifi };

async function main() {
  const wanted = process.argv.slice(2).filter((a) => SHOTS[a]);
  const names = wanted.length ? wanted : Object.keys(SHOTS);
  fs.mkdirSync(OUT, { recursive: true });
  // SYSROOT: libraries and fonts unpacked by tools/fetch-chromium-libs.js, for
  // hosts where `playwright install-deps` is not possible.
  const env = { ...process.env };
  if (process.env.SYSROOT) {
    const root = path.resolve(process.env.SYSROOT);
    env.LD_LIBRARY_PATH = [`${root}/usr/lib/x86_64-linux-gnu`, `${root}/usr/lib`, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    env.FONTCONFIG_FILE = `${root}/fonts.conf`;
  }
  const browser = await chromium.launch({
    headless: true,
    env,
    args: ['--font-render-hinting=none', '--disable-lcd-text', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--lang=en-GB'],
  });
  const made = [];
  try {
    for (const name of names) {
      const t0 = Date.now();
      made.push(...await SHOTS[name](browser));
      log(`${name} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  } finally {
    await browser.close();
  }
  console.log('\nOutputs:');
  for (const f of made) console.log(`  ${path.relative(process.cwd(), f)}  ${(fs.statSync(f).size / 1e6).toFixed(1)} MB`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
