/* PitchTribe player.
   Open /player/?screen=<id> on a display (the kiosk does this on boot).
   - Registers itself with the server and plays the screen's playlist.
   - Gets pushed updates over Server-Sent Events; polls every minute as a heartbeat.
   - Evaluates each item's schedule locally, and keeps the last playlist in
     localStorage so it carries on playing if the server is unreachable.
   /player/?preview=<playlistId> previews a playlist (dashboard login needed). */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const stage = $('#stage');
  const root = $('#root');
  const params = new URLSearchParams(location.search);
  const previewId = params.get('preview');
  const SCREEN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

  const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const safeSet = (k, val) => { try { localStorage.setItem(k, val); } catch { /* storage unavailable */ } };

  function resolveScreenId() {
    let id = params.get('screen');
    if (id && SCREEN_ID_RE.test(id)) {
      safeSet('pt_screen', id);
      return id;
    }
    id = safeGet('pt_screen');
    if (!id || !SCREEN_ID_RE.test(id)) {
      id = `screen-${Math.random().toString(36).slice(2, 8)}`;
      safeSet('pt_screen', id);
    }
    return id;
  }

  const screenId = previewId ? null : resolveScreenId();
  const cacheKey = `pt_manifest_${previewId || screenId}`;

  function manifestUrl() {
    if (previewId) return `/api/preview/${encodeURIComponent(previewId)}/manifest`;
    const w = Math.round(window.screen.width * (window.devicePixelRatio || 1));
    const h = Math.round(window.screen.height * (window.devicePixelRatio || 1));
    return `/api/player/${encodeURIComponent(screenId)}/manifest?w=${w}&h=${h}`;
  }

  let manifest = null;
  // Screen language: labels via t(), dates/times/relative times/country names via Intl.
  let t = PTI18n.translator('en');
  const loc = () => t.locale;
  const cap1 = (x) => (x ? x.charAt(0).toLocaleUpperCase(loc()) + x.slice(1) : x);
  const rel = (n, unit) => cap1(new Intl.RelativeTimeFormat(loc(), { numeric: 'auto' }).format(n, unit));
  const countryName = (code, fallback) => {
    try { return new Intl.DisplayNames([loc()], { type: 'region' }).of(code) || fallback; } catch { return fallback; }
  };
  const monthName = (m) => new Date(2000, m - 1, 1).toLocaleDateString(loc(), { month: 'long' });
  const dayMonth = (m, d) => new Date(2000, m - 1, d).toLocaleDateString(loc(), { day: 'numeric', month: 'long' });
  /** "Today · 14:00", "Tomorrow", "Sat 9 Nov · 15:00" in the screen language. */
  function whenText(date, hasTime) {
    const now = new Date();
    const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day0(date) - day0(now)) / 86400000);
    const day = diff === 0 || diff === 1 ? rel(diff, 'day') : date.toLocaleDateString(loc(), { weekday: 'short', day: 'numeric', month: 'short' });
    return hasTime ? `${day} · ${date.toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' })}` : day;
  }
  function countdownText(date, hasTime) {
    const ms = date.getTime() - Date.now();
    if (ms <= 0) return hasTime ? t('liveNow') : rel(0, 'day');
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return rel(mins, 'minute');
    const hours = Math.floor(mins / 60);
    if (hours < 24) return rel(hours, 'hour');
    return rel(Math.ceil(ms / 86400000), 'day');
  }
  let current = null; // { item, sig, el }
  let advanceTimer = null;
  let renderToken = 0;

  const signature = (it) =>
    JSON.stringify([it.id, it.type, it.src, it.url, it.content, it.fit, it.muted, it.duration, it.updatedAt, it.data]);
  const playable = () => (manifest ? manifest.items.filter((it) => PTSchedule.isLive(it)) : []);

  // ---------------------------------------------------------------- loading
  let loadTimer = null;
  function scheduleLoad(delay = 250) {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(load, delay);
  }

  async function load() {
    try {
      const res = await fetch(manifestUrl(), { cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 401) {
        showSplash('Preview needs you to be signed in', 'Sign in to the dashboard, then reopen this preview.');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const m = await res.json();
      safeSet(cacheKey, JSON.stringify(m));
      apply(m);
    } catch (err) {
      if (manifest) return; // keep playing what we have
      const cached = safeGet(cacheKey);
      if (cached) {
        try {
          apply(JSON.parse(cached));
          return;
        } catch { /* corrupt cache */ }
      }
      showSplash(t('connecting'), t('waitingServer'));
    }
  }

  function apply(m) {
    manifest = m;
    if (t.lang !== (m.language || 'en')) {
      t = PTI18n.translator(m.language || 'en');
      document.documentElement.lang = t.lang;
    }
    applyChrome();
    if (!current) return next();
    const still = playable().find((it) => it.id === current.item.id);
    if (!still || signature(still) !== current.sig) next();
  }

  // --------------------------------------------------------------- playback
  function pickNext() {
    const all = manifest ? manifest.items : [];
    const n = all.length;
    if (!n) return null;
    const start = current ? all.findIndex((it) => it.id === current.item.id) : -1;
    const now = new Date();
    for (let k = 1; k <= n; k++) {
      const cand = all[(((start + k) % n) + n) % n];
      if (PTSchedule.isLive(cand, now)) return cand;
    }
    return null;
  }

  function next() {
    clearTimeout(advanceTimer);
    const item = pickNext();
    if (!item) {
      clearStage();
      current = null;
      showIdle();
      advanceTimer = setTimeout(next, 15000);
      return;
    }
    hideSplash();
    const sig = signature(item);
    // A lone web page, image or league table keeps running instead of
    // reloading itself — for the league slide that also spares Full-Time a
    // request every rotation.
    if (current && current.item.id === item.id && current.sig === sig && (item.type === 'url' || item.type === 'image' || item.type === 'league')) {
      advanceTimer = setTimeout(next, Math.max(item.duration, 5) * 1000);
      return;
    }
    show(item, sig);
  }

  async function show(item, sig) {
    const token = ++renderToken;
    let slide;
    try {
      slide = render(item);
    } catch (err) {
      console.error('Render failed', item, err);
      advanceTimer = setTimeout(next, 2000);
      return;
    }
    stage.appendChild(slide.el);
    await slide.ready;
    if (token !== renderToken) {
      slide.el.remove();
      return;
    }
    fitText(slide.el);
    // Force a layout so the fade-in transition runs.
    void slide.el.offsetWidth;
    slide.el.classList.add('in');
    const previous = [...stage.children].filter((c) => c !== slide.el);
    setTimeout(() => {
      for (const p of previous) {
        p.querySelectorAll('video').forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
        p.remove();
      }
    }, 900);
    current = { item, sig, el: slide.el };
    tickLive();
    if (slide.onShow) slide.onShow(Math.max(item.duration || 10, 1) * 1000);

    if (item.type === 'video') {
      const video = slide.el.querySelector('video');
      const playing = video.play();
      if (playing) playing.catch(() => { video.muted = true; video.play().catch(() => {}); });
      if (!item.duration) {
        video.addEventListener('ended', () => token === renderToken && next(), { once: true });
        advanceTimer = setTimeout(next, 3 * 3600 * 1000); // safety net
        return;
      }
    }
    advanceTimer = setTimeout(next, Math.max(item.duration || 10, 1) * 1000);
  }

  function clearStage() {
    renderToken++;
    stage.replaceChildren();
  }

  // ------------------------------------------------------------- rendering
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise((r) => setTimeout(r, ms))]).catch(() => {});

  function render(item) {
    const slide = el('div', 'slide');
    let ready = Promise.resolve();
    let onShow = null;
    const c = item.content || {};
    const club = manifest.clubName;

    switch (item.type) {
      case 'image': {
        slide.classList.add('media');
        const img = el('img', `fit-${item.fit || 'contain'}`);
        img.alt = '';
        img.src = item.src;
        ready = withTimeout(img.decode(), 8000);
        slide.append(img);
        break;
      }
      case 'video': {
        slide.classList.add('media');
        const video = el('video', `fit-${item.fit || 'contain'}`);
        video.src = item.src;
        video.muted = item.muted !== false;
        video.playsInline = true;
        video.preload = 'auto';
        video.loop = Boolean(item.duration); // fixed-length slot: loop short clips
        video.addEventListener('error', () => {
          console.warn('Video failed', item.src);
          if (current && current.item.id === item.id) {
            clearTimeout(advanceTimer);
            advanceTimer = setTimeout(next, 1500);
          }
        });
        ready = withTimeout(new Promise((r) => video.addEventListener('canplay', r, { once: true })), 8000);
        slide.append(video);
        break;
      }
      case 'url': {
        slide.classList.add('web');
        const frame = el('iframe');
        frame.src = item.url;
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
        frame.setAttribute('allow', 'autoplay; fullscreen');
        frame.referrerPolicy = 'no-referrer';
        ready = withTimeout(new Promise((r) => frame.addEventListener('load', r, { once: true })), 6000);
        slide.append(frame);
        break;
      }
      case 'notice': {
        const panel = el('section', `panel notice style-${c.style || 'default'}`);
        const fit = el('div', 'fit');
        fit.append(el('div', 'kicker', club));
        if (c.title) fit.append(el('h1', '', c.title));
        const body = el('div', 'body');
        for (const para of String(c.body || '').split(/\n+/).filter(Boolean)) body.append(el('p', '', para));
        fit.append(body);
        panel.append(fit);
        slide.append(panel);
        break;
      }
      case 'menu': {
        const panel = el('section', 'panel menu');
        panel.append(el('div', 'kicker', club), el('h1', '', c.title || item.name));
        const fit = el('div', 'fit');
        if (c.mode === 'bar') {
          const header = el('div', 'bar-col-header');
          header.append(el('span', 'bar-col-drink', ''), el('span', 'bar-col-price', 'Price'), el('span', 'bar-col-mp', 'Members'));
          fit.append(header);
          for (const d of (c.drinks || [])) {
            const row = el('div', 'bar-drink-row');
            let badge;
            if (d.logoSrc || d.logoUrl) {
              badge = document.createElement('img');
              badge.className = 'brand-logo';
              badge.src = d.logoSrc || d.logoUrl;
              badge.alt = d.name;
              badge.loading = 'eager';
            } else {
              badge = el('span', 'brand-badge');
              badge.style.background = d.color || '#888';
              badge.textContent = d.name.slice(0, 2).toUpperCase();
            }
            const name = el('span', 'brand-name', d.name);
            const drink = el('span', 'bar-col-drink');
            drink.append(badge, name);
            row.append(drink, el('span', 'bar-col-price', d.price), el('span', 'bar-col-mp', d.memberPrice));
            fit.append(row);
          }
          fit.append(el('p', 'bar-footer', 'Member prices · Must show membership card'));
        } else {
          for (const section of PTFormats.parseMenu(c.text)) {
            const sec = el('div', 'menu-section');
            if (section.title) sec.append(el('h2', '', section.title));
            for (const it of section.items) {
              const row = el('div', `menu-item${it.soldOut ? ' sold-out' : ''}`);
              const name = el('div', 'name', it.name);
              if (it.soldOut) name.append(el('span', 'badge', t('soldOut')));
              if (it.notes) name.append(el('span', 'notes', it.notes));
              row.append(name, el('div', 'dots'), el('div', 'price', it.price));
              sec.append(row);
            }
            fit.append(sec);
          }
        }
        panel.append(fit);
        slide.append(panel);
        break;
      }
      case 'sponsor': {
        const panel = el('section', `panel sponsor layout-${c.layout || 'grid'}`);
        const fit = el('div', 'fit');
        fit.append(el('div', 'kicker', club));
        if (c.title) fit.append(el('h1', '', c.title));
        const grid = el('div', 'sponsor-grid');
        const TIER_COLORS = { gold: '#c9a000', silver: '#909090', bronze: '#a0522d', partner: '#2a6a9a' };
        for (const s of (c.sponsors || [])) {
          const card = el('div', 'sponsor-card');
          let badge;
          if (s.logoSrc || s.logoUrl) {
            badge = document.createElement('img');
            badge.className = 'sponsor-logo';
            badge.src = s.logoSrc || s.logoUrl;
            badge.alt = s.name;
            badge.loading = 'eager';
          } else {
            badge = el('span', 'brand-badge');
            badge.style.background = TIER_COLORS[s.tier] || '#5a5a5a';
            badge.textContent = s.name.slice(0, 2).toUpperCase();
          }
          card.append(badge);
          const info = el('div', 'sponsor-info');
          info.append(el('span', 'sponsor-name', s.name));
          if (s.tagline) info.append(el('span', 'sponsor-tagline', s.tagline));
          if (s.tier) {
            const tierBadge = el('span', `tier-badge tier-${s.tier}`, s.tier.charAt(0).toUpperCase() + s.tier.slice(1));
            info.append(tierBadge);
          }
          card.append(info);
          grid.append(card);
        }
        fit.append(grid);
        panel.append(fit);
        slide.append(panel);
        break;
      }
      case 'fixtures': {
        const panel = el('section', 'panel fixtures');
        panel.append(el('div', 'kicker', club), el('h1', '', c.title || item.name));
        const fit = el('div', 'fit');
        const now = new Date();
        const list = PTFormats.parseFixtures(c.text, { now }).slice(0, c.limit || 8);
        if (!list.length) fit.append(el('p', 'empty-note', t('noUpcoming')));
        const ul = el('ul', 'fixtures-list');
        let highlighted = false;
        for (const f of list) {
          const li = el('li', 'fixture');
          const when = el('div', 'when', f.date ? whenText(f.date, f.hasTime) : f.whenText);
          if (f.date && !highlighted) {
            highlighted = true;
            li.classList.add('next');
            when.append(el('span', 'countdown', countdownText(f.date, f.hasTime)));
          }
          li.append(when, el('div', 'title', f.title), el('div', 'meta', [f.competition, f.venue].filter(Boolean).join(' · ')));
          ul.append(li);
        }
        if (list.length) fit.append(ul);
        panel.append(fit);
        slide.append(panel);
        break;
      }
      case 'scores': {
        const panel = el('section', 'panel scores');
        panel.append(el('div', 'kicker', club), el('h1', '', c.title || item.name));
        const fit = el('div', 'fit');
        if (!item.data) {
          fit.append(el('p', 'empty-note', t('sportsOff')));
        } else if (!item.data.length) {
          fit.append(el('p', 'empty-note', c.show === 'live' ? t('noLiveMatches') : t('noMatches')));
        } else {
          let league = null;
          let list = null;
          for (const e of item.data) {
            if (e.leagueName !== league) {
              league = e.leagueName;
              fit.append(el('h2', 'league', league));
              list = el('ul', 'score-list');
              fit.append(list);
            }
            list.append(scoreRow(e));
          }
        }
        panel.append(fit);
        slide.append(panel);
        break;
      }
      case 'league': {
        // Each panel is its own document from this server (see lib/fulltime.js),
        // which is where the FA's snippet runs and scales itself to the column.
        // Sandboxed without allow-same-origin: the response already says so, and
        // repeating it here means a browser that ignores CSP sandbox still
        // keeps Full-Time's script out of our origin.
        const panel = el('section', 'panel league');
        panel.append(el('div', 'kicker', club), el('h1', '', c.title || item.name));
        const fit = el('div', 'fit');
        const panels = (c.panels || []).slice(0, 3);
        if (!panels.length) {
          fit.append(el('p', 'empty-note', t('noMatches')));
        } else {
          const row = el('div', 'league-panels');
          const loaded = [];
          panels.forEach((p, i) => {
            const col = el('div', 'league-panel');
            if (p.label) col.append(el('h2', '', p.label));
            const frame = el('iframe');
            // The route already answers no-store; the timestamp is there so an
            // edited snippet cannot be held by a cache between here and the Pi.
            frame.src = `/league/${encodeURIComponent(item.assetId)}/${i}?r=${encodeURIComponent(item.updatedAt || '')}`;
            frame.setAttribute('sandbox', 'allow-scripts');
            frame.setAttribute('scrolling', 'no');
            loaded.push(new Promise((r) => frame.addEventListener('load', r, { once: true })));
            col.append(frame);
            row.append(col);
          });
          fit.append(row);
          // Full-Time fills its insert in after the frame loads, so give it a
          // moment to render before the slide fades in.
          ready = withTimeout(Promise.all(loaded).then(() => new Promise((r) => setTimeout(r, 900))), 8000);
        }
        panel.append(fit);
        if (c.credit) panel.append(el('div', 'credit', c.credit));
        slide.append(panel);
        break;
      }
      case 'widget': {
        const w = renderWidget(item);
        if (item.data && item.data.credit) w.el.append(el('div', 'credit', item.data.credit));
        slide.append(w.el);
        if (w.ready) ready = w.ready;
        onShow = w.onShow || null;
        break;
      }
      default:
        throw new Error(`Unknown type ${item.type}`);
    }
    return { el: slide, ready, onShow };
  }

  function teamCell(team, side) {
    const cell = el('span', `team ${side}`);
    const name = el('span', 'team-name', team.name);
    if (team.logo && /^https:\/\//.test(team.logo)) {
      const img = el('img', 'logo');
      img.alt = '';
      img.src = team.logo;
      img.addEventListener('error', () => img.remove());
      if (side === 'home') cell.append(name, img);
      else cell.append(img, name);
    } else {
      cell.append(name);
    }
    return cell;
  }

  function scoreRow(e) {
    const li = el('li', `score-row ${e.status}`);
    const start = e.start ? new Date(e.start) : null;
    const hhmm = start ? start.toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' }) : '';
    let mid;
    if (e.status === 'scheduled') mid = el('span', 'mid vs', hhmm || 'v');
    else if (e.status === 'postponed') mid = el('span', 'mid vs', 'P–P');
    else mid = el('span', 'mid score', `${e.home.score ?? '-'} – ${e.away.score ?? '-'}`);
    let badge;
    if (e.status === 'live') badge = el('span', 'tag live', e.statusText || t('liveNow'));
    else if (e.status === 'final') badge = el('span', 'tag final', e.statusText || t('ft'));
    else if (e.status === 'postponed') badge = el('span', 'tag pp', t('postponed'));
    else badge = el('span', 'tag when', start ? whenText(start, false) : '');
    li.append(badge, teamCell(e.home, 'home'), mid, teamCell(e.away, 'away'));
    return li;
  }


  // ---------------------------------------------------------------- widgets
  const cursors = new Map(); // item id -> how many times shown (cycles jokes, quiz questions…)
  function nextOf(item, list) {
    const i = cursors.get(item.id) || 0;
    cursors.set(item.id, i + 1);
    return list[i % list.length];
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    return e;
  };

  /** Updates clocks and countdowns on screen once a second. */
  function tickLive() {
    const now = new Date();
    for (const e of stage.querySelectorAll('[data-live]')) {
      const kind = e.dataset.live;
      if (kind === 'time') e.textContent = now.toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' });
      else if (kind === 'tztime') e.textContent = now.toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit', timeZone: e.dataset.tz });
      else if (kind === 'tzday') e.textContent = now.toLocaleDateString(loc(), { weekday: 'long', timeZone: e.dataset.tz });
      else if (kind === 'seconds') e.textContent = pad2(now.getSeconds());
      else if (kind === 'date') e.textContent = now.toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      else if (kind === 'hand') {
        const h = now.getHours() % 12;
        const m = now.getMinutes();
        const sec = now.getSeconds();
        const deg = { h: h * 30 + m * 0.5, m: m * 6 + sec * 0.1, s: sec * 6 }[e.dataset.hand];
        e.setAttribute('transform', `rotate(${deg} 100 100)`);
      } else if (kind === 'countdown') {
        const ms = new Date(e.dataset.target).getTime() - now.getTime();
        const parts = e.querySelectorAll('.cd-num');
        if (ms <= 0) {
          e.classList.add('done');
          parts.forEach((p) => { p.textContent = '00'; });
          continue;
        }
        const total = Math.floor(ms / 1000);
        const vals = [Math.floor(total / 86400), Math.floor((total % 86400) / 3600), Math.floor((total % 3600) / 60), total % 60];
        parts.forEach((p, i) => { p.textContent = i === 0 ? String(vals[0]) : pad2(vals[i]); });
      }
    }
  }
  setInterval(tickLive, 1000);

  function widgetPanel(kind, kicker, title) {
    const panel = el('section', `panel widget w-${kind}`);
    panel.append(el('div', 'kicker', kicker));
    if (title) panel.append(el('h1', '', title));
    const fit = el('div', 'fit');
    panel.append(fit);
    return { panel, fit };
  }

  const quizTitle = (topic) => t(`q_${topic || 'sport'}`);
  const triviaTitle = (topic) => (!topic || topic === 'sport' || topic === 'mixed' ? t('dyk') : t('dykTopic', { topic: t(`t_${topic}`) }));

  /** Question, four options, timer bar, answer revealed at 65% of the slide. */
  function renderQuiz(item, q, kicker) {
    const { panel, fit } = widgetPanel('quiz', kicker, '');
    if (!q) return { el: panel };
    if (q.flag) fit.append(el('div', 'quiz-flag', q.flag));
    const qText = q.qtype === 'flag' ? t('flagQ') : q.qtype === 'capital' && q.code ? t('capitalQ', { country: countryName(q.code, q.q) }) : q.q;
    fit.append(el('p', 'quiz-q', qText));
    const grid = el('ol', 'quiz-options');
    q.options.forEach((option, i) => {
      const opt = q.optionCodes && q.optionCodes[i] ? countryName(q.optionCodes[i], option) : option;
      const li = el('li', i === q.answer ? 'right' : 'wrong');
      li.append(el('span', 'quiz-letter', 'ABCD'[i]), el('span', '', opt));
      grid.append(li);
    });
    fit.append(grid);
    return withReveal(panel, 0.65);
  }

  /** Timer bar, then the slide gets .revealed at `at` × its duration. */
  function withReveal(panel, at) {
    const bar = el('div', 'quiz-timer');
    const fill = el('div', '');
    bar.append(fill);
    panel.append(bar);
    return {
      el: panel,
      onShow: (ms) => {
        const revealIn = ms * at;
        fill.style.transitionDuration = `${revealIn}ms`;
        requestAnimationFrame(() => { fill.style.width = '0%'; });
        setTimeout(() => panel.classList.add('revealed'), revealIn);
      },
    };
  }

  function renderWidget(item) {
    const c = item.content || {};
    const d = item.data || {};
    const club = manifest.clubName;

    if (d.error && c.kind !== 'clock') {
      const { panel, fit } = widgetPanel(c.kind, club, c.title || item.name);
      fit.append(el('p', 'empty-note', d.error));
      return { el: panel };
    }

    switch (c.kind) {
      case 'clock': {
        const { panel, fit } = widgetPanel('clock', club, c.title || '');
        if (c.mode === 'analog') {
          const svg = svgEl('svg', { viewBox: '0 0 200 200', class: 'analog' });
          svg.append(svgEl('circle', { cx: 100, cy: 100, r: 96, class: 'face' }));
          for (let i = 0; i < 60; i++) {
            const major = i % 5 === 0;
            svg.append(svgEl('line', { x1: 100, y1: major ? 10 : 8, x2: 100, y2: major ? 24 : 14, class: major ? 'tick major' : 'tick', transform: `rotate(${i * 6} 100 100)` }));
          }
          svg.append(svgEl('line', { x1: 100, y1: 108, x2: 100, y2: 52, class: 'hand h', 'data-live': 'hand', 'data-hand': 'h' }));
          svg.append(svgEl('line', { x1: 100, y1: 112, x2: 100, y2: 30, class: 'hand m', 'data-live': 'hand', 'data-hand': 'm' }));
          svg.append(svgEl('line', { x1: 100, y1: 118, x2: 100, y2: 22, class: 'hand s', 'data-live': 'hand', 'data-hand': 's' }));
          svg.append(svgEl('circle', { cx: 100, cy: 100, r: 4, class: 'pin' }));
          fit.append(svg);
          if (c.showDate !== false) fit.append(el('div', 'clock-date'));
        } else if (c.mode === 'countdown') {
          if (c.label) fit.append(el('div', 'cd-label', c.label));
          const box = el('div', 'countdown-big');
          box.dataset.live = 'countdown';
          box.dataset.target = c.target;
          for (const unit of ['days', 'hours', 'mins', 'secs']) {
            const cell = el('div', 'cd-cell');
            cell.append(el('span', 'cd-num', '--'), el('span', 'cd-unit', t(unit)));
            box.append(cell);
          }
          fit.append(box);
          const when = new Date(c.target);
          fit.append(el('div', 'clock-date static', when.toLocaleString(loc(), { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })));
        } else {
          const time = el('div', 'clock-time');
          const hm = el('span', '');
          hm.dataset.live = 'time';
          const sec = el('span', 'clock-sec');
          sec.dataset.live = 'seconds';
          time.append(hm, sec);
          fit.append(time);
        }
        if (c.mode !== 'countdown' && c.showDate !== false) {
          const date = fit.querySelector('.clock-date') || el('div', 'clock-date');
          date.dataset.live = 'date';
          if (!date.parentNode) fit.append(date);
        }
        return { el: panel };
      }

      case 'weather': {
        const { panel, fit } = widgetPanel('weather', club, c.title || `${t('weather')}${d.place ? ` — ${d.place}` : ''}`);
        const now = el('div', 'wx-now');
        now.append(el('div', 'wx-icon', d.current.icon));
        const info = el('div', 'wx-info');
        info.append(el('div', 'wx-temp', `${d.current.temp}${d.units.temp}`), el('div', 'wx-text', d.current.cond ? t(`c_${d.current.cond}`) : d.current.text), el('div', 'wx-wind', t('wind', { speed: `${d.current.wind} ${d.units.wind}` })));
        now.append(info);
        fit.append(now);
        const days = el('div', 'wx-days');
        (d.days || []).forEach((day, i) => {
          const dt = new Date(`${day.date}T12:00:00`);
          const label = i <= 1 ? rel(i, 'day') : cap1(dt.toLocaleDateString(loc(), { weekday: 'long' }));
          const card = el('div', 'wx-day');
          card.append(el('div', 'wx-day-name', label), el('div', 'wx-day-icon', day.icon), el('div', 'wx-day-temp', `${day.max}° / ${day.min}°`));
          if (day.rain != null) card.append(el('div', 'wx-day-rain', `💧 ${day.rain}%`));
          days.append(card);
        });
        fit.append(days);
        if (d.stale) fit.append(el('p', 'wx-note', t('forecastStale')));
        return { el: panel };
      }

      case 'joke': {
        const joke = nextOf(item, d.items || []);
        const { panel, fit } = widgetPanel('joke', c.title || t('jokeTime'), '');
        if (!joke) return { el: panel };
        fit.append(el('p', 'joke-q', joke.q));
        const a = el('p', 'joke-a', joke.a || '');
        fit.append(a);
        return { el: panel, onShow: (ms) => setTimeout(() => a.classList.add('shown'), ms * 0.5) };
      }

      case 'phrase': {
        const text = nextOf(item, d.items || []);
        const { panel, fit } = widgetPanel('phrase', c.title || club, '');
        fit.append(el('p', 'phrase-text', text || ''));
        return { el: panel };
      }

      case 'trivia': {
        const fact = nextOf(item, d.items || []);
        const { panel, fit } = widgetPanel('trivia', club, c.title || triviaTitle(d.topic));
        fit.append(el('p', 'trivia-text', fact || ''));
        return { el: panel };
      }

      case 'quiz': {
        const q = nextOf(item, d.items || []);
        return renderQuiz(item, q, c.title || quizTitle(d.topic));
      }


      case 'geoquiz': {
        const q = nextOf(item, d.items || []);
        return renderQuiz(item, q, c.title || t({ flags: 'nameFlag', capitals: 'capitals', mixed: 'flagsCapitals' }[d.mode] || 'flagsCapitals'));
      }

      case 'emoji': {
        const e = nextOf(item, d.items || []);
        const { panel, fit } = widgetPanel('emoji', c.title || t('emojiQuiz'), '');
        if (!e) return { el: panel };
        fit.append(el('p', 'emoji-prompt', t(['Film', 'TV', 'Song'].includes(e.category) ? `g_${e.category}` : 'g_any')), el('div', 'emoji-clue', e.emoji));
        fit.append(el('p', 'emoji-answer', e.answer));
        return withReveal(panel, 0.6);
      }

      case 'country': {
        const ct = nextOf(item, d.items || []);
        const { panel, fit } = widgetPanel('country', club, c.title || t('countryDay'));
        if (!ct) return { el: panel };
        const card = el('div', 'country-card');
        const facts = el('dl', 'country-facts');
        for (const [k, val] of [[t('capital'), ct.capital], [t('continent'), t(`ct_${ct.continent}`)], [t('currency'), ct.currency]]) facts.append(el('dt', '', k), el('dd', '', val));
        const text = el('div', '');
        text.append(el('div', 'country-name', ct.code ? countryName(ct.code, ct.name) : ct.name), facts);
        card.append(el('div', 'country-flag', ct.flag), text);
        fit.append(card);
        return { el: panel };
      }

      case 'worldclock': {
        const { panel, fit } = widgetPanel('worldclock', club, c.title || t('worldClocks'));
        const grid = el('div', 'world-grid');
        for (const z of c.zones || []) {
          const card = el('div', 'world-card');
          const time = el('div', 'world-time');
          time.dataset.live = 'tztime';
          time.dataset.tz = z.tz;
          const day = el('div', 'world-day');
          day.dataset.live = 'tzday';
          day.dataset.tz = z.tz;
          card.append(el('div', 'world-city', z.label), time, day);
          grid.append(card);
        }
        fit.append(grid);
        return { el: panel };
      }

      case 'history': {
        const histLabel = !d.month ? d.label
          : d.scopeUsed === 'day' ? t('onThisDay', { date: dayMonth(d.month, d.day) })
            : d.scopeUsed === 'week' ? t(`week_${d.topic || 'sport'}`)
              : t(`month_${d.topic || 'sport'}`, { month: cap1(monthName(d.month)) });
        const { panel, fit } = widgetPanel('history', club, c.title || histLabel);
        const list = el('ul', 'history-list');
        for (const it of d.items || []) {
          const li = el('li', it.tag || (it.sport ? 'sport' : 'general'));
          const [mm, dd] = it.date.split('-').map(Number);
          const when = new Date(2000, mm - 1, dd).toLocaleDateString(loc(), { day: 'numeric', month: 'short' });
          li.append(el('span', 'year', String(it.year)), el('span', 'text', it.text), el('span', 'when', d.scopeUsed === 'day' ? '' : when));
          list.append(li);
        }
        fit.append(list);
        return { el: panel };
      }


      case 'transport': {
        const { panel, fit } = widgetPanel('transport', club, c.title || t('transport'));
        const grid = el('div', `tx-grid n${Math.min((d.sections || []).length, 4)}`);
        for (const sec of d.sections || []) {
          const box = el('section', `tx-box tx-${sec.key}`);
          const secTitle = sec.customTitle || {
            tracker: sec.routes ? t('liveBuses', { routes: sec.routes.join(', ') }) : sec.title,
            trains: sec.station ? t('departuresAt', { station: sec.station }) : t('departures'),
            buses: sec.stop ? t('busesAt', { stop: sec.stop }) : t('buses'),
            lines: t('lines'), roads: t('roads'), planes: t('planes'),
          }[sec.key] || sec.title;
          box.append(el('h2', '', `${{ tracker: '🚌', trains: '🚆', buses: '🚌', lines: '🚇', roads: '🚗', planes: '✈️' }[sec.key] || ''} ${secTitle}`));
          if (sec.error) {
            box.append(el('p', 'tx-empty', sec.error));
          } else if (sec.key === 'trains') {
            for (const m of sec.messages || []) box.append(el('p', 'tx-msg', m));
            const ul = el('ul', 'tx-list');
            for (const tr of sec.services || []) {
              const li = el('li', tr.cancelled ? 'bad' : /on time/i.test(tr.expected) ? 'good' : 'warn');
              li.append(el('span', 'tx-time', tr.time), el('span', 'tx-main', tr.destination), el('span', 'tx-side', tr.cancelled ? t('cancelled') : `${tr.expected}${tr.platform ? ` · P${tr.platform}` : ''}`));
              ul.append(li);
            }
            if (!(sec.services || []).length) box.append(el('p', 'tx-empty', t('noDepartures')));
            box.append(ul);
          } else if (sec.key === 'buses') {
            const ul = el('ul', 'tx-list');
            for (const a of sec.arrivals || []) {
              const li = el('li', '');
              li.append(el('span', 'tx-route', a.line), el('span', 'tx-main', a.destination), el('span', 'tx-side', a.minutes <= 1 ? t('due') : t('min', { n: a.minutes })));
              ul.append(li);
            }
            if (!(sec.arrivals || []).length) box.append(el('p', 'tx-empty', t('noBusesDue')));
            box.append(ul);
          } else if (sec.key === 'tracker') {
            const ul = el('ul', 'tx-list');
            for (const b of sec.buses || []) {
              const li = el('li', '');
              li.append(el('span', 'tx-route', b.line), el('span', 'tx-main', t('toward', { place: b.destination || '—' })), el('span', 'tx-side', `${b.distanceKm} km ${b.direction}${b.minutesAgo ? ` · ${rel(-b.minutesAgo, 'minute')}` : ''}`));
              ul.append(li);
            }
            if (!(sec.buses || []).length) box.append(el('p', 'tx-empty', t('noTracked', { km: sec.radiusKm })));
            box.append(ul);
          } else if (sec.key === 'lines') {
            const ul = el('ul', 'tx-lines');
            for (const l of sec.lines || []) {
              const li = el('li', l.severity >= 10 ? 'good' : l.severity >= 9 ? 'warn' : 'bad');
              li.append(el('span', `tx-swatch line-${l.id}`, ''), el('span', 'tx-main', l.name), el('span', 'tx-side', l.status));
              ul.append(li);
            }
            box.append(ul);
          } else if (sec.key === 'roads') {
            const ul = el('ul', 'tx-lines');
            for (const r of sec.roads || []) {
              const li = el('li', r.status === 'Good' ? 'good' : /Serious|Severe|Closure/.test(r.status) ? 'bad' : 'warn');
              li.append(el('span', 'tx-route', r.name), el('span', 'tx-main', r.detail || r.status), el('span', 'tx-side', r.status));
              ul.append(li);
            }
            box.append(ul);
          } else if (sec.key === 'planes') {
            const ul = el('ul', 'tx-list');
            for (const a of sec.aircraft || []) {
              const li = el('li', '');
              li.append(el('span', 'tx-route', a.callsign), el('span', 'tx-main', [a.type, a.altitudeFt ? `${a.altitudeFt.toLocaleString(loc())} ft` : ''].filter(Boolean).join(' · ')), el('span', 'tx-side', `${a.distanceKm} km`));
              ul.append(li);
            }
            if (!(sec.aircraft || []).length) box.append(el('p', 'tx-empty', t('noAircraft', { km: sec.radiusKm })));
            box.append(ul);
          }
          grid.append(box);
        }
        fit.append(grid);
        return { el: panel };
      }

      case 'bankholiday': {
        const { panel, fit } = widgetPanel('list', club, c.title || t('bankHols', { nation: t(`n_${d.division}`) }));
        const ul = el('ul', 'info-list');
        for (const h of d.items || []) {
          const li = el('li', '');
          const when = new Date(`${h.date}T12:00:00`).toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long' });
          li.append(el('span', 'big', h.title), el('span', '', when), el('span', 'tag-pill', rel(h.daysAway, 'day')));
          ul.append(li);
        }
        fit.append(ul);
        return { el: panel };
      }

      case 'floods': {
        const { panel, fit } = widgetPanel('floods', club, c.title || t('floods'));
        if (!(d.items || []).length) {
          fit.append(el('div', 'all-clear', '✅'), el('p', 'all-clear-text', t('noFloods', { km: d.radius })));
        } else {
          const ul = el('ul', 'info-list');
          for (const f of d.items) {
            const li = el('li', `flood-${f.level}`);
            li.append(el('span', 'tag-pill', f.severity), el('span', 'big', f.area), el('span', '', f.county));
            ul.append(li);
          }
          fit.append(ul);
        }
        return { el: panel };
      }

      case 'carbon': {
        const { panel, fit } = widgetPanel('carbon', club, c.title || t('electricity', { region: d.region }));
        const idx = String(d.intensity?.index || '').toLowerCase();
        const head = el('div', `carbon-head idx-${idx.replace(/\s+/g, '-')}`);
        head.append(el('div', 'carbon-index', idx ? t(`i_${idx}`) : '—'), el('div', 'carbon-value', `${d.intensity?.actual ?? d.intensity?.forecast ?? '—'} gCO₂/kWh`));
        fit.append(head);
        const bars = el('div', 'mix');
        for (const m of (d.mix || []).slice(0, 7)) {
          const row = el('div', 'mix-row');
          const bar = el('div', 'mix-bar');
          const fill = el('div', `mix-fill fuel-${m.fuel}`);
          fill.style.width = `${Math.min(100, m.perc)}%`;
          bar.append(fill);
          row.append(el('span', 'mix-fuel', t(`f_${m.fuel}`)), bar, el('span', 'mix-perc', `${m.perc}%`));
          bars.append(row);
        }
        fit.append(bars);
        return { el: panel };
      }

      case 'quakes': {
        const { panel, fit } = widgetPanel('list', club, c.title || t('quakes'));
        const ul = el('ul', 'info-list');
        for (const q of d.items || []) {
          const li = el('li', q.mag >= 6 ? 'quake-big' : '');
          const ago = q.time ? Math.round((Date.now() - Date.parse(q.time)) / 3_600_000) : null;
          li.append(el('span', 'tag-pill', `M${q.mag.toFixed(1)}`), el('span', 'big', q.place), el('span', '', ago === null ? '' : ago < 24 ? rel(-ago, 'hour') : rel(-Math.round(ago / 24), 'day')));
          ul.append(li);
        }
        if (!(d.items || []).length) fit.append(el('p', 'empty-note', t('noQuakes')));
        fit.append(ul);
        return { el: panel };
      }

      case 'currency': {
        const FLAGS = { EUR: '🇪🇺', USD: '🇺🇸', GBP: '🇬🇧', JPY: '🇯🇵', AUD: '🇦🇺', CAD: '🇨🇦', CHF: '🇨🇭', CNY: '🇨🇳', SEK: '🇸🇪', NOK: '🇳🇴', DKK: '🇩🇰', PLN: '🇵🇱', NZD: '🇳🇿', INR: '🇮🇳', ZAR: '🇿🇦', TRY: '🇹🇷', HKD: '🇭🇰', SGD: '🇸🇬', MXN: '🇲🇽', BRL: '🇧🇷', CZK: '🇨🇿', HUF: '🇭🇺', ISK: '🇮🇸', KRW: '🇰🇷', THB: '🇹🇭' };
        const { panel, fit } = widgetPanel('currency', club, c.title || `${t('fx')} — ${FLAGS[d.base] || ''} 1 ${d.base}`);
        const grid = el('div', 'fx-grid');
        for (const r of d.rates || []) {
          const card = el('div', 'fx-card');
          card.append(el('div', 'fx-flag', FLAGS[r.code] || '💱'), el('div', 'fx-rate', r.rate >= 100 ? r.rate.toFixed(0) : r.rate.toFixed(r.rate >= 10 ? 2 : 4)), el('div', 'fx-code', r.code));
          grid.append(card);
        }
        fit.append(grid);
        if (d.date) fit.append(el('p', 'wx-note', t('fxDate', { date: new Date(`${d.date}T12:00:00`).toLocaleDateString(loc(), { day: 'numeric', month: 'long', year: 'numeric' }) })));
        return { el: panel };
      }

      case 'potd': {
        const wrap = el('section', 'potd');
        const img = el('img', 'potd-img');
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.src = d.src;
        const cap = el('div', 'potd-caption');
        cap.append(el('strong', '', c.title || t('potd')), el('span', '', d.description || d.title || ''));
        wrap.append(img, cap);
        return { el: wrap, ready: withTimeout(img.decode(), 10000) };
      }

      case 'births': {
        const { panel, fit } = widgetPanel('history', club, c.title || (d.month ? t('born', { date: dayMonth(d.month, d.day) }) : d.label));
        const list = el('ul', 'history-list');
        for (const it of d.items || []) {
          const li = el('li', 'general');
          li.append(el('span', 'year', String(it.year)), el('span', 'text', it.text), el('span', 'when', ''));
          list.append(li);
        }
        fit.append(list);
        return { el: panel };
      }

      case 'sky': {
        const { panel, fit } = widgetPanel('sky', club, c.title || `${t('sky')}${d.place ? ` — ${d.place}` : ''}`);
        const grid = el('div', 'sky-grid');
        const card = (icon, label, value) => { const x = el('div', 'sky-card'); x.append(el('div', 'sky-icon', icon), el('div', 'sky-value', value || '—'), el('div', 'sky-label', label)); return x; };
        grid.append(card('🌅', t('sunrise'), d.sunrise), card('🌇', t('sunset'), d.sunset), card('☀️', t('daylight'), d.dayLength), card(d.moon?.emoji || '🌙', t('lit', { n: d.moon?.illumination ?? '—' }), Number.isInteger(d.moon?.index) ? t(`m${d.moon.index}`) : d.moon?.name));
        fit.append(grid);
        return { el: panel };
      }

      case 'headlines': {
        const { panel, fit } = widgetPanel('list', d.title || club, c.title || t('news'));
        const ul = el('ul', 'info-list news');
        for (const it of d.items || []) {
          const li = el('li', '');
          li.append(el('span', 'big', it.title), el('span', '', it.date ? new Date(it.date).toLocaleDateString(loc(), { day: 'numeric', month: 'short' }) : ''));
          ul.append(li);
        }
        if (!(d.items || []).length) fit.append(el('p', 'empty-note', t('noNews')));
        fit.append(ul);
        return { el: panel };
      }

      case 'events': {
        const { panel, fit } = widgetPanel('list', d.title || club, c.title || t('comingUp'));
        const ul = el('ul', 'info-list');
        for (const ev of d.items || []) {
          const li = el('li', '');
          const start = new Date(ev.start);
          const when = ev.allDay
            ? start.toLocaleDateString(loc(), { weekday: 'short', day: 'numeric', month: 'short' })
            : `${start.toLocaleDateString(loc(), { weekday: 'short', day: 'numeric', month: 'short' })} · ${start.toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' })}`;
          li.append(el('span', 'tag-pill', when), el('span', 'big', ev.title), el('span', '', ev.location || ''));
          ul.append(li);
        }
        if (!(d.items || []).length) fit.append(el('p', 'empty-note', t('noEvents')));
        fit.append(ul);
        return { el: panel };
      }

      case 'spotball': {
        const wrap = el('section', 'spotball');
        const frame = el('div', 'sb-frame');
        const img = el('img', 'sb-img');
        img.alt = '';
        img.src = d.src;
        frame.append(img);
        if (d.patch) {
          const patch = el('div', 'sb-patch');
          patch.style.left = `${d.patch.x}%`;
          patch.style.top = `${d.patch.y}%`;
          patch.style.width = `${d.patch.r * 2}%`;
          frame.append(patch);
        }
        if (d.grid) {
          const grid = el('div', 'sb-grid');
          grid.style.backgroundSize = `${100 / d.grid.cols}% ${100 / d.grid.rows}%`;
          for (let i = 0; i < d.grid.cols; i++) {
            const lab = el('span', 'sb-col', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i]);
            lab.style.left = `${(i + 0.5) * (100 / d.grid.cols)}%`;
            grid.append(lab);
          }
          for (let j = 0; j < d.grid.rows; j++) {
            const lab = el('span', 'sb-row', String(j + 1));
            lab.style.top = `${(j + 0.5) * (100 / d.grid.rows)}%`;
            grid.append(lab);
          }
          frame.append(grid);
        }
        if (d.answer) {
          const mark = el('div', 'sb-answer');
          mark.style.left = `${d.answer.x}%`;
          mark.style.top = `${d.answer.y}%`;
          frame.append(mark);
        }
        const caption = el('div', 'sb-caption');
        caption.append(el('strong', '', c.title || t('spot')));
        if (d.answer) {
          caption.append(el('span', 'sb-result', t('answerIs', { cell: d.answer.cell })));
        } else {
          const parts = [t('whereBall'), d.grid ? t('pickSquare') : ''];
          if (d.revealAt) parts.push(t('revealAt', { when: new Date(d.revealAt).toLocaleString(loc(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }));
          caption.append(el('span', '', parts.filter(Boolean).join(' · ')));
        }
        if (d.prize) caption.append(el('span', 'sb-prize', `🏆 ${d.prize}`));
        wrap.append(frame, caption);
        const ready = withTimeout(img.decode(), 8000).then(() => {
          if (!img.naturalWidth || !img.naturalHeight) return;
          // Largest box with the photo's own proportions, so grid and blur line up with the picture.
          const ratio = img.naturalWidth / img.naturalHeight;
          frame.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
          frame.style.width = `min(94cqw, calc((100cqh - 15cqmin) * ${ratio.toFixed(4)}))`;
        });
        return { el: wrap, ready };
      }

      default:
        throw new Error(`Unknown widget ${c.kind}`);
    }
  }

  /** Shrink a text slide's font until its content fits on screen. */
  function fitText(slide) {
    const panel = slide.querySelector('.panel');
    if (!panel) return;
    const fit = panel.querySelector('.fit');
    panel.style.fontSize = '';
    let size = parseFloat(getComputedStyle(panel).fontSize);
    const min = size * 0.4;
    const overflows = () =>
      panel.scrollHeight > panel.clientHeight + 1 ||
      (fit && (fit.scrollHeight > fit.clientHeight + 1 || fit.scrollWidth > fit.clientWidth + 1));
    while (overflows() && size > min) {
      size *= 0.93;
      panel.style.fontSize = `${size}px`;
    }
  }

  // ---------------------------------------------------------------- chrome
  let tickerText = null;
  function applyChrome() {
    const rotation = (manifest.screen && manifest.screen.rotation) || 0;
    root.className = rotation ? `rotate-${rotation}` : '';
    document.title = manifest.screen ? `${manifest.screen.name} · PitchTribe` : 'Preview · PitchTribe';

    const pl = manifest.playlist || {};
    $('#clock').hidden = !pl.showClock;
    updateClock();

    const text = (pl.ticker || '').trim();
    if (text === tickerText) return;
    tickerText = text;
    const ticker = $('#ticker');
    const track = ticker.querySelector('.ticker-track');
    track.replaceChildren();
    if (!text) {
      ticker.hidden = true;
      document.documentElement.style.setProperty('--ticker-h', '0px');
      return;
    }
    ticker.hidden = false;
    document.documentElement.style.setProperty('--ticker-h', '6.5vmin');
    for (const line of text.split(/\n+/).map((l) => l.trim()).filter(Boolean)) track.append(el('span', '', line));
    requestAnimationFrame(() => {
      const pxPerSec = Math.max(root.clientHeight, 300) * 0.14;
      track.style.animationDuration = `${Math.max(track.scrollWidth / pxPerSec, 8)}s`;
    });
  }

  function updateClock() {
    const clock = $('#clock');
    if (clock.hidden) return;
    clock.textContent = new Date().toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' });
  }

  function showSplash(msg, meta) {
    const splash = $('#splash');
    splash.querySelector('.splash-title').textContent = (manifest && manifest.clubName) || 'PitchTribe';
    splash.querySelector('.splash-msg').textContent = msg;
    splash.querySelector('.splash-meta').textContent = meta || '';
    splash.hidden = false;
  }
  const hideSplash = () => { $('#splash').hidden = true; };

  function showIdle() {
    const dash = (manifest.dashboardUrls && manifest.dashboardUrls[0]) || `${location.origin}/`;
    if (previewId) {
      showSplash('Nothing in this playlist is scheduled to play right now.', '');
    } else if (!manifest.playlist) {
      showSplash(t('noPlaylist'), t('screenAt', { name: screenId, url: dash }));
    } else {
      showSplash(t('nothingNow'), t('screenAt', { name: manifest.screen.name, url: dash }));
    }
  }

  let identifyTimer = null;
  function identify(data) {
    const box = $('#identify');
    box.replaceChildren(el('div', '', data.name || screenId), el('small', '', `screen id: ${data.id || screenId}`));
    box.hidden = false;
    clearTimeout(identifyTimer);
    identifyTimer = setTimeout(() => { box.hidden = true; }, 10000);
  }

  // ------------------------------------------------------------------ boot
  setInterval(updateClock, 1000);
  // Re-check schedules: drop the current slide if its time window just ended.
  setInterval(() => {
    if (!manifest) return;
    if (current && !PTSchedule.isLive(current.item)) next();
  }, 30_000);

  if (previewId) {
    setInterval(load, 10_000);
  } else {
    setInterval(load, 60_000); // heartbeat + fallback if push is unavailable
    if ('EventSource' in window) {
      const es = new EventSource(`/api/player/${encodeURIComponent(screenId)}/events`);
      es.addEventListener('open', () => scheduleLoad());
      es.addEventListener('changed', () => scheduleLoad());
      es.addEventListener('identify', (e) => identify(JSON.parse(e.data || '{}')));
      es.addEventListener('reload', () => location.reload());
    }
  }
  load();
})();
