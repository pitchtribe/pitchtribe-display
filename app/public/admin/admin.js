/* PitchTribe dashboard — a small dependency-free single-page app.
   Routes: #/content  #/playlists  #/playlists/<id>  #/screens  #/settings */
(() => {
  'use strict';

  const appEl = document.getElementById('app');
  let state = null; // GET /api/state
  let dirty = false; // unsaved playlist edits
  let currentView = null;
  const dashboardLanguages = window.PTI18n.LANGUAGES;
  const dashboardLocaleKey = 'pitchtribe.dashboard.language';
  const dashboardLabels = {
    fr: ['Contenu', 'Listes de lecture', 'Écrans', 'Wi-Fi', 'Personnes', 'Paramètres', 'Déconnexion', 'Connexion', 'Mot de passe'],
    es: ['Contenido', 'Listas de reproducción', 'Pantallas', 'Wi-Fi', 'Personas', 'Ajustes', 'Cerrar sesión', 'Iniciar sesión', 'Contraseña'],
    de: ['Inhalte', 'Wiedergabelisten', 'Bildschirme', 'WLAN', 'Personen', 'Einstellungen', 'Abmelden', 'Anmelden', 'Passwort'],
    it: ['Contenuti', 'Playlist', 'Schermi', 'Wi-Fi', 'Persone', 'Impostazioni', 'Esci', 'Accedi', 'Password'],
    pt: ['Conteúdo', 'Listas de reprodução', 'Ecrãs', 'Wi-Fi', 'Pessoas', 'Definições', 'Terminar sessão', 'Iniciar sessão', 'Palavra-passe'],
    pl: ['Treści', 'Listy odtwarzania', 'Ekrany', 'Wi-Fi', 'Osoby', 'Ustawienia', 'Wyloguj się', 'Zaloguj się', 'Hasło'],
    ru: ['Контент', 'Плейлисты', 'Экраны', 'Wi-Fi', 'Люди', 'Настройки', 'Выйти', 'Войти', 'Пароль'],
    zh: ['内容', '播放列表', '屏幕', 'Wi-Fi', '人员', '设置', '退出登录', '登录', '密码'],
    ja: ['コンテンツ', 'プレイリスト', '画面', 'Wi-Fi', 'ユーザー', '設定', 'ログアウト', 'ログイン', 'パスワード'],
  };
  const dashboardKeys = ['Content', 'Playlists', 'Screens', 'Wi-Fi', 'People', 'Settings', 'Sign out', 'Sign in', 'Password'];
  const dashboardMaps = Object.fromEntries(Object.entries(dashboardLabels).map(([code, labels]) =>
    [code, Object.fromEntries(dashboardKeys.map((key, i) => [key, labels[i]]))]));
  const screenStrings = Object.fromEntries(Object.entries(window.PTI18n.STRINGS.en).map(([key, english]) => [english, key]));
  let dashboardLanguage = (() => {
    const saved = localStorage.getItem(dashboardLocaleKey);
    const browser = navigator.language.slice(0, 2).toLowerCase();
    return dashboardLanguages.some((lang) => lang.code === saved) ? saved
      : dashboardLanguages.some((lang) => lang.code === browser) ? browser : 'en';
  })();
  function translate(value) {
    if (dashboardLanguage === 'en' || typeof value !== 'string') return value;
    return dashboardMaps[dashboardLanguage]?.[value]
      || window.PTDashboardTranslations?.[dashboardLanguage]?.[value]
      || window.PTI18n.STRINGS[dashboardLanguage]?.[screenStrings[value]] || value;
  }
  // Interpolated values (club names, member names and other authored text) stay verbatim.
  function localize(strings, ...values) {
    const key = strings.reduce((text, part, i) => text + part + (i < values.length ? `__VAR${i}__` : ''), '');
    return translate(key).replace(/__VAR(\d+)__/g, (_, index) => String(values[Number(index)]));
  }
  function languagePicker() {
    return h('select', { class: 'dashboard-language', 'aria-label': translate('Dashboard language'),
      onchange: (event) => {
        dashboardLanguage = event.target.value;
        localStorage.setItem(dashboardLocaleKey, dashboardLanguage);
        document.documentElement.lang = window.PTI18n.LANGUAGES.find((lang) => lang.code === dashboardLanguage).locale;
        document.title = `PitchTribe ${translate('Dashboard')}`;
        if (state) render(); else boot();
      } }, dashboardLanguages.map((lang) => h('option', { value: lang.code, selected: lang.code === dashboardLanguage }, lang.name)));
  }
  document.documentElement.lang = dashboardLanguages.find((lang) => lang.code === dashboardLanguage).locale;
  document.title = `PitchTribe ${translate('Dashboard')}`;
  const bootMessage = appEl.querySelector('.boot');
  if (bootMessage) bootMessage.textContent = translate('Loading…');

  // ================================================================ helpers
  const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'multiple', 'draggable', 'indeterminate']);

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v; // CSSOM: allowed by our CSP, unlike style=""
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const ICONS = {
    image: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M15 9.5a1.5 1.5 0 1 0 0-.01',
    video: 'M4 6h11v12H4z M15 10l5-3v10l-5-3',
    url: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18',
    notice: 'M4 10v4h3l6 4V6L7 10z M16 9a4 4 0 0 1 0 6 M18.5 6.5a7.5 7.5 0 0 1 0 11',
    menu: 'M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5',
    fixtures: 'M4 6h16v14H4z M4 10h16 M8 3v5 M16 3v5 M8 14h3',
    league: 'M4 5h16v14H4z M4 9.5h16 M4 14h16 M9 5v14',
    weather: 'M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 11 3.5 3.5 0 0 0 7 18z',
    smile: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M8 14s1.5 2 4 2 4-2 4-2 M9 9h.01 M15 9h.01',
    quote: 'M7 7h4v5c0 3-2 5-4 5 M14 7h4v5c0 3-2 5-4 5',
    bulb: 'M9 18h6 M10 21h4 M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z',
    quiz: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7v.5 M12 17h.01',
    history: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z M4 19V5 M9 7h6',
    ball: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M12 7l3.5 2.5-1.3 4h-4.4l-1.3-4z M12 3v4 M15.5 9.5l4.5-1.5 M14.2 13.5l2.8 3.5 M9.8 13.5L7 17 M8.5 9.5L4 8',
    film: 'M4 4h16v16H4z M8 4v16 M16 4v16 M4 9h4 M4 15h4 M16 9h4 M16 15h4',
    flag: 'M5 21V4 M5 4h11l-2 4 2 4H5',
    globe: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18',
    bus: 'M6 4h12a2 2 0 0 1 2 2v11H4V6a2 2 0 0 1 2-2z M4 11h16 M7 20v-3 M17 20v-3 M7.5 14h.01 M16.5 14h.01',
    bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
    coin: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M15 9.5a3 3 0 0 0-3-1.5c-1.7 0-3 .9-3 2s1.3 1.6 3 2 3 .9 3 2-1.3 2-3 2a3 3 0 0 1-3-1.5 M12 6v12',
    moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
    rss: 'M5 19h.01 M5 12a7 7 0 0 1 7 7 M5 5a14 14 0 0 1 14 14',
    drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
    cake: 'M4 21h16 M5 21v-7h14v7 M5 16c2 1 3-1 5 0s3 1 5 0 3-1 4 0 M12 14v-3 M12 8a1.5 1.5 0 0 0 1.5-1.5C13.5 5 12 3.5 12 3.5S10.5 5 10.5 6.5A1.5 1.5 0 0 0 12 8z',
    widget: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M16.5 13v7 M13 16.5h7',
    wifi: 'M2 8.5a15 15 0 0 1 20 0 M5.5 12a10 10 0 0 1 13 0 M9 15.5a5 5 0 0 1 6 0 M12 19h.01',
    scores: 'M8 21h8 M12 17v4 M7 4h10v5a5 5 0 0 1-10 0z M7 6H4v1a3 3 0 0 0 3 3 M17 6h3v1a3 3 0 0 1-3 3',
    content: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
    playlist: 'M4 6h12 M4 12h12 M4 18h8 M17 15l4 2.5-4 2.5z',
    screen: 'M3 5h18v12H3z M8 21h8 M12 17v4',
    settings: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6 M12 2v3 M12 19v3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M2 12h3 M19 12h3 M4.9 19.1 7 17 M17 7l2.1-2.1',
    plus: 'M12 5v14 M5 12h14',
    upload: 'M12 16V4 M7 9l5-5 5 5 M4 16v4h16v-4',
    trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
    up: 'M6 15l6-6 6 6',
    down: 'M6 9l6 6 6-6',
    grip: 'M9 6h.01 M15 6h.01 M9 12h.01 M15 12h.01 M9 18h.01 M15 18h.01',
    clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M12 7v5l3 2',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
    back: 'M15 6l-6 6 6 6',
    x: 'M6 6l12 12 M18 6L6 18',
    logout: 'M15 4h4v16h-4 M10 8l-4 4 4 4 M6 12h10',
    copy: 'M8 8h12v12H8z M4 16V4h12',
    target: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8 M12 11.5v1',
    refresh: 'M20 12a8 8 0 1 1-2.3-5.6 M20 4v5h-5',
    external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
    sponsor: 'M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.8l-4.9 2.4.9-5.5-4-3.9 5.5-.8z',
    people: 'M9 4.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7 M2.5 20v-1c0-2.5 2.9-4 6.5-4s6.5 1.5 6.5 4v1 M16.5 4.9a3.5 3.5 0 0 1 0 6.2 M18 15.3c2.1.6 3.5 1.9 3.5 3.7v1',
    key: 'M15 3a6 6 0 1 0-4.2 10.3L4 20v1h3v-2h2v-2h1.8A6 6 0 0 0 15 3z M16.5 7.5h.01',
  };
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', name === 'grip' ? '3' : '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name] || ICONS.content);
    svg.append(path);
    return svg;
  }
  function logo() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML =
      '<path d="M16 4 27 10.5v11L16 28 5 21.5v-11z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M16 10.5 21.5 13.5v5L16 21.5 10.5 18.5v-5z" fill="currentColor"/>';
    return svg;
  }

  const TYPE_LABEL = { image: 'Image', video: 'Video', url: 'Web page', notice: 'Notice', menu: 'Menu board', fixtures: 'Fixtures', scores: 'Live scores', league: 'League table', widget: 'Widget', sponsor: 'Sponsors' };
  const WIDGETS = {
    clock: { name: 'Clock', icon: 'clock', blurb: 'Big digital or analogue clock, or a countdown to kick-off.' },
    worldclock: { name: 'World clocks', icon: 'globe', blurb: 'The time in up to eight cities around the world.' },
    weather: { name: 'Weather', icon: 'weather', blurb: 'Current conditions and forecast for your ground.' },
    joke: { name: 'Joke', icon: 'smile', blurb: 'Family-friendly sports jokes — punchline revealed halfway.' },
    phrase: { name: 'Phrase', icon: 'quote', blurb: 'Club-spirit phrases in big type, or your own.' },
    trivia: { name: 'Did you know?', icon: 'bulb', blurb: 'Trivia facts: sport, film & TV, music, geography or culture.' },
    quiz: { name: 'Quiz', icon: 'quiz', blurb: 'Multiple-choice questions with an answer reveal: sport, film & TV, music, geography, culture or a mix.' },
    emoji: { name: 'Emoji quiz', icon: 'film', blurb: 'Guess the film, TV show or song from emojis.' },
    geoquiz: { name: 'Flags & capitals', icon: 'flag', blurb: 'Name the country from its flag, or its capital city.' },
    country: { name: 'Country of the day', icon: 'globe', blurb: 'A country’s flag, capital, continent and currency.' },
    history: { name: 'On this day', icon: 'history', blurb: 'This day, week or month in sporting or TV, film & music history.' },
    spotball: { name: 'Spot the ball', icon: 'ball', blurb: 'Your photo, a grid and a blurred ball — answer revealed when you choose.' },
    transport: { name: 'Transport hub', icon: 'bus', blurb: 'Live bus tracker, train departures, London buses, tube status, roads and planes overhead.' },
    sky: { name: 'Sunrise, sunset & moon', icon: 'moon', blurb: 'Sun times and moon phase for your ground. Works offline.' },
    floods: { name: 'Flood warnings', icon: 'drop', blurb: 'Environment Agency warnings near your ground (England).' },
    bankholiday: { name: 'Bank holidays', icon: 'fixtures', blurb: 'The next UK bank holidays, from GOV.UK.' },
    carbon: { name: 'Grid carbon', icon: 'bolt', blurb: 'How green Britain’s electricity is right now, with the fuel mix.' },
    currency: { name: 'Exchange rates', icon: 'coin', blurb: 'Daily European Central Bank reference rates.' },
    quakes: { name: 'Earthquakes', icon: 'globe', blurb: 'Recent earthquakes worldwide, from the USGS.' },
    potd: { name: 'Picture of the day', icon: 'image', blurb: 'Wikimedia Commons’ picture of the day, full screen.' },
    births: { name: 'Born on this day', icon: 'cake', blurb: 'Famous birthdays today, from Wikipedia.' },
    headlines: { name: 'News headlines', icon: 'rss', blurb: 'Headlines from any RSS or Atom feed — your club, league or local news.' },
    events: { name: 'Calendar', icon: 'fixtures', blurb: 'Upcoming events from any iCal (.ics) calendar, e.g. Google Calendar.' },
  };
  const WIDGET_GROUPS = [
    ['Time & weather', ['clock', 'worldclock', 'weather', 'sky']],
    ['Out and about', ['transport', 'floods', 'bankholiday', 'carbon']],
    ['Quizzes & fun', ['quiz', 'emoji', 'geoquiz', 'joke', 'spotball', 'phrase']],
    ['Knowledge', ['trivia', 'history', 'births', 'country', 'potd', 'quakes', 'currency']],
    ['Your feeds', ['headlines', 'events']],
  ];
  const typeLabel = (a) => translate(a && a.type === 'widget' ? WIDGETS[a.content?.kind]?.name || 'Widget' : TYPE_LABEL[a?.type] || '');
  const STATUS_LABEL = { live: 'Live now', scheduled: 'Scheduled', expired: 'Expired', 'off-hours': 'Off-hours', disabled: 'Off' };
  const NOTICE_STYLES = [
    ['default', 'Navy', '#0e1e30'],
    ['accent', 'Pitch green', '#0a3a2e'],
    ['amber', 'Amber', '#3d2c05'],
    ['alert', 'Alert red', '#4a0f12'],
    ['light', 'Light', '#f3f7fa'],
  ];

  function fmtDuration(sec) {
    if (!sec) return translate('full length');
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const fmtLoop = (sec) => (sec ? fmtDuration(sec) : '0s');
  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }
  function ago(ts) {
    if (!ts) return translate('never');
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return translate('just now');
    const relative = new Intl.RelativeTimeFormat(document.documentElement.lang, { numeric: 'auto', style: 'short' });
    if (s < 3600) return relative.format(-Math.round(s / 60), 'minute');
    if (s < 86400) return relative.format(-Math.round(s / 3600), 'hour');
    return new Date(ts).toLocaleString(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'short' });
  }
  const assetById = (id) => state.assets.find((a) => a.id === id);
  const usage = (assetId) => state.playlists.filter((p) => p.items.some((it) => it.assetId === assetId)).length;
  const baseUrl = () =>
    ['localhost', '127.0.0.1', '::1'].includes(location.hostname) && state?.dashboardUrls?.length
      ? state.dashboardUrls[0].replace(/\/$/, '')
      : location.origin;

  function toast(msg, kind = 'ok') {
    const t = h('div', { class: `toast ${kind === 'error' ? 'error' : ''}` }, translate(msg));
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3200);
  }

  // ================================================================== API
  async function api(method, url, body) {
    const res = await fetch(`/api${url}`, {
      method,
      credentials: 'same-origin',
      headers: { 'x-pitchtribe': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.startsWith('/auth')) {
      boot();
      throw new Error(translate('Please sign in again'));
    }
    if (!res.ok) throw new Error(translate(data.error) || localize`Request failed (${res.status})`);
    return data;
  }

  async function refresh() {
    state = await api('GET', '/state');
    return state;
  }

  /** Sends a backup file (.tar.gz) as the request body. */
  async function uploadBackup(url, file) {
    const res = await fetch(`/api${url}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-pitchtribe': '1', 'Content-Type': 'application/gzip' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(translate(data.error) || localize`Restore failed (${res.status})`);
    return data;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtWhen = (iso) => new Date(iso).toLocaleString(document.documentElement.lang, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  /** Waits for the backup helper to finish a request; returns its result. */
  async function waitForBackup(requestId, getStatus) {
    for (let i = 0; i < 1800; i++) {
      await sleep(i < 10 ? 1000 : 2000);
      let s = null;
      try { s = await getStatus(); } catch { continue; } // the server restarts during a restore
      if (s && s.lastRequestId === requestId && !s.running) return s.last || { ok: true };
      if (s && s.done) return { ok: true };
    }
    return { ok: false, message: 'This is taking a long time. Check the stick, then reload this page.' };
  }

  function guessMime(file) {
    if (file.type) return file.type;
    const ext = file.name.split('.').pop().toLowerCase();
    return (
      { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }[ext] ||
      'application/octet-stream'
    );
  }

  function uploadFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/assets/upload');
      xhr.setRequestHeader('x-pitchtribe', '1');
      xhr.setRequestHeader('Content-Type', guessMime(file));
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(translate(data.error) || (xhr.status === 413 ? translate('File is too large') : localize`Upload failed (${xhr.status})`)));
      };
      xhr.onerror = () => reject(new Error(translate('Network error during upload')));
      xhr.send(file);
    });
  }

  function imageDimensions(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
      img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
      img.src = url;
    });
  }

  // ================================================================ modal
  function modal({ title, body, footer, wide = false, onClose }) {
    const dlg = h('dialog', { class: wide ? 'wide' : '' });
    const close = () => dlg.close();
    const foot = h('div', { class: 'modal-foot' });
    dlg.append(
      h('div', { class: 'modal' },
        h('div', { class: 'modal-head' }, h('h2', {}, translate(title)), h('button', { class: 'btn ghost icon', type: 'button', 'aria-label': translate('Close'), onclick: close }, icon('x'))),
        h('div', { class: 'modal-body' }, body),
        foot)
    );
    append(foot, typeof footer === 'function' ? footer(close) : footer || []);
    dlg.addEventListener('close', () => {
      dlg.remove();
      if (onClose) onClose();
    });
    document.body.append(dlg);
    dlg.showModal();
    return { dlg, close };
  }

  function confirmDialog(title, message, { confirmLabel = 'Delete', danger = true } = {}) {
    return new Promise((resolve) => {
      let result = false;
      modal({
        title,
        body: h('p', { class: 'muted' }, translate(message)),
        footer: (close) => [
          h('button', { class: 'btn', type: 'button', onclick: close }, translate('Cancel')),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => { result = true; close(); } }, translate(confirmLabel)),
        ],
        onClose: () => resolve(result),
      });
    });
  }

  function promptDialog(title, label, value = '') {
    return new Promise((resolve) => {
      let result = null;
      const input = h('input', { type: 'text', value, maxlength: 80, required: true });
      const form = h('form', { class: 'form-grid', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) { result = input.value.trim(); m.close(); } } },
        h('label', { class: 'field' }, translate(label), input));
      const m = modal({
        title,
        body: form,
        footer: (close) => [
          h('button', { class: 'btn', type: 'button', onclick: close }, translate('Cancel')),
          h('button', { class: 'btn primary', type: 'button', onclick: () => form.requestSubmit() }, translate('Continue')),
        ],
        onClose: () => resolve(result),
      });
      setTimeout(() => input.focus(), 30);
    });
  }

  // =============================================================== thumbs
  function thumb(asset, { tag = true } = {}) {
    if (!asset) return h('div', { class: 'thumb' }, icon('content'));
    const t = h('div', { class: 'thumb' });
    if (asset.type === 'image') {
      t.append(h('img', { src: asset.src, alt: '', loading: 'lazy' }));
    } else if (asset.type === 'video') {
      t.append(h('video', { src: `${asset.src}#t=0.5`, preload: 'metadata', muted: true, playsinline: true }));
    } else if (asset.type === 'notice') {
      t.classList.add('text', `style-${asset.content?.style || 'default'}`);
      t.append(h('strong', {}, asset.content?.title || asset.name), h('span', {}, asset.content?.body || ''));
    } else {
      t.append(icon(asset.type === 'widget' ? WIDGETS[asset.content?.kind]?.icon || 'widget' : asset.type));
    }
    if (tag && asset.type !== 'notice') t.append(h('span', { class: 'badge type-tag' }, typeLabel(asset)));
    return t;
  }

  // ================================================================= shell
  const NAV = [
    ['content', 'Content', 'content'],
    ['playlists', 'Playlists', 'playlist'],
    ['screens', 'Screens', 'screen'],
    ['wifi', 'Wi-Fi', 'wifi'],
    ['people', 'People', 'people'],
    ['settings', 'Settings', 'settings'],
  ];

  function shell(active, ...content) {
    return [
      h('header', { class: 'topbar' },
        h('a', { class: 'brand', href: '#/content' }, logo(), h('span', {}, translate('PITCHTRIBE'), h('small', {}, state.settings.clubName))),
        h('nav', { class: 'nav', 'aria-label': translate('Main') },
          NAV.map(([key, label, ic]) => h('a', { href: `#/${key}`, 'aria-current': active === key ? 'page' : null }, icon(ic), translate(label)))),
        languagePicker(),
        h('button', { class: 'btn ghost icon', type: 'button', title: translate('Sign out'), 'aria-label': translate('Sign out'), onclick: logout }, icon('logout'))),
      h('main', { class: 'page' }, content),
    ];
  }

  async function logout() {
    if (dirty && !confirm(translate('Discard unsaved playlist changes?'))) return;
    dirty = false;
    await api('POST', '/auth/logout', {}).catch(() => {});
    boot();
  }

  // ================================================================ auth
  function renderAuth(status) {
    const setup = status.setupRequired;
    const err = h('p', { class: 'error-text', role: 'alert' });
    const club = h('input', { type: 'text', name: 'club', autocomplete: 'organization', maxlength: 80, required: true, placeholder: translate('e.g. Riverside FC') });
    const pw = h('input', { type: 'password', name: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true, minlength: setup ? 8 : null });
    const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, setup ? translate('Create dashboard') : translate('Sign in'));
    const form = h('form', { class: 'form-grid', onsubmit: submit },
      setup && h('label', { class: 'field' }, translate('Club name'), club),
      h('label', { class: 'field' }, setup ? translate('Choose an admin password') : translate('Password'), pw, setup && h('span', { class: 'hint' }, translate('At least 8 characters. Share it with the volunteers who manage the screens.'))),
      setup && h('label', { class: 'field' }, translate('Confirm password'), pw2),
      err,
      btn);

    async function submit(e) {
      e.preventDefault();
      err.textContent = '';
      if (setup && pw.value !== pw2.value) {
        err.textContent = translate('The passwords don’t match');
        return;
      }
      btn.disabled = true;
      try {
        if (setup) await api('POST', '/auth/setup', { clubName: club.value, password: pw.value });
        else await api('POST', '/auth/login', { password: pw.value });
        boot();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    }

    appEl.replaceChildren(
      h('div', { class: 'auth' },
        h('div', { class: 'card' },
          h('div', { class: 'logo' }, logo()),
          h('div', {},
            h('h1', {}, setup ? translate('Set up PitchTribe') : status.clubName ? localize`Sign in to ${status.clubName}` : translate('Sign in')),
            h('p', { class: 'muted', style: 'margin-top:6px' }, setup ? translate('Create the dashboard for your club’s screens.') : translate('Manage what’s on your club’s screens.'))),
          languagePicker(), form,
          setup ? restoreOnSetup(status) : null)));
  }

  /** First-run screen: bring a club back from a USB stick or a backup file instead of starting again. */
  function restoreOnSetup(status) {
    const box = h('div', { class: 'stack', style: 'gap:12px;border-top:1px solid var(--line);padding-top:18px' });
    const msg = h('p', { class: 'small', role: 'status' });
    let busy = false;
    let poll = null;
    // Kept across redraws: the list is redrawn when a stick is plugged in, and
    // when the chosen backup changes the recovery-code box appears or goes.
    let chosen = 0;
    let typed = '';

    const finish = async (text) => {
      clearInterval(poll);
      msg.textContent = translate(text);
      await sleep(1500);
      boot(); // the club's own sign-in screen, with its old password
    };

    function draw(info) {
      const options = [];
      for (const stick of info.usb || []) {
        for (const b of stick.backups) {
          for (const snap of b.snapshots) options.push({ stick, host: b.host, locked: b.locked, snap });
        }
      }
      options.sort((x, y) => (x.snap.at < y.snap.at ? 1 : -1));
      if (chosen >= options.length) chosen = 0;
      const pick = h('select', { onchange: () => { chosen = Number(pick.value); draw(info); } }, options.map((o, i) => h('option', { value: String(i), selected: i === chosen },
        `${o.snap.club || o.host} — ${fmtWhen(o.snap.at)}${o.snap.encrypted ? ' 🔒' : ''}${(info.usb || []).length > 1 ? ` (${o.stick.label || 'USB stick'})` : ''}`)));
      // This card has no backup key of its own, so the only way into an
      // encrypted stick is the code the club printed. See lib/backup-crypto.js.
      const picked = options[chosen] || null;
      const needsCode = Boolean(picked && picked.snap.encrypted && picked.locked);
      const codeInput = h('input', {
        type: 'text',
        value: typed,
        placeholder: translate('XXXX-XXXX-XXXX-XXXX-XXXX-XXXX'),
        autocomplete: 'off',
        autocapitalize: 'characters',
        spellcheck: 'false',
        maxlength: '40',
        oninput: () => { typed = codeInput.value; },
      });
      const usbBtn = h('button', { class: 'btn', type: 'button', disabled: busy, onclick: async () => {
        const o = options[chosen];
        if (needsCode && !codeInput.value.trim()) { msg.textContent = translate('Type the recovery code from the printed card first.'); return; }
        busy = true;
        draw(info);
        msg.textContent = translate('Restoring from the USB stick… The screen goes blank for a moment. Big video collections take a few minutes.');
        try {
          const r = await api('POST', '/setup/restore-usb', { uuid: o.stick.uuid, host: o.host, snapshot: o.snap.id, ...(needsCode ? { recoveryCode: typed } : {}) });
          const result = await waitForBackup(r.requestId, async () => {
            const st = await fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' }).then((x) => x.json());
            return st.setupRequired ? { ...st.restore } : { done: true };
          });
          if (result.ok) return finish('Restored. Sign in with the club’s usual password.');
          throw new Error(result.message);
        } catch (err) {
          busy = false;
          draw(info);
          msg.textContent = err.message;
        }
      } }, icon('upload'), translate('Restore from USB stick'));

      const fileInput = h('input', { type: 'file', accept: '.gz,.tgz,application/gzip', hidden: true, onchange: async () => {
        const f = fileInput.files[0];
        if (!f) return;
        busy = true;
        draw(info);
        msg.textContent = localize`Restoring from ${f.name}…`;
        try {
          await uploadBackup('/setup/restore-file', f);
          return finish('Restored. Sign in with the club’s usual password.');
        } catch (err) {
          busy = false;
          draw(info);
          msg.textContent = err.message;
        }
      } });

      box.replaceChildren(
        h('h2', { style: 'font-size:1.05rem' }, translate('Restoring after a new memory card?')),
        h('p', { class: 'small muted' }, translate('If this Pi had PitchTribe before, bring back your content, screens, settings and password instead of starting again.')),
        options.length
          ? h('div', { class: 'stack', style: 'gap:8px' },
            h('label', { class: 'field' }, translate('Backup on the USB stick'), pick),
            needsCode ? h('label', { class: 'field' }, translate('Recovery code'), codeInput) : null,
            needsCode ? h('p', { class: 'small muted' }, translate('These backups are encrypted and this is a new memory card, so the code printed when backups were switched on is what opens them. Dashes, spaces and lower case are all fine.')) : null,
            h('div', {}, usbBtn))
          : h('p', { class: 'small muted' }, translate('Plug in the USB stick with your backups — it appears here within a few seconds.')),
        h('div', {}, h('button', { class: 'btn ghost sm', type: 'button', disabled: busy, onclick: () => fileInput.click() }, translate('Restore from a backup file…')), fileInput),
        msg);
    }

    draw(status.restore || {});
    // Notice a stick being plugged in while this screen is open.
    poll = setInterval(async () => {
      if (busy || !document.body.contains(box)) { if (!document.body.contains(box)) clearInterval(poll); return; }
      try {
        const st = await fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' }).then((x) => x.json());
        if (!st.setupRequired) return finish('This dashboard has been set up.');
        const before = JSON.stringify(status.restore?.usb || []);
        if (JSON.stringify(st.restore?.usb || []) !== before) { status.restore = st.restore; draw(st.restore); }
      } catch { /* try again */ }
    }, 5000);
    return box;
    (setup ? club : pw).focus();
  }

  // ============================================================== content
  let contentFilter = 'all';
  let contentSearch = '';
  const uploads = []; // { name, progress, error }

  function viewContent() {
    const fileInput = h('input', { type: 'file', multiple: true, accept: 'image/*,video/mp4,video/webm,video/quicktime', hidden: true, onchange: () => { startUploads([...fileInput.files]); fileInput.value = ''; } });

    const filters = [['all', 'All'], ['image', 'Images'], ['video', 'Videos'], ['notice', 'Notices'], ['menu', 'Menus'], ['sponsor', 'Sponsors'], ['fixtures', 'Fixtures'], ['scores', 'Scores'], ['league', 'League tables'], ['widget', 'Widgets'], ['url', 'Web pages']];
    const list = state.assets
      .filter((a) => contentFilter === 'all' || a.type === contentFilter)
      .filter((a) => !contentSearch || a.name.toLowerCase().includes(contentSearch.toLowerCase()))
      .slice()
      .reverse();

    const grid = list.length
      ? h('div', { class: 'grid' }, list.map((a) => {
          const n = usage(a.id);
          return h('button', { class: 'card asset', type: 'button', onclick: () => editAsset(a) },
            thumb(a),
            h('div', { class: 'asset-body' },
              h('strong', {}, a.name),
              h('span', {}, `${typeLabel(a)} · ${fmtDuration(a.duration)}${n ? ` · in ${n} playlist${n > 1 ? 's' : ''}` : ' · not in a playlist'}`)));
        }))
      : h('div', { class: 'card empty' },
          h('h2', {}, state.assets.length ? translate('Nothing matches') : translate('No content yet')),
          h('p', {}, state.assets.length ? translate('Try another filter.') : translate('Upload photos and videos, or create a notice, menu or fixture list.')));

    return shell('content',
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, translate('Content')), h('p', {}, translate('Everything that can appear on your screens.'))),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => fileInput.click() }, icon('upload'), translate('Upload')),
          h('button', { class: 'btn', type: 'button', onclick: () => editAsset({ type: 'notice' }) }, icon('notice'), translate('Notice')),
          h('button', { class: 'btn', type: 'button', onclick: () => editAsset({ type: 'menu' }) }, icon('menu'), translate('Menu')),
          h('button', { class: 'btn', type: 'button', onclick: () => editAsset({ type: 'menu', content: { mode: 'bar' } }) }, icon('menu'), translate('Bar menu')),
          h('button', { class: 'btn', type: 'button', onclick: () => editAsset({ type: 'sponsor' }) }, icon('sponsor'), translate('Sponsors')),
          h('button', { class: 'btn', type: 'button', onclick: () => editAsset({ type: 'fixtures' }) }, icon('fixtures'), translate('Fixtures')),
          h('button', { class: 'btn', type: 'button', onclick: pickWidget }, icon('widget'), translate('Widgets')),
          h('button', { class: 'btn', type: 'button', onclick: () => editAsset({ type: 'scores' }) }, icon('scores'), translate('Live scores')),
          h('button', { class: 'btn', type: 'button', onclick: () => editAsset({ type: 'league' }) }, icon('league'), translate('League table')),
          h('button', { class: 'btn', type: 'button', onclick: () => editAsset({ type: 'url' }) }, icon('url'), translate('Web page')),
          fileInput)),
      h('div', { class: 'dropzone' }, translate('Drop photos or videos here to upload'), h('br'), h('span', { class: 'small' }, localize`JPG, PNG, GIF, WebP, SVG, MP4, WebM · up to ${state.maxUploadMb} MB each`)),
      uploads.length ? h('div', { class: 'uploads' }, uploads.map((u) =>
        h('div', { class: `card upload ${u.error ? 'error' : ''}` },
          h('strong', {}, u.name),
          h('span', { class: u.error ? '' : 'muted' }, u.error || (u.progress >= 1 ? translate('Processing…') : `${Math.round(u.progress * 100)}%`)),
          !u.error && h('progress', { max: 1, value: u.progress })))) : null,
      h('div', { class: 'toolbar' },
        h('div', { class: 'chips', role: 'group', 'aria-label': translate('Filter by type') },
          filters.map(([key, label]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(contentFilter === key), onclick: () => { contentFilter = key; render(); } }, translate(label)))),
        h('input', { type: 'search', placeholder: translate('Search content'), value: contentSearch, 'aria-label': translate('Search content'), oninput: (e) => { contentSearch = e.target.value; rerenderKeepingFocus(e.target); } })),
      grid);
  }

  function rerenderKeepingFocus(input) {
    const pos = input.selectionStart;
    render();
    const again = appEl.querySelector(`input[aria-label="${input.getAttribute('aria-label')}"]`);
    if (again) { again.focus(); again.setSelectionRange(pos, pos); }
  }

  async function startUploads(files) {
    if (!files.length) return;
    const jobs = files.map((f) => ({ file: f, name: f.name, progress: 0, error: '' }));
    uploads.push(...jobs);
    render();
    let ok = 0;
    for (const job of jobs) {
      try {
        let last = 0;
        const uploaded = await uploadFile(job.file, (p) => {
          job.progress = p;
          if (p - last > 0.05 || p === 1) { last = p; if (currentView === 'content') render(); }
        });
        if (uploaded.type === 'image') {
          const dimensions = await imageDimensions(job.file);
          if (dimensions && dimensions.height > dimensions.width) {
            try {
              await api('PATCH', `/assets/${uploaded.id}`, { fit: 'blur' });
            } catch (err) {
              toast(localize`Uploaded ${job.name}, but automatic framing failed: ${err.message}`, 'error');
            }
          }
        }
        ok += 1;
        uploads.splice(uploads.indexOf(job), 1);
      } catch (err) {
        job.error = err.message;
        setTimeout(() => { const i = uploads.indexOf(job); if (i >= 0) uploads.splice(i, 1); render(); }, 8000);
      }
    }
    await refresh();
    render();
    if (ok) toast(localize`Uploaded ${ok} file${ok > 1 ? 's' : ''} — add ${ok > 1 ? 'them' : 'it'} to a playlist to show on screen`);
  }

  // Drag & drop anywhere while on the content page.
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (currentView !== 'content' || !e.dataTransfer?.types.includes('Files')) return;
    dragDepth++;
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
  });
  document.addEventListener('dragover', (e) => {
    if (currentView === 'content' && e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    dragDepth = 0;
    document.body.classList.remove('dragging');
    if (currentView !== 'content' || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    startUploads([...e.dataTransfer.files]);
  });

  // ---------------------------------------------------------- asset editor
  function editAsset(asset) {
    const isNew = !asset.id;
    const type = asset.type;
    const c = asset.content || {};
    const defaults = { url: 30, notice: 12, menu: 20, sponsor: 20, fixtures: 15, scores: 15, league: 25, widget: { clock: 15, worldclock: 15, weather: 15, joke: 14, phrase: 10, trivia: 12, quiz: 20, history: 18, emoji: 16, geoquiz: 16, country: 14, spotball: 20, transport: 20, bankholiday: 12, floods: 12, carbon: 14, quakes: 14, currency: 12, potd: 15, births: 15, sky: 12, headlines: 18, events: 18 }[c.kind] };
    const f = {}; // field elements
    const body = h('form', { class: 'form-grid', onsubmit: (e) => { e.preventDefault(); save(); } });

    if (type === 'image') {
      const preview = h('div', { class: 'image-frame-preview' });
      const previewBackground = h('img', { class: 'image-frame-background', src: asset.src, alt: '', 'aria-hidden': 'true' });
      const previewImage = h('img', { class: 'image-frame-foreground', src: asset.src, alt: translate('Image framing preview') });
      preview.append(previewBackground, previewImage);
      body.append(preview);
      f.preview = preview;
    }
    if (type === 'video') body.append(h('video', { class: 'preview-media', src: asset.src, controls: true, muted: true, preload: 'metadata' }));

    f.name = h('input', { type: 'text', value: asset.name || (type === 'widget' ? WIDGETS[c.kind]?.name : '') || '', maxlength: 120, required: true, placeholder: translate({ notice: 'e.g. AGM notice', menu: 'e.g. Bar menu', sponsor: 'e.g. Main sponsors', fixtures: 'e.g. First team fixtures', scores: 'e.g. Premier League scores', league: 'e.g. County League', url: 'e.g. League table' }[type]) });
    f.duration = h('input', { type: 'number', min: type === 'video' ? 0 : 1, max: 86400, value: asset.duration ?? defaults[type] ?? 10, required: true });
    body.append(h('div', { class: 'row-2' },
      h('label', { class: 'field' }, translate('Name'), f.name),
      h('label', { class: 'field' }, translate('Show for (seconds)'), f.duration, type === 'video' && h('span', { class: 'hint' }, translate('0 = play the whole video')))));

    if (type === 'image' || type === 'video') {
      const fits = type === 'image'
        ? [['blur', 'Fit with blurred photo background'], ['color', 'Fit with coloured border'], ['cover', 'Fill screen (may crop edges)'], ['contain', 'Fit with black bars']]
        : [['contain', 'Fit whole video (may show bars)'], ['cover', 'Fill screen (may crop edges)']];
      f.fit = h('select', {}, fits.map(([value, label]) => h('option', { value, selected: (asset.fit || 'contain') === value }, translate(label))));
      body.append(h('label', { class: 'field' }, translate('Sizing'), f.fit));
      if (type === 'image') {
        f.backgroundColor = h('input', { type: 'color', value: asset.backgroundColor || '#162943' });
        const colorField = h('label', { class: 'field' }, translate('Border colour'), f.backgroundColor);
        body.append(colorField);
        const updatePreview = () => {
          f.preview.dataset.fit = f.fit.value;
          f.preview.style.backgroundColor = f.backgroundColor.value;
          colorField.hidden = f.fit.value !== 'color';
        };
        f.fit.addEventListener('change', updatePreview);
        f.backgroundColor.addEventListener('input', updatePreview);
        updatePreview();
      }
    }
    if (type === 'video') {
      f.muted = h('input', { type: 'checkbox', checked: asset.muted !== false });
      body.append(h('label', { class: 'switch' }, f.muted, translate('Mute sound')));
    }
    if (type === 'image' || type === 'video') {
      body.append(h('p', { class: 'small muted' }, `${asset.file.originalName} · ${fmtBytes(asset.file.size)}`));
    }
    if (type === 'url') {
      f.url = h('input', { type: 'url', value: asset.url || '', required: true, placeholder: translate('https://') });
      body.append(h('label', { class: 'field' }, translate('Web address'), f.url,
        h('span', { class: 'hint' }, translate('Live pages such as league tables, weather or social walls. Some sites block being shown inside other pages — preview the playlist to check.'))));
    }
    if (type === 'notice') {
      f.title = h('input', { type: 'text', value: c.title || '', maxlength: 200, placeholder: translate('AGM — Friday 7th November, 7pm') });
      f.body = h('textarea', { maxlength: 3000, placeholder: translate('All members welcome. Bar opens 6:30pm.') }, c.body || '');
      let style = c.style || 'default';
      const picker = h('div', { class: 'style-picker', role: 'group', 'aria-label': translate('Colour') });
      const drawPicker = () => picker.replaceChildren(...NOTICE_STYLES.map(([key, label, color]) =>
        h('button', { type: 'button', title: translate(label), 'aria-label': translate(label), 'aria-pressed': String(style === key), style: `background:${color}`, onclick: () => { style = key; drawPicker(); } })));
      drawPicker();
      f.style = { get value() { return style; } };
      body.append(h('label', { class: 'field' }, translate('Headline'), f.title), h('label', { class: 'field' }, translate('Message'), f.body, h('span', { class: 'hint' }, translate('New lines start new paragraphs. Long text shrinks to fit the screen.'))), h('div', { class: 'field' }, translate('Colour'), picker));
    }
    if (type === 'menu' && c.mode === 'bar') {
      f.title = h('input', { type: 'text', value: c.title || '', maxlength: 200, placeholder: translate('Draught Beer & Cider') });
      body.append(h('label', { class: 'field' }, translate('Heading on screen'), f.title));
      const drinks = Array.isArray(c.drinks) ? c.drinks.map((d) => ({ ...d })) : [];
      const drinksContainer = h('div', { class: 'bar-drinks-editor' });
      function renderDrinks() {
        drinksContainer.replaceChildren(
          ...drinks.map((d, i) => {
            const colorIn = h('input', { type: 'color', value: d.color || '#888888', title: translate('Brand colour (used when no logo image is set)'), class: 'bar-color-pick' });
            colorIn.addEventListener('input', (e) => { d.color = e.target.value; });
            const nameIn = h('input', { type: 'text', value: d.name || '', maxlength: 100, placeholder: translate('e.g. Guinness'), 'aria-label': translate('Brand name') });
            nameIn.addEventListener('input', (e) => { d.name = e.target.value; });

            const fileIn = h('input', { type: 'file', accept: 'image/*', style: 'display:none', 'aria-label': translate('Upload logo image') });
            const existingAsset = d.logoAssetId ? assetById(d.logoAssetId) : null;
            const initSrc = (existingAsset && existingAsset.src) || d.logoUrl || '';
            const logoPreview = h('img', { class: 'bar-logo-preview', style: initSrc ? '' : 'display:none', alt: translate('logo'), src: initSrc });
            const uploadStatus = h('span', { class: 'bar-logo-status' });
            const uploadBtn = h('button', { type: 'button', class: 'btn sm', title: translate('Upload logo image') }, icon('upload'), translate('Upload'));
            const clearBtn = h('button', { type: 'button', class: 'btn-icon sm', title: translate('Remove logo'), style: d.logoAssetId || d.logoUrl ? '' : 'display:none' }, icon('trash'));

            uploadBtn.addEventListener('click', () => fileIn.click());
            fileIn.addEventListener('change', async () => {
              const file = fileIn.files[0];
              if (!file) return;
              uploadStatus.textContent = translate('Uploading…');
              uploadBtn.disabled = true;
              try {
                const result = await uploadFile(file, () => {});
                d.logoAssetId = result.id;
                d.logoUrl = '';
                logoPreview.src = result.src || '';
                logoPreview.style.display = '';
                clearBtn.style.display = '';
                uploadStatus.textContent = '';
              } catch (err) {
                uploadStatus.textContent = err.message || translate('Upload failed');
              } finally {
                uploadBtn.disabled = false;
              }
            });
            clearBtn.addEventListener('click', () => {
              d.logoAssetId = '';
              d.logoUrl = '';
              logoPreview.src = '';
              logoPreview.style.display = 'none';
              clearBtn.style.display = 'none';
            });

            const logoCell = h('div', { class: 'bar-logo-cell' }, logoPreview, fileIn, uploadBtn, clearBtn, uploadStatus);

            const priceIn = h('input', { type: 'text', value: d.price || '', maxlength: 20, placeholder: '£4.00', 'aria-label': translate('Price') });
            priceIn.addEventListener('input', (e) => { d.price = e.target.value; });
            const mpIn = h('input', { type: 'text', value: d.memberPrice || '', maxlength: 20, placeholder: '£3.60', 'aria-label': translate('Member price') });
            mpIn.addEventListener('input', (e) => { d.memberPrice = e.target.value; });
            const removeBtn = h('button', { type: 'button', class: 'btn-icon danger', title: translate('Remove drink'), onclick: () => { drinks.splice(i, 1); renderDrinks(); } }, icon('trash'));
            return h('div', { class: 'bar-drink-row' }, colorIn, nameIn, logoCell, priceIn, mpIn, removeBtn);
          }),
          h('button', { type: 'button', class: 'btn', onclick: () => { drinks.push({ name: '', color: '#888888', logoAssetId: '', logoUrl: '', price: '', memberPrice: '' }); renderDrinks(); setTimeout(() => drinksContainer.querySelectorAll('.bar-drink-row input[aria-label="Brand name"]')[drinks.length - 1]?.focus(), 30); } }, translate('+ Add drink'))
        );
      }
      renderDrinks();
      body.append(
        h('div', { class: 'field' },
          h('div', { class: 'bar-drink-header' },
            h('span', {}, translate('Colour')), h('span', {}, translate('Brand')), h('span', {}, translate('Logo')), h('span', {}, translate('Price')), h('span', {}, translate('Members'))),
          drinksContainer,
          h('span', { class: 'hint' }, translate('Upload a brand logo image to show it on screen. Leave blank to use a colour badge instead.')))
      );
      f.drinks = { get value() { return drinks; } };
    }
    if (type === 'sponsor') {
      f.title = h('input', { type: 'text', value: c.title || '', maxlength: 200, placeholder: translate('Thank you to our sponsors') });
      body.append(h('label', { class: 'field' }, translate('Heading on screen'), f.title));
      f.layout = h('select', {},
        h('option', { value: 'grid', selected: (c.layout || 'grid') === 'grid' }, translate('Grid (logos in columns)')),
        h('option', { value: 'row', selected: c.layout === 'row' }, translate('Row (logos in a strip)')));
      body.append(h('label', { class: 'field' }, translate('Layout'), f.layout));
      const sponsors = Array.isArray(c.sponsors) ? c.sponsors.map((s) => ({ ...s })) : [];
      const sponsorsContainer = h('div', { class: 'sponsor-editor' });
      const TIERS = [['', 'No tier'], ['gold', 'Gold'], ['silver', 'Silver'], ['bronze', 'Bronze'], ['partner', 'Partner']];
      function renderSponsors() {
        sponsorsContainer.replaceChildren(
          ...sponsors.map((s, i) => {
            const nameIn = h('input', { type: 'text', value: s.name || '', maxlength: 100, placeholder: translate('e.g. Acme Corp'), 'aria-label': translate('Sponsor name') });
            nameIn.addEventListener('input', (e) => { s.name = e.target.value; });
            const taglineIn = h('input', { type: 'text', value: s.tagline || '', maxlength: 200, placeholder: translate('Official Kit Sponsor'), 'aria-label': translate('Tagline') });
            taglineIn.addEventListener('input', (e) => { s.tagline = e.target.value; });
            const tierSel = h('select', { 'aria-label': translate('Tier') }, ...TIERS.map(([v, l]) => h('option', { value: v, selected: (s.tier || '') === v }, translate(l))));
            tierSel.addEventListener('change', (e) => { s.tier = e.target.value; });

            const fileIn = h('input', { type: 'file', accept: 'image/*', style: 'display:none', 'aria-label': translate('Upload logo') });
            const existingAsset = s.logoAssetId ? assetById(s.logoAssetId) : null;
            const initSrc = (existingAsset && existingAsset.src) || s.logoUrl || '';
            const logoPreview = h('img', { class: 'bar-logo-preview', style: initSrc ? '' : 'display:none', alt: translate('logo'), src: initSrc });
            const uploadStatus = h('span', { class: 'bar-logo-status' });
            const uploadBtn = h('button', { type: 'button', class: 'btn sm', title: translate('Upload logo') }, icon('upload'), translate('Upload'));
            const clearBtn = h('button', { type: 'button', class: 'btn-icon sm', title: translate('Remove logo'), style: s.logoAssetId || s.logoUrl ? '' : 'display:none' }, icon('trash'));
            uploadBtn.addEventListener('click', () => fileIn.click());
            fileIn.addEventListener('change', async () => {
              const file = fileIn.files[0];
              if (!file) return;
              uploadStatus.textContent = translate('Uploading…');
              uploadBtn.disabled = true;
              try {
                const result = await uploadFile(file, () => {});
                s.logoAssetId = result.id;
                s.logoUrl = '';
                logoPreview.src = result.src || '';
                logoPreview.style.display = '';
                clearBtn.style.display = '';
                uploadStatus.textContent = '';
              } catch (err) {
                uploadStatus.textContent = err.message || translate('Upload failed');
              } finally {
                uploadBtn.disabled = false;
              }
            });
            clearBtn.addEventListener('click', () => {
              s.logoAssetId = '';
              s.logoUrl = '';
              logoPreview.src = '';
              logoPreview.style.display = 'none';
              clearBtn.style.display = 'none';
            });
            const logoCell = h('div', { class: 'bar-logo-cell' }, logoPreview, fileIn, uploadBtn, clearBtn, uploadStatus);
            const removeBtn = h('button', { type: 'button', class: 'btn-icon danger', title: translate('Remove sponsor'), onclick: () => { sponsors.splice(i, 1); renderSponsors(); } }, icon('trash'));
            return h('div', { class: 'sponsor-row' }, nameIn, taglineIn, tierSel, logoCell, removeBtn);
          }),
          h('button', { type: 'button', class: 'btn', onclick: () => { sponsors.push({ name: '', tagline: '', tier: '', logoAssetId: '', logoUrl: '' }); renderSponsors(); setTimeout(() => sponsorsContainer.querySelectorAll('.sponsor-row input[aria-label="Sponsor name"]')[sponsors.length - 1]?.focus(), 30); } }, translate('+ Add sponsor'))
        );
      }
      renderSponsors();
      body.append(
        h('div', { class: 'field' },
          h('div', { class: 'sponsor-row-header' }, h('span', {}, translate('Name')), h('span', {}, translate('Tagline')), h('span', {}, translate('Tier')), h('span', {}, translate('Logo'))),
          sponsorsContainer,
          h('span', { class: 'hint' }, translate('Upload a logo to show it on screen. Leave blank to use an initial badge.')))
      );
      f.sponsors = { get value() { return sponsors; } };
    }
    if ((type === 'menu' && c.mode !== 'bar') || type === 'fixtures') {
      f.title = h('input', { type: 'text', value: c.title || '', maxlength: 200, placeholder: type === 'menu' ? translate('Bar & Kitchen — Today’s Menu') : translate('Upcoming Fixtures') });
      f.text = h('textarea', { class: 'code', spellcheck: false, maxlength: type === 'menu' ? 20000 : 50000 }, c.text || (isNew ? (type === 'menu' ? MENU_EXAMPLE : fixturesExample()) : ''));
      const summary = h('p', { class: 'parse-summary' });
      const update = () => { summary.textContent = type === 'menu' ? menuSummary(f.text.value) : fixturesSummary(f.text.value); };
      f.text.addEventListener('input', update);
      update();
      body.append(h('label', { class: 'field' }, translate('Heading on screen'), f.title));
      body.append(h('label', { class: 'field' }, type === 'menu' ? translate('Menu') : translate('Fixtures'), f.text, summary));
      body.append(type === 'menu'
        ? h('details', { class: 'help' }, h('summary', {}, translate('How to write a menu')),
            h('p', { style: 'margin-top:8px' }, translate('Start a section with #. One item per line: name | price | notes. Add “| sold out” to mark an item sold out. You can paste straight from a spreadsheet.')),
            h('pre', {}, MENU_EXAMPLE))
        : h('details', { class: 'help' }, h('summary', {}, translate('How to write fixtures')),
            h('p', { style: 'margin-top:8px' }, translate('One per line: date & time | match | competition | venue. Dates can be 2026-11-09 14:00 or 09/11/2026 14:00. Past fixtures hide themselves 3 hours after kick-off, and the next one gets a countdown. You can paste from a spreadsheet.')),
            h('pre', {}, fixturesExample())));
      if (type === 'fixtures') {
        f.limit = h('input', { type: 'number', min: 1, max: 20, value: c.limit || 8 });
        body.append(h('label', { class: 'field' }, translate('Show at most'), f.limit));
      }
    }
    if (type === 'scores') {
      const sp = state.sports;
      f.title = h('input', { type: 'text', value: c.title || '', maxlength: 200, placeholder: translate('Latest scores') });
      const chosen = new Set(c.leagues || []);
      const available = sp.catalog.filter((l) => sp.enabled && sp.leagues.includes(l.key));
      f.leagues = { get value() { return [...chosen]; } };
      f.show = h('select', {}, [['all', 'Live, results and fixtures'], ['live', 'Live matches only'], ['results', 'Latest results'], ['fixtures', 'Upcoming fixtures']]
        .map(([v, l]) => h('option', { value: v, selected: (c.show || 'all') === v }, translate(l))));
      f.limit = h('input', { type: 'number', min: 1, max: 100, value: c.limit || 10 });
      body.append(h('label', { class: 'field' }, translate('Heading on screen'), f.title));
      body.append(available.length
        ? h('div', { class: 'field' }, translate('Competitions'),
            h('div', { class: 'chips' }, available.map((l) => {
              const chip = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(chosen.has(l.key)),
                onclick: () => { chosen.has(l.key) ? chosen.delete(l.key) : chosen.add(l.key); chip.setAttribute('aria-pressed', String(chosen.has(l.key))); } }, l.name);
              return chip;
            })),
            h('span', { class: 'hint' }, translate('None selected = all the leagues switched on in Settings.')))
        : h('p', { class: 'help' }, translate('Sports feeds are switched off. '), h('a', { href: '#/settings', onclick: () => m.close() }, translate('Choose leagues in Settings')), translate(' — this slide fills in once they are on.')));
      body.append(h('div', { class: 'row-2' }, h('label', { class: 'field' }, translate('Show'), f.show), h('label', { class: 'field' }, translate('At most (matches)'), f.limit)));
      body.append(h('p', { class: 'small muted' }, translate('More matches than fit on screen scroll past by themselves, and the slide stays up long enough to show them all. Scores update on screen by themselves too: every minute during live matches, every 10 minutes otherwise.')));
    }
    if (type === 'league') {
      // Full-Time has no public feed, so the club brings its own code snippets
      // from Full-Time → Media → Code Snippets. Three panels is what fits a TV
      // across: table, recent results, next fixtures.
      const PANELS = [['Table', 'Table'], ['Results', 'Recent Results'], ['Fixtures', 'Upcoming Fixtures']];
      const saved = c.panels || [];
      f.title = h('input', { type: 'text', value: c.title || '', maxlength: 200, placeholder: translate('Bedfordshire County League') });
      body.append(h('label', { class: 'field' }, translate('Heading on screen'), f.title));
      body.append(h('details', { class: 'help', open: isNew }, h('summary', {}, translate('Where do I get these?')),
        h('p', { style: 'margin-top:8px' }, translate('The FA does not publish Full-Time as a feed, so this slide shows the official embed code your league gives you. Sign in at '),
          h('a', { href: 'https://fulltime.thefa.com/', target: '_blank', rel: 'noreferrer' }, translate('fulltime.thefa.com')),
          translate(' as a team or league admin, go to Media → Code Snippets, pick your division and season, create the snippet and paste it below. One snippet per panel.')),
        h('p', {}, translate('Leave a panel empty to drop it. Full-Time deletes a snippet that has gone unused for 30 days, so create them, paste them here, and check the slide in Preview.')),
        h('p', {}, translate('Screens need internet for this slide: the table is drawn by Full-Time, not stored on the Pi.'))));
      f.panels = PANELS.map(([label, placeholder], i) => {
        const labelInput = h('input', { type: 'text', value: saved[i]?.label ?? (isNew ? label : ''), maxlength: 60, placeholder: translate(label) });
        const snippet = h('textarea', { class: 'code', spellcheck: false, rows: 4, maxlength: 4000, placeholder: localize`Full-Time “${placeholder}” embed code` }, saved[i]?.snippet || '');
        body.append(h('div', { class: 'row-2' },
          h('label', { class: 'field' }, localize`Panel ${i + 1} heading`, labelInput),
          h('label', { class: 'field' }, translate('Code snippet'), snippet)));
        return { labelInput, snippet };
      });
      f.zoom = h('select', {}, [['0', 'Fit the panel (recommended)'], ['1', 'No zoom (350px as Full-Time sends it)'], ['1.5', '1.5×'], ['2', '2×'], ['3', '3×']]
        .map(([v, l]) => h('option', { value: v, selected: String(c.zoom ?? 0) === v }, translate(l))));
      f.credit = h('input', { type: 'text', value: c.credit ?? 'Data from The FA Full-Time', maxlength: 200 });
      body.append(h('div', { class: 'row-2' },
        h('label', { class: 'field' }, translate('Size on screen'), f.zoom, h('span', { class: 'hint' }, translate('Full-Time sends a fixed 350px-wide table; “fit” scales it up to fill the panel.'))),
        h('label', { class: 'field' }, translate('Credit line'), f.credit)));
    }
    if (type === 'widget') widgetFields(c, body, f, () => m);
    if (isNew && state.playlists.length) {
      f.addTo = h('select', {}, h('option', { value: '' }, translate('Don’t add yet')),
        state.playlists.map((p, i) => h('option', { value: p.id, selected: i === 0 }, p.name)));
      body.append(h('label', { class: 'field' }, translate('Add to playlist'), f.addTo));
    }
    if (!isNew) {
      const n = usage(asset.id);
      body.append(h('p', { class: 'small muted' }, n ? localize`Used in ${n} playlist${n > 1 ? 's' : ''}. Changes show on screens straight away.` : translate('Not in any playlist yet — add it from a playlist to show it on screen.')));
    }

    const saveBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => save() }, isNew ? translate('Create') : translate('Save'));
    const modalLabel = (type === 'menu' && c.mode === 'bar') ? translate('Bar menu') : (type === 'widget' ? typeLabel(asset) : translate(TYPE_LABEL[type] || type));
    const m = modal({
      title: isNew ? localize`New ${modalLabel}` : localize`Edit ${modalLabel}`,
      body,
      wide: type === 'menu' || type === 'fixtures' || type === 'league' || type === 'sponsor',
      footer: (close) => [
        !isNew && h('button', { class: 'btn danger', type: 'button', onclick: remove }, icon('trash'), translate('Delete')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', onclick: close }, translate('Cancel')),
        saveBtn,
      ],
    });
    setTimeout(() => (type === 'notice' && isNew ? f.title : f.name).focus(), 30);

    async function save() {
      if (!body.reportValidity()) return;
      const payload = { name: f.name.value, duration: Number(f.duration.value) };
      if (f.fit) payload.fit = f.fit.value;
      if (f.backgroundColor) payload.backgroundColor = f.backgroundColor.value;
      if (f.muted) payload.muted = f.muted.checked;
      if (f.url) payload.url = f.url.value;
      if (type === 'notice') payload.content = { title: f.title.value, body: f.body.value, style: f.style.value };
      if (type === 'menu' && c.mode !== 'bar') payload.content = { title: f.title.value, text: f.text.value };
      if (type === 'menu' && c.mode === 'bar') payload.content = { mode: 'bar', title: f.title.value, drinks: f.drinks.value };
      if (type === 'sponsor') payload.content = { title: f.title.value, layout: f.layout.value, sponsors: f.sponsors.value };
      if (type === 'fixtures') payload.content = { title: f.title.value, text: f.text.value, limit: Number(f.limit.value) };
      if (type === 'scores') payload.content = { title: f.title.value, leagues: f.leagues.value, show: f.show.value, limit: Number(f.limit.value) };
      if (type === 'league') {
        payload.content = {
          title: f.title.value,
          zoom: Number(f.zoom.value),
          credit: f.credit.value,
          panels: f.panels
            .map((p) => ({ label: p.labelInput.value, snippet: p.snippet.value.trim() }))
            .filter((p) => p.snippet),
        };
        if (!payload.content.panels.length) return toast('Paste at least one Full-Time code snippet', 'error');
      }
      if (type === 'widget') payload.content = f.widget();
      saveBtn.disabled = true;
      try {
        if (isNew) await api('POST', '/assets', { type, ...payload, addToPlaylist: f.addTo?.value || undefined });
        else await api('PATCH', `/assets/${asset.id}`, payload);
        await refresh();
        m.close();
        render();
        toast(isNew ? (f.addTo?.value ? 'Created and added to the playlist' : 'Created') : 'Saved — screens update in a few seconds');
      } catch (err) {
        toast(err.message, 'error');
        saveBtn.disabled = false;
      }
    }

    async function remove() {
      const n = usage(asset.id);
      const ok = await confirmDialog(localize`Delete “${asset.name}”?`, n ? localize`It will also be removed from ${n} playlists. This can’t be undone.` : 'This can’t be undone.');
      if (!ok) return;
      try {
        await api('DELETE', `/assets/${asset.id}`);
        await refresh();
        m.close();
        render();
        toast('Deleted');
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  }

  const MENU_EXAMPLE = `# Draught
Lager (pint) | £4.50
Real ale (pint) | £4.80 | Ask for today’s guest ale
Stout (pint) | £4.70

# Food
Beef burger & chips | £8.50 | Contains gluten
Chicken & mushroom pie | £7.00 | | sold out
Chips | £3.00 | V, VG`;

  function fixturesExample() {
    const d = (offset, time) => {
      const x = new Date();
      x.setDate(x.getDate() + offset);
      return `${PTSchedule.dateKey(x)} ${time}`;
    };
    return `${d(4, '14:00')} | Riverside FC v Rovers United | League | Home
${d(7, '19:30')} | Training · Astroturf Pitch A
${d(11, '15:00')} | City Athletic v Riverside FC | League | Away
${d(18, '14:00')} | Riverside FC v Northdale Athletic | County Cup | Home`;
  }

  function menuSummary(text) {
    const secs = PTFormats.parseMenu(text);
    const items = secs.reduce((n, s) => n + s.items.length, 0);
    const sold = secs.reduce((n, s) => n + s.items.filter((i) => i.soldOut).length, 0);
    const summary = localize`${secs.length} sections, ${items} items`;
    return sold ? localize`${summary} (${sold} sold out)` : summary;
  }
  function fixtureWhen(f) {
    if (!f.date) return f.whenText;
    const dayStart = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const diff = Math.round((dayStart(f.date) - dayStart(new Date())) / 86400000);
    const day = diff === 0 ? translate('Today') : diff === 1 ? translate('Tomorrow')
      : f.date.toLocaleDateString(document.documentElement.lang, { weekday: 'short', day: 'numeric', month: 'short' });
    return f.hasTime ? `${day} · ${f.date.toLocaleTimeString(document.documentElement.lang, { hour: '2-digit', minute: '2-digit' })}` : day;
  }
  function fixturesSummary(text) {
    const all = PTFormats.parseFixtures(text, { includePast: true });
    const upcoming = PTFormats.parseFixtures(text);
    const next = upcoming.find((f) => f.date);
    const past = all.length - upcoming.length;
    let summary = localize`${upcoming.length} upcoming`;
    if (past) summary = localize`${summary}, ${past} past (hidden)`;
    if (next) summary = localize`${summary} · next: ${next.title} — ${fixtureWhen(next)}`;
    return summary;
  }


  // --------------------------------------------------------------- widgets
  const WORLD_CITIES = [
    ['London', 'Europe/London'], ['Dublin', 'Europe/Dublin'], ['Paris', 'Europe/Paris'], ['Madrid', 'Europe/Madrid'],
    ['Berlin', 'Europe/Berlin'], ['Athens', 'Europe/Athens'], ['Moscow', 'Europe/Moscow'], ['Dubai', 'Asia/Dubai'],
    ['Delhi', 'Asia/Kolkata'], ['Singapore', 'Asia/Singapore'], ['Hong Kong', 'Asia/Hong_Kong'], ['Beijing', 'Asia/Shanghai'],
    ['Tokyo', 'Asia/Tokyo'], ['Sydney', 'Australia/Sydney'], ['Auckland', 'Pacific/Auckland'], ['Cairo', 'Africa/Cairo'],
    ['Lagos', 'Africa/Lagos'], ['Nairobi', 'Africa/Nairobi'], ['Johannesburg', 'Africa/Johannesburg'], ['Rio de Janeiro', 'America/Sao_Paulo'],
    ['Buenos Aires', 'America/Argentina/Buenos_Aires'], ['Mexico City', 'America/Mexico_City'], ['New York', 'America/New_York'],
    ['Toronto', 'America/Toronto'], ['Chicago', 'America/Chicago'], ['Denver', 'America/Denver'], ['Los Angeles', 'America/Los_Angeles'], ['Honolulu', 'Pacific/Honolulu'],
  ];

  function pickWidget() {
    const m = modal({
      title: 'Add a widget',
      wide: true,
      body: h('div', { class: 'stack' }, WIDGET_GROUPS.map(([group, kinds]) => h('section', {},
        h('h3', { class: 'widget-group' }, translate(group)),
        h('div', { class: 'widget-grid' }, kinds.map((kind) => {
          const w = WIDGETS[kind];
          return h('button', { class: 'card widget-card', type: 'button', onclick: () => { m.close(); editAsset({ type: 'widget', content: { kind } }); } },
            icon(w.icon), h('strong', {}, translate(w.name)), h('span', {}, translate(w.blurb)));
        }))))),
      footer: (close) => [h('button', { class: 'btn', type: 'button', onclick: close }, translate('Cancel'))],
    });
  }

  /** Kind-specific fields for the widget editor. Sets f.widget() to collect the content. */
  function widgetFields(c, body, f, getModal) {
    const kind = c.kind;
    const title = h('input', { type: 'text', value: c.title || '', maxlength: 200, placeholder: translate({ clock: 'Optional heading', worldclock: 'World clocks', weather: 'Weather at the ground', joke: 'Joke time', phrase: 'Optional heading', trivia: 'Automatic (e.g. “Music: did you know?”)', quiz: 'Automatic (e.g. “Music quiz”)', emoji: 'Emoji quiz', geoquiz: 'Flags & capitals', country: 'Country of the day', history: 'Automatic (e.g. “On this day — 3 November”)', spotball: 'Spot the ball', transport: 'Getting here', sky: 'Automatic', floods: 'Flood warnings', bankholiday: 'Automatic', carbon: 'Automatic', currency: 'Automatic', quakes: 'Recent earthquakes', potd: 'Picture of the day', births: 'Automatic', headlines: 'Latest news', events: 'Coming up' }[kind]) });
    body.append(h('p', { class: 'small muted' }, translate(WIDGETS[kind].blurb)));
    body.append(h('label', { class: 'field' }, translate('Heading on screen'), title));
    const collect = { kind, title: () => title.value };

    if (kind === 'clock') {
      const mode = h('select', {}, [['digital', 'Digital'], ['analog', 'Analogue'], ['countdown', 'Countdown']].map(([v, l]) => h('option', { value: v, selected: (c.mode || 'digital') === v }, translate(l))));
      const showDate = h('input', { type: 'checkbox', checked: c.showDate !== false });
      const target = h('input', { type: 'datetime-local', value: c.target || '' });
      const label = h('input', { type: 'text', value: c.label || '', maxlength: 120, placeholder: translate('Kick-off: Riverside FC v Rovers United') });
      const cd = h('div', { class: 'form-grid' }, h('div', { class: 'row-2' }, h('label', { class: 'field' }, translate('Count down to'), target), h('label', { class: 'field' }, translate('Label'), label)));
      const sync = () => { cd.hidden = mode.value !== 'countdown'; };
      mode.addEventListener('change', sync);
      sync();
      body.append(h('label', { class: 'field' }, translate('Style'), mode), cd, h('label', { class: 'switch' }, showDate, translate('Show the date')));
      Object.assign(collect, { mode: () => mode.value, showDate: () => showDate.checked, target: () => target.value, label: () => label.value });
    }
    if (kind === 'weather') {
      const days = h('select', {}, [0, 1, 2, 3, 4, 5, 6].map((n) => h('option', { value: n, selected: (c.days ?? 3) === n }, n === 0 ? translate('Today only') : localize`Today + ${n} day${n > 1 ? 's' : ''}`)));
      body.append(h('label', { class: 'field' }, translate('Forecast'), days));
      const w = state.widgets.weather;
      body.append(w
        ? h('p', { class: 'small muted' }, localize`Location: ${w.place || `${w.latitude}, ${w.longitude}`}. `, h('a', { href: '#/settings', onclick: () => getModal().close() }, translate('Change in Settings')))
        : h('p', { class: 'help' }, translate('No location set yet. '), h('a', { href: '#/settings', onclick: () => getModal().close() }, translate('Choose your ground in Settings')), translate(' — needs an internet connection.')));
      collect.days = () => Number(days.value);
    }
    if (kind === 'quiz' || kind === 'trivia') {
      const topic = h('select', {}, [['sport', 'Sport'], ['film-tv', 'Film & TV'], ['music', 'Music'], ['geography', 'Geography'], ['culture', 'Culture (art, books, food, traditions)'], ['mixed', 'A mix of everything']]
        .map(([v, l]) => h('option', { value: v, selected: (c.topic || 'sport') === v }, translate(l))));
      body.append(h('label', { class: 'field' }, translate('Topic'), topic));
      collect.topic = () => topic.value;
      if (kind === 'quiz') {
        const source = h('select', {}, [['bundled', 'Built-in questions (works offline)'], ['opentdb', 'Online question bank — Open Trivia DB (thousands of questions)']]
          .map(([v, l]) => h('option', { value: v, selected: (c.source || 'bundled') === v }, translate(l))));
        body.append(h('label', { class: 'field' }, translate('Questions from'), source, h('span', { class: 'hint' }, translate('Online questions are community-written (CC BY-SA) and mostly English. If the internet is down the built-in questions are used.'))));
        collect.source = () => source.value;
      }
    }
    if (kind === 'emoji') {
      const category = h('select', {}, [['all', 'Films, TV shows and songs'], ['Film', 'Films only'], ['TV', 'TV shows only'], ['Song', 'Songs only']]
        .map(([v, l]) => h('option', { value: v, selected: (c.category || 'all') === v }, translate(l))));
      body.append(h('label', { class: 'field' }, translate('Include'), category));
      collect.category = () => category.value;
    }
    if (kind === 'geoquiz') {
      const mode = h('select', {}, [['mixed', 'Flags and capitals'], ['flags', 'Flags only'], ['capitals', 'Capital cities only']]
        .map(([v, l]) => h('option', { value: v, selected: (c.mode || 'mixed') === v }, translate(l))));
      body.append(h('label', { class: 'field' }, translate('Questions'), mode), h('p', { class: 'small muted' }, translate('Generated from 59 countries; a fresh set every day. The answer is revealed partway through the slide.')));
      collect.mode = () => mode.value;
    }
    if (kind === 'country') {
      body.append(h('p', { class: 'small muted' }, translate('Shows a different country each time it comes round, with its flag, capital, continent and currency.')));
    }
    if (kind === 'worldclock') {
      const chosen = new Map((c.zones || [{ label: 'London', tz: 'Europe/London' }, { label: 'New York', tz: 'America/New_York' }, { label: 'Tokyo', tz: 'Asia/Tokyo' }, { label: 'Sydney', tz: 'Australia/Sydney' }]).map((z) => [z.tz, z.label]));
      const chips = h('div', { class: 'chips' });
      const note = h('span', { class: 'hint' });
      const draw = () => {
        chips.replaceChildren(...WORLD_CITIES.map(([label, tz]) => h('button', {
          class: 'chip', type: 'button', 'aria-pressed': String(chosen.has(tz)),
          onclick: () => {
            if (chosen.has(tz)) chosen.delete(tz);
            else if (chosen.size < 8) chosen.set(tz, label);
            else toast('Up to eight cities', 'error');
            draw();
          },
        }, translate(label))));
        note.textContent = localize`${chosen.size} of 8 chosen. Shown in the order picked.`;
      };
      draw();
      body.append(h('div', { class: 'field' }, translate('Cities'), chips, note));
      collect.zones = () => [...chosen].map(([tz, label]) => ({ tz, label }));
    }
    if (['joke', 'phrase', 'trivia', 'quiz', 'emoji'].includes(kind)) {
      const hint = {
        joke: 'One per line: Question | Punchline',
        phrase: 'One phrase per line',
        trivia: 'One fact per line',
        quiz: 'One per line: Question | right answer | wrong | wrong | wrong (answers are shuffled)',
        emoji: 'One per line: emojis | answer | Film, TV or Song',
      }[kind];
      const extra = h('textarea', { class: 'code', spellcheck: kind !== 'quiz', maxlength: 20000, placeholder: translate({ joke: 'Why did the treasurer smile? | Subs are in!', phrase: 'Up the Riversiders!', trivia: 'Riverside FC was founded in 1889.', quiz: 'When was the club founded? | 1889 | 1901 | 1923 | 1950', emoji: '🏉🏆 | Rugby World Cup | Sport' }[kind]) }, c.extra || '');
      extra.style.minHeight = '120px';
      const only = h('input', { type: 'checkbox', checked: Boolean(c.only) });
      body.append(h('label', { class: 'field' }, translate('Add your own (optional)'), extra, h('span', { class: 'hint' }, localize`${translate(hint)}. Mixed in with ${translate({ joke: '30 jokes', phrase: '25 phrases', trivia: 'the built-in facts', quiz: 'the built-in questions', emoji: '32 puzzles' }[kind])} that come built in — a new selection every day.`)));
      body.append(h('label', { class: 'switch' }, only, translate('Only show mine')));
      Object.assign(collect, { extra: () => extra.value, only: () => only.checked });
    }
    if (kind === 'history') {
      const scope = h('select', {}, [['day', 'This day'], ['week', 'This week'], ['month', 'This month']].map(([v, l]) => h('option', { value: v, selected: (c.scope || 'day') === v }, translate(l))));
      const htopic = h('select', {}, [['sport', 'Sport'], ['entertainment', 'TV, film & music'], ['all', 'Both']].map(([v, l]) => h('option', { value: v, selected: (c.topic || 'sport') === v }, translate(l))));
      body.append(h('label', { class: 'field' }, translate('Topic'), htopic));
      collect.topic = () => htopic.value;
      const limit = h('input', { type: 'number', min: 1, max: 12, value: c.limit || 5 });
      const general = h('input', { type: 'checkbox', checked: Boolean(c.general) });
      body.append(h('div', { class: 'row-2' }, h('label', { class: 'field' }, translate('Show'), scope), h('label', { class: 'field' }, translate('At most (events)'), limit)));
      body.append(h('label', { class: 'switch' }, general, translate('Also include general history from Wikipedia')));
      body.append(h('p', { class: 'small muted' }, translate('Sporting and TV, film & music moments are built in. If nothing happened on the day, the slide shows the week or month instead. Wikipedia needs an internet connection.')));
      Object.assign(collect, { scope: () => scope.value, limit: () => Number(limit.value), general: () => general.checked });
    }
    const needsPlace = ['sky', 'floods'].includes(kind) || (kind === 'transport');
    if (needsPlace && !state.widgets.weather) {
      body.append(h('p', { class: 'help' }, translate('This uses your ground’s location. '), h('a', { href: '#/settings', onclick: () => getModal().close() }, translate('Set it in Settings → Widgets')), '.'));
    }
    const num = (value, min, max) => h('input', { type: 'number', min, max, value });
    const pick = (value, options) => h('select', {}, options.map(([v, l]) => h('option', { value: v, selected: String(value) === String(v) }, translate(l))));
    if (kind === 'transport') {
      const sec = new Set(c.sections || ['tracker']);
      const SECTIONS = [['tracker', '🚌 Live bus tracker (anywhere in England)'], ['trains', '🚆 Train departures (National Rail)'], ['buses', '🚌 Bus arrivals at a London stop'], ['lines', '🚇 Tube & London rail status'], ['roads', '🚗 London main roads'], ['planes', '✈️ Planes overhead']];
      const boxes = SECTIONS.map(([k, l]) => {
        const cb = h('input', { type: 'checkbox', checked: sec.has(k), onchange: () => { cb.checked ? sec.add(k) : sec.delete(k); sync(); } });
        return h('label', { class: 'switch' }, cb, l);
      });
      const trackLines = h('input', { type: 'text', value: (c.trackLines || []).join(', '), placeholder: '73, 74' });
      const trackTitle = h('input', { type: 'text', value: c.trackTitle || '', maxlength: 80, placeholder: translate('e.g. Buses to Bedford') });
      const trackOperator = h('input', { type: 'text', value: c.trackOperator || '', maxlength: 8, placeholder: translate('Optional, e.g. SCEM') });
      const trackRadius = num(c.trackRadius || 20, 2, 60);
      const station = h('input', { type: 'text', value: c.station || '', maxlength: 3, placeholder: translate('BIW'), style: 'text-transform:uppercase' });
      const busStop = h('input', { type: 'text', value: c.busStop || '', maxlength: 20, placeholder: translate('490008660N') });
      const busStopName = h('input', { type: 'text', value: c.busStopName || '', maxlength: 60, placeholder: translate('Stop name (optional)') });
      const planesRadius = num(c.planesRadius || 15, 2, 100);
      const groups = {
        tracker: h('div', { class: 'form-grid sub' },
          h('div', { class: 'row-2' }, h('label', { class: 'field' }, translate('Bus routes to track'), trackLines, h('span', { class: 'hint' }, translate('Route numbers, comma-separated (up to 6).'))), h('label', { class: 'field' }, translate('Heading'), trackTitle)),
          h('div', { class: 'row-2' }, h('label', { class: 'field' }, translate('Within (km of the ground)'), trackRadius), h('label', { class: 'field' }, translate('Operator code'), trackOperator, h('span', { class: 'hint' }, translate('Only if another company runs the same route numbers nearby.')))),
          !state.widgets.bods?.apiKey && h('p', { class: 'help' }, translate('Needs a free Bus Open Data Service API key — '), h('a', { href: '#/settings', onclick: () => getModal().close() }, translate('add it in Settings → Widgets')), '.')),
        trains: h('label', { class: 'field sub' }, translate('Station code'), station, h('span', { class: 'hint' }, translate('The 3-letter National Rail code, e.g. BIW Biggleswade, BDM Bedford, KGX King’s Cross.'))),
        buses: h('div', { class: 'row-2 sub' }, h('label', { class: 'field' }, translate('TfL stop ID'), busStop, h('span', { class: 'hint' }, translate('From the stop’s page on tfl.gov.uk.'))), h('label', { class: 'field' }, translate('Stop name'), busStopName)),
        planes: h('label', { class: 'field sub' }, translate('Within (km of the ground)'), planesRadius),
      };
      const sync = () => { for (const [k, el] of Object.entries(groups)) el.hidden = !sec.has(k); };
      body.append(h('div', { class: 'field' }, translate('Show'), ...boxes), ...Object.values(groups));
      sync();
      Object.assign(collect, {
        sections: () => SECTIONS.map(([k]) => k).filter((k) => sec.has(k)),
        trackLines: () => trackLines.value, trackTitle: () => trackTitle.value, trackOperator: () => trackOperator.value, trackRadius: () => Number(trackRadius.value),
        station: () => station.value.trim(), busStop: () => busStop.value.trim(), busStopName: () => busStopName.value, planesRadius: () => Number(planesRadius.value),
      });
    }
    if (kind === 'bankholiday') {
      const division = pick(c.division || 'england-and-wales', [['england-and-wales', 'England and Wales'], ['scotland', 'Scotland'], ['northern-ireland', 'Northern Ireland']]);
      const limit = num(c.limit || 4, 1, 8);
      body.append(h('div', { class: 'row-2' }, h('label', { class: 'field' }, translate('Nation'), division), h('label', { class: 'field' }, translate('How many'), limit)));
      Object.assign(collect, { division: () => division.value, limit: () => Number(limit.value) });
    }
    if (kind === 'floods') {
      const radius = num(c.radius || 15, 1, 100);
      body.append(h('label', { class: 'field' }, translate('Within (km of the ground)'), radius, h('span', { class: 'hint' }, translate('England only. Shows a reassuring “no warnings” slide when all is clear.'))));
      collect.radius = () => Number(radius.value);
    }
    if (kind === 'carbon') {
      const postcode = h('input', { type: 'text', value: c.postcode || '', maxlength: 4, placeholder: translate('e.g. SG18 (optional)') });
      body.append(h('label', { class: 'field' }, translate('Postcode area'), postcode, h('span', { class: 'hint' }, translate('First half of your postcode for your region; leave empty for all of Great Britain.'))));
      collect.postcode = () => postcode.value.trim();
    }
    if (kind === 'quakes') {
      const feed = pick(c.feed || '4.5_week', [['significant_week', 'Significant — past week'], ['4.5_week', 'Magnitude 4.5+ — past week'], ['4.5_day', 'Magnitude 4.5+ — past day'], ['2.5_day', 'Magnitude 2.5+ — past day']]);
      const limit = num(c.limit || 6, 1, 10);
      body.append(h('div', { class: 'row-2' }, h('label', { class: 'field' }, translate('Feed'), feed), h('label', { class: 'field' }, translate('How many'), limit)));
      Object.assign(collect, { feed: () => feed.value, limit: () => Number(limit.value) });
    }
    if (kind === 'currency') {
      const CODES = ['GBP', 'EUR', 'USD', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'INR', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'ZAR', 'HKD', 'SGD', 'MXN', 'BRL', 'ISK', 'KRW', 'THB'];
      const base = pick(c.base || 'GBP', CODES.map((x) => [x, x]));
      const chosen = new Set(c.symbols || ['EUR', 'USD']);
      const chips = h('div', { class: 'chips' });
      const draw = () => chips.replaceChildren(...CODES.filter((x) => x !== base.value).map((x) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(chosen.has(x)), onclick: () => { chosen.has(x) ? chosen.delete(x) : chosen.size < 8 && chosen.add(x); draw(); } }, x)));
      base.addEventListener('change', () => { chosen.delete(base.value); draw(); });
      draw();
      body.append(h('label', { class: 'field' }, translate('One unit of'), base), h('div', { class: 'field' }, translate('Show (up to 8)'), chips));
      Object.assign(collect, { base: () => base.value, symbols: () => [...chosen].filter((x) => x !== base.value) });
    }
    if (kind === 'births') {
      const limit = num(c.limit || 5, 1, 10);
      body.append(h('label', { class: 'field' }, translate('How many people'), limit, h('span', { class: 'hint' }, translate('A different selection each day. Needs an internet connection.'))));
      collect.limit = () => Number(limit.value);
    }
    if (kind === 'headlines' || kind === 'events') {
      const url = h('input', { type: 'url', value: c.url || '', required: true, placeholder: kind === 'headlines' ? translate('https://yourclub.example/news/feed') : translate('https://calendar.google.com/calendar/ical/…/basic.ics') });
      const limit = num(c.limit || 6, 1, 10);
      body.append(h('label', { class: 'field' }, kind === 'headlines' ? translate('Feed address (RSS or Atom)') : translate('Calendar address (iCal / .ics)'), url,
        h('span', { class: 'hint' }, kind === 'headlines'
          ? translate('Only use feeds you’re allowed to show publicly — your own club’s, your league’s, or ones whose terms allow it.')
          : translate('In Google Calendar: Settings → your calendar → “Public address in iCal format”. Repeating events show their first date only.'))));
      if (kind === 'events') {
        const days = num(c.days || 60, 1, 365);
        body.append(h('div', { class: 'row-2' }, h('label', { class: 'field' }, translate('How many'), limit), h('label', { class: 'field' }, translate('Look ahead (days)'), days)));
        collect.days = () => Number(days.value);
      } else {
        body.append(h('label', { class: 'field' }, translate('How many headlines'), limit));
      }
      Object.assign(collect, { url: () => url.value.trim(), limit: () => Number(limit.value) });
    }
    if (kind === 'spotball') {
      const images = state.assets.filter((a) => a.type === 'image');
      let pos = c.x != null ? { x: c.x, y: c.y } : null;
      const photo = h('select', {}, h('option', { value: '' }, images.length ? translate('— Choose a photo —') : translate('Upload a photo first')),
        images.slice().reverse().map((a) => h('option', { value: a.id, selected: a.id === c.imageId }, a.name)));
      const radius = h('input', { type: 'range', min: 2, max: 20, step: 0.5, value: c.radius || 6 });
      const cover = h('input', { type: 'checkbox', checked: c.cover !== false });
      const grid = h('input', { type: 'checkbox', checked: c.grid !== false });
      const revealAt = h('input', { type: 'datetime-local', value: c.revealAt || '' });
      const prize = h('input', { type: 'text', value: c.prize || '', maxlength: 200, placeholder: translate('£20 bar tab — entries at the bar') });
      const stageBox = h('div', { class: 'sb-editor' });
      const marker = h('div', { class: 'sb-marker' });
      const img = h('img', { alt: '' });
      const status = h('p', { class: 'small muted' });
      const draw = () => {
        const a = images.find((x) => x.id === photo.value);
        stageBox.hidden = !a;
        if (a && img.getAttribute('src') !== a.src) img.src = a.src;
        marker.hidden = !pos;
        if (pos) {
          marker.style.left = `${pos.x}%`;
          marker.style.top = `${pos.y}%`;
          marker.style.width = `${Number(radius.value) * 2}%`;
          const cell = `${'ABCDEFGHIJ'[Math.min(9, Math.floor(pos.x / 10))]}${Math.min(7, Math.floor(pos.y / 12.5)) + 1}`;
          status.textContent = localize`Ball marked at ${cell} — tap the photo again to move it.`;
        } else {
          status.textContent = a ? translate('Tap the photo where the ball is.') : '';
        }
      };
      stageBox.append(img, marker);
      stageBox.addEventListener('click', (e) => {
        const r = img.getBoundingClientRect();
        pos = { x: Math.round(((e.clientX - r.left) / r.width) * 10000) / 100, y: Math.round(((e.clientY - r.top) / r.height) * 10000) / 100 };
        draw();
      });
      photo.addEventListener('change', () => { pos = null; draw(); });
      radius.addEventListener('input', draw);
      body.append(
        h('label', { class: 'field' }, translate('Photo'), photo, h('span', { class: 'hint' }, translate('Best with a match photo where the ball has already been edited out. Otherwise the screen blurs a patch around it.'))),
        stageBox, status,
        h('label', { class: 'field' }, translate('Ball size'), radius),
        h('div', { class: 'row-2' }, h('label', { class: 'switch' }, cover, translate('Blur the area around the ball')), h('label', { class: 'switch' }, grid, translate('Show a lettered grid'))),
        h('div', { class: 'row-2' }, h('label', { class: 'field' }, translate('Reveal the answer at'), revealAt, h('span', { class: 'hint' }, translate('Leave empty to keep it hidden.'))), h('label', { class: 'field' }, translate('Prize / how to enter'), prize)));
      draw();
      Object.assign(collect, {
        imageId: () => photo.value, x: () => pos?.x, y: () => pos?.y, radius: () => Number(radius.value),
        cover: () => cover.checked, grid: () => grid.checked, revealAt: () => revealAt.value, prize: () => prize.value,
      });
    }
    f.title = title;
    f.widget = () => Object.fromEntries(Object.entries(collect).map(([k, v]) => [k, typeof v === 'function' ? v() : v]));
  }

  function widgetsCard() {
    const w = state.widgets;
    let place = w.weather;
    const q = h('input', { type: 'search', placeholder: translate('Town or postcode area, e.g. Leeds'), value: '' });
    const results = h('div', { class: 'chips' });
    const chosen = h('p', { class: 'small' });
    const wind = h('select', {}, [['mph', 'mph'], ['kmh', 'km/h']].map(([v, l]) => h('option', { value: v, selected: (w.weather?.windUnit || 'mph') === v }, l)));
    const wiki = h('input', { type: 'checkbox', checked: w.wikipedia !== false });
    const provider = h('select', {}, [['metno', 'MET Norway (free, commercial use allowed)'], ['openmeteo', 'Open-Meteo (free for non-commercial use only)']]
      .map(([v, l]) => h('option', { value: v, selected: (w.weather?.provider || 'metno') === v }, translate(l))));
    const railUrl = h('input', { type: 'url', value: w.trains?.url || '', placeholder: translate('https://huxley2.azurewebsites.net (default)') });
    const railToken = h('input', { type: 'password', value: w.trains?.token || '', autocomplete: 'off', placeholder: translate('Only if your Huxley2 server needs one') });
    const bodsKey = h('input', { type: 'password', value: w.bods?.apiKey || '', autocomplete: 'off', placeholder: translate('Free key from data.bus-data.dft.gov.uk') });
    const showChosen = () => { chosen.textContent = place ? localize`Weather for: ${place.place || 'custom location'} (${place.latitude}, ${place.longitude})` : translate('No weather location set.'); };
    showChosen();
    const search = async () => {
      results.replaceChildren(h('span', { class: 'small muted' }, translate('Searching…')));
      try {
        const list = await api('GET', `/geocode?q=${encodeURIComponent(q.value)}`);
        results.replaceChildren(...(list.length ? list.map((r) => h('button', { class: 'chip', type: 'button', onclick: () => {
          place = { place: r.name, latitude: r.latitude, longitude: r.longitude };
          showChosen();
          results.replaceChildren();
        } }, `${r.name}${r.region ? `, ${r.region}` : ''}`)) : [h('span', { class: 'small muted' }, translate('No places found.'))]));
      } catch (err) {
        results.replaceChildren(h('span', { class: 'small error-text' }, err.message));
      }
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
    return h('form', {
      class: 'card panel-box form-grid',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          state.widgets = await api('PUT', '/settings/widgets', {
            weather: place ? { ...place, windUnit: wind.value, provider: provider.value } : null,
            wikipedia: wiki.checked,
            trains: { url: railUrl.value.trim(), token: railToken.value.trim() },
            bods: { apiKey: bodsKey.value.trim() },
          });
          render();
          toast('Widget settings saved');
        } catch (err) { toast(err.message, 'error'); }
      },
    },
      h('h2', {}, translate('Widgets')),
      h('p', { class: 'small muted' }, translate('Settings for the weather and history widgets. Jokes, phrases, trivia, quizzes and sporting history work without the internet.')),
      h('div', { class: 'field' }, translate('Weather location'),
        h('div', { class: 'copy-row' }, q, h('button', { class: 'btn', type: 'button', onclick: search }, translate('Find'))),
        results, chosen),
      h('div', { class: 'row-2' },
        h('label', { class: 'field' }, translate('Wind speed in'), wind),
        h('div', { class: 'field' }, ' ', place && h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { place = null; showChosen(); } }, translate('Clear location')))),
      h('p', { class: 'small muted' }, translate('Place search © OpenStreetMap contributors (ODbL).')),
      h('label', { class: 'field' }, translate('Weather data from'), provider),
      h('label', { class: 'switch' }, wiki, translate('Allow general history from Wikipedia')),
      h('h3', { class: 'widget-group' }, translate('Transport')),
      h('label', { class: 'field' }, translate('Bus Open Data Service API key'), bodsKey, h('span', { class: 'hint' }, translate('For the live bus tracker anywhere in England. Free: register at data.bus-data.dft.gov.uk. Kept on this server; never sent to screens.'))),
      h('div', { class: 'row-2' },
        h('label', { class: 'field' }, translate('Train departures server (Huxley2)'), railUrl, h('span', { class: 'hint' }, translate('A JSON proxy for National Rail’s Darwin feed. Run your own with a free Darwin token for reliability.'))),
        h('label', { class: 'field' }, translate('Darwin access token'), railToken)),
      h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, translate('Save'))));
  }

  // ============================================================ playlists
  function loopSeconds(p) {
    return p.items.filter((it) => it.enabled).reduce((n, it) => n + (it.duration ?? assetById(it.assetId)?.duration ?? 0), 0);
  }

  function viewPlaylists() {
    const cards = state.playlists.map((p) => {
      const now = new Date();
      const live = p.items.filter((it) => PTSchedule.isLive(it, now)).length;
      const screens = state.screens.filter((s) => s.playlistId === p.id).length;
      return h('a', { class: 'card pl-card', href: `#/playlists/${p.id}` },
        h('div', { style: 'display:flex;justify-content:space-between;gap:8px;align-items:center' },
          h('h2', {}, p.name),
          p.id === state.settings.defaultPlaylistId && h('span', { class: 'badge' }, translate('Default'))),
        h('div', { class: 'pl-thumbs' }, p.items.slice(0, 6).map((it) => {
          const a = assetById(it.assetId);
          return h('div', {}, a?.type === 'image' ? h('img', { src: a.src, alt: '', loading: 'lazy' }) : icon(a?.type || 'content'));
        })),
        h('div', { class: 'stats' },
          h('span', {}, localize`${p.items.length} item${p.items.length === 1 ? '' : 's'}`),
          h('span', {}, localize`${live} live now`),
          h('span', {}, localize`loop ≈ ${fmtLoop(loopSeconds(p))}`),
          h('span', {}, localize`${screens} screen${screens === 1 ? '' : 's'}`)));
    });
    return shell('playlists',
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, translate('Playlists')), h('p', {}, translate('The running order for each screen — with timings for when each item plays.'))),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: newPlaylist }, icon('plus'), translate('New playlist')))),
      cards.length ? h('div', { class: 'grid' }, cards) : h('div', { class: 'card empty' }, h('h2', {}, translate('No playlists yet')), h('p', {}, translate('Create one, then assign it to your screens.'))));
  }

  async function newPlaylist() {
    const name = await promptDialog('New playlist', 'Name', '');
    if (!name) return;
    try {
      const p = await api('POST', '/playlists', { name });
      await refresh();
      location.hash = `#/playlists/${p.id}`;
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ------------------------------------------------------- playlist editor
  let draft = null;
  let expanded = new Set();

  function viewPlaylist(id) {
    const saved = state.playlists.find((p) => p.id === id);
    if (!saved) return shell('playlists', h('div', { class: 'card empty' }, h('h2', {}, translate('Playlist not found')), h('a', { href: '#/playlists' }, translate('Back to playlists'))));
    if (!draft || draft.id !== id) {
      draft = structuredClone(saved);
      dirty = false;
      expanded = new Set();
    }
    const markDirty = () => {
      dirty = true;
      saveBtn.disabled = false;
      saveBtn.textContent = translate('Save changes');
    };

    const saveBtn = h('button', { class: 'btn primary', type: 'button', disabled: !dirty, onclick: save }, dirty ? translate('Save changes') : translate('Saved'));
    const nameInput = h('input', { class: 'title', type: 'text', value: draft.name, maxlength: 80, 'aria-label': translate('Playlist name'), oninput: (e) => { draft.name = e.target.value; markDirty(); } });

    async function save() {
      saveBtn.disabled = true;
      try {
        await api('PUT', `/playlists/${draft.id}`, draft);
        await refresh();
        draft = structuredClone(state.playlists.find((p) => p.id === id));
        dirty = false;
        render();
        toast('Saved — screens update in a few seconds');
      } catch (err) {
        saveBtn.disabled = false;
        toast(err.message, 'error');
      }
    }

    async function removePlaylist() {
      const screens = state.screens.filter((s) => s.playlistId === id).length;
      const ok = await confirmDialog(localize`Delete “${saved.name}”?`, screens ? localize`${screens} screens will switch to the default playlist. Your content stays in the library.` : 'Your content stays in the library.');
      if (!ok) return;
      try {
        await api('DELETE', `/playlists/${id}`);
        dirty = false;
        draft = null;
        await refresh();
        location.hash = '#/playlists';
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    // ---- items
    const list = h('div', { class: 'items' });
    const drawItems = () => {
      list.replaceChildren(...draft.items.map((it, i) => itemRow(it, i)));
      if (!draft.items.length) list.append(h('div', { class: 'card empty' }, h('h2', {}, translate('This playlist is empty')), h('p', {}, translate('Add notices, photos, videos, menus or fixtures from your library.'))));
      totals.textContent = localize`${draft.items.length} item${draft.items.length === 1 ? '' : 's'} · one loop takes about ${fmtLoop(loopSeconds(draft))} (videos set to “full length” not counted)`;
    };
    const totals = h('p', { class: 'small muted' });

    let dragFrom = null;
    function itemRow(it, i) {
      const a = assetById(it.assetId);
      const st = PTSchedule.status(it);
      const isOpen = expanded.has(it.id);
      const row = h('div', { class: `card item ${it.enabled ? '' : 'disabled'}` });
      const grip = h('span', { class: 'grip', title: translate('Drag to reorder'), 'aria-hidden': 'true' }, icon('grip'));
      grip.addEventListener('pointerdown', () => { row.draggable = true; });
      row.addEventListener('dragstart', (e) => { dragFrom = i; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
      row.addEventListener('dragend', () => { row.draggable = false; row.classList.remove('dragging'); dragFrom = null; list.querySelectorAll('.item').forEach((r) => r.classList.remove('drop-before', 'drop-after')); });
      row.addEventListener('dragover', (e) => {
        if (dragFrom === null) return;
        e.preventDefault();
        const after = e.offsetY > row.offsetHeight / 2;
        row.classList.toggle('drop-after', after);
        row.classList.toggle('drop-before', !after);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragFrom === null) return;
        let to = row.classList.contains('drop-after') ? i + 1 : i;
        const [moved] = draft.items.splice(dragFrom, 1);
        if (dragFrom < to) to -= 1;
        draft.items.splice(to, 0, moved);
        markDirty();
        drawItems();
      });

      const move = (delta) => {
        const j = i + delta;
        if (j < 0 || j >= draft.items.length) return;
        [draft.items[i], draft.items[j]] = [draft.items[j], draft.items[i]];
        markDirty();
        drawItems();
      };

      const dur = h('input', {
        type: 'number', min: 0, max: 86400, value: it.duration ?? '', placeholder: String(a?.duration ?? ''), 'aria-label': translate('Seconds on screen'),
        title: translate('Seconds on screen (blank = the content’s default)'),
        oninput: (e) => { it.duration = e.target.value === '' ? null : Number(e.target.value); markDirty(); },
      });
      const enabled = h('input', { type: 'checkbox', checked: it.enabled, 'aria-label': translate('Show this item'), onchange: (e) => { it.enabled = e.target.checked; markDirty(); drawItems(); } });

      append(row, [
        h('div', { class: 'item-main' },
          grip,
          thumb(a, { tag: false }),
          h('div', { class: 'item-info' },
            h('strong', {}, a?.name || translate('Missing content')),
            h('div', { class: 'meta' },
              h('span', { class: `badge ${st}` }, translate(STATUS_LABEL[st])),
              h('span', {}, typeLabel(a)),
              h('span', {}, '·'),
              h('span', {}, PTSchedule.describe(it.schedule)))),
          h('div', { class: 'item-controls' },
            h('label', { class: 'dur' }, dur, translate('s')),
            h('label', { class: 'switch', title: it.enabled ? translate('On') : translate('Off') }, enabled, h('span', { class: 'sr-only' }, translate('Enabled'))),
            h('button', { class: `btn sm ${isOpen ? 'primary' : ''}`, type: 'button', 'aria-expanded': String(isOpen), onclick: () => { isOpen ? expanded.delete(it.id) : expanded.add(it.id); drawItems(); } }, icon('clock'), translate('Timing')),
            h('button', { class: 'btn sm icon ghost', type: 'button', 'aria-label': translate('Move up'), disabled: i === 0, onclick: () => move(-1) }, icon('up')),
            h('button', { class: 'btn sm icon ghost', type: 'button', 'aria-label': translate('Move down'), disabled: i === draft.items.length - 1, onclick: () => move(1) }, icon('down')),
            h('button', { class: 'btn sm icon ghost danger', type: 'button', 'aria-label': translate('Remove from playlist'), onclick: () => { draft.items.splice(i, 1); markDirty(); drawItems(); } }, icon('x')))),
        isOpen && timingEditor(it, () => { markDirty(); drawItems(); })]);
      return row;
    }

    function timingEditor(it, changed) {
      const s = (it.schedule ||= { startDate: '', endDate: '', days: [], startTime: '', endTime: '' });
      const set = (k) => (e) => { s[k] = e.target.value; changed(); };
      const days = h('div', { class: 'chips', role: 'group', 'aria-label': translate('Days') },
        [1, 2, 3, 4, 5, 6, 0].map((d) => h('button', {
          class: 'chip', type: 'button', 'aria-pressed': String(s.days.includes(d)),
          onclick: () => { s.days = s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d].sort(); if (s.days.length === 7) s.days = []; changed(); },
        }, PTSchedule.DAY_NAMES[d])));
      const preset = (label, fn) => h('button', { class: 'chip', type: 'button', onclick: () => { fn(); changed(); } }, translate(label));
      const today = PTSchedule.dateKey(new Date());
      return h('div', { class: 'timing' },
        h('div', { class: 'presets' },
          preset('Always', () => Object.assign(s, { startDate: '', endDate: '', days: [], startTime: '', endTime: '' })),
          preset('Weekdays', () => { s.days = [1, 2, 3, 4, 5]; }),
          preset('Weekends', () => { s.days = [0, 6]; }),
          preset('Lunch 12–2', () => Object.assign(s, { startTime: '12:00', endTime: '14:00' })),
          preset('Evenings 5pm–close', () => Object.assign(s, { startTime: '17:00', endTime: '00:00' })),
          preset('Today only', () => Object.assign(s, { startDate: today, endDate: today }))),
        h('div', { class: 'row-2' },
          h('label', { class: 'field' }, translate('Start showing on'), h('input', { type: 'date', value: s.startDate, onchange: set('startDate') })),
          h('label', { class: 'field' }, translate('Stop after'), h('input', { type: 'date', value: s.endDate, onchange: set('endDate') }))),
        h('div', { class: 'field' }, translate('Days'), days, h('span', { class: 'hint' }, translate('None selected = every day'))),
        h('div', { class: 'row-2' },
          h('label', { class: 'field' }, translate('From'), h('input', { type: 'time', value: s.startTime, onchange: set('startTime') })),
          h('label', { class: 'field' }, translate('Until'), h('input', { type: 'time', value: s.endTime, onchange: set('endTime') }), h('span', { class: 'hint' }, translate('Can run past midnight, e.g. 18:00 → 01:00')))));
    }

    function addContent() {
      const chosen = new Set();
      let filter = '';
      const listEl = h('div', { class: 'picker-list' });
      const addBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, translate('Add'));
      const draw = () => {
        const assets = state.assets.slice().reverse().filter((a) => !filter || a.name.toLowerCase().includes(filter));
        listEl.replaceChildren(...(assets.length ? assets.map((a) => {
          const inPl = draft.items.some((it) => it.assetId === a.id);
          return h('label', { class: 'picker-row' },
            h('input', { type: 'checkbox', checked: chosen.has(a.id), onchange: (e) => { e.target.checked ? chosen.add(a.id) : chosen.delete(a.id); syncBtn(); } }),
            thumb(a, { tag: false }),
            h('div', {}, h('strong', {}, a.name), h('div', { class: 'small muted' }, `${typeLabel(a)} · ${fmtDuration(a.duration)}${inPl ? ' · already in this playlist' : ''}`)));
        }) : [h('p', { class: 'muted' }, state.assets.length ? translate('Nothing matches.') : translate('Your library is empty — upload or create content first.'))]));
      };
      const syncBtn = () => { addBtn.disabled = !chosen.size; addBtn.textContent = chosen.size ? localize`Add ${chosen.size}` : translate('Add'); };
      draw();
      const m = modal({
        title: 'Add content',
        body: h('div', { class: 'stack' },
          h('input', { type: 'search', placeholder: translate('Search your library'), oninput: (e) => { filter = e.target.value.toLowerCase(); draw(); } }),
          listEl,
          h('a', { href: '#/content', onclick: () => m.close() }, translate('Go to the content library to upload or create something new'))),
        footer: (close) => [h('button', { class: 'btn', type: 'button', onclick: close }, translate('Cancel')), addBtn],
      });
      addBtn.addEventListener('click', () => {
        // Keep library order for multi-select adds.
        for (const a of state.assets.filter((x) => chosen.has(x.id))) {
          draft.items.push({ id: `n${Math.random().toString(36).slice(2, 10)}`, assetId: a.id, enabled: true, duration: null, schedule: { startDate: '', endDate: '', days: [], startTime: '', endTime: '' } });
        }
        markDirty();
        drawItems();
        m.close();
      });
    }

    drawItems();

    const clock = h('input', { type: 'checkbox', checked: draft.showClock, onchange: (e) => { draft.showClock = e.target.checked; markDirty(); } });
    const ticker = h('textarea', { maxlength: 2000, placeholder: translate('Bar open from 12:00 on matchdays\nMembers’ draw — Friday night'), oninput: (e) => { draft.ticker = e.target.value; markDirty(); } }, draft.ticker || '');
    const screensUsing = state.screens.filter((s) => s.playlistId === id);

    return shell('playlists',
      h('div', { class: 'editor-head' },
        h('a', { class: 'btn ghost icon', href: '#/playlists', 'aria-label': translate('Back to playlists') }, icon('back')),
        nameInput,
        h('a', { class: 'btn', href: `/player/?preview=${encodeURIComponent(id)}`, target: '_blank', rel: 'noopener' }, icon('eye'), translate('Preview')),
        saveBtn),
      h('div', { class: 'editor-layout' },
        h('section', { class: 'stack' },
          h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap' },
            totals,
            h('button', { class: 'btn', type: 'button', onclick: addContent }, icon('plus'), translate('Add content'))),
          list),
        h('aside', { class: 'stack' },
          h('div', { class: 'card panel-box form-grid' },
            h('h2', {}, translate('On-screen extras')),
            h('label', { class: 'switch' }, clock, translate('Show clock')),
            h('label', { class: 'field' }, translate('Scrolling ticker'), ticker, h('span', { class: 'hint' }, translate('One message per line. Leave empty to hide the ticker.')))),
          h('div', { class: 'card panel-box' },
            h('h2', {}, translate('Screens')),
            screensUsing.length
              ? h('ul', { class: 'small', style: 'margin:0;padding-left:18px' }, screensUsing.map((s) => h('li', {}, s.name)))
              : h('p', { class: 'small muted' }, translate('No screens use this playlist yet.')),
            h('a', { class: 'small', href: '#/screens' }, translate('Manage screens'))),
          h('button', { class: 'btn danger', type: 'button', onclick: removePlaylist }, icon('trash'), translate('Delete playlist')))));
  }

  // =============================================================== screens
  let screenSlug = 'bar-tv';

  function viewScreens() {
    const playlistOptions = (selected) => [
      h('option', { value: '', selected: !selected }, translate('— Nothing (show splash) —')),
      ...state.playlists.map((p) => h('option', { value: p.id, selected: p.id === selected }, p.name)),
    ];
    const patch = async (s, body, msg) => {
      try {
        await api('PATCH', `/screens/${encodeURIComponent(s.id)}`, body);
        await refresh();
        toast(msg);
      } catch (err) {
        toast(err.message, 'error');
        render();
      }
    };
    const command = async (s, cmd) => {
      try {
        const r = await api('POST', `/screens/${encodeURIComponent(s.id)}/command`, { command: cmd });
        toast(r.delivered ? (cmd === 'identify' ? localize`Showing the name on “${s.name}” for 10 seconds` : localize`Reloading “${s.name}”`) : localize`“${s.name}” isn’t connected right now`, r.delivered ? 'ok' : 'error');
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    const cards = state.screens.map((s) =>
      h('div', { class: 'card screen', 'data-screen-id': s.id },
        h('div', { class: 'screen-head' },
          h('span', { class: `dot ${s.online ? 'on' : ''}`, title: s.online ? translate('Online') : translate('Offline') }),
          h('input', { type: 'text', value: s.name, maxlength: 80, 'aria-label': translate('Screen name'), onchange: (e) => e.target.value.trim() && patch(s, { name: e.target.value }, 'Renamed') })),
        h('dl', { class: 'kv' },
          h('dt', {}, translate('Status')), h('dd', { 'data-screen-status': '' }, s.online ? translate('Online') : localize`Offline · last seen ${ago(s.lastSeen)}`),
          h('dt', {}, translate('Screen id')), h('dd', { class: 'mono' }, s.id),
          s.resolution && [h('dt', {}, translate('Resolution')), h('dd', {}, s.resolution)],
          s.ip && [h('dt', {}, translate('Address')), h('dd', { class: 'mono' }, s.ip.replace(/^::ffff:/, ''))]),
        h('div', { class: 'row-2' },
          h('label', { class: 'field' }, translate('Playlist'), h('select', { onchange: (e) => patch(s, { playlistId: e.target.value }, 'Playlist changed — the screen updates now') }, playlistOptions(s.playlistId))),
          h('label', { class: 'field' }, translate('Rotation'), h('select', { onchange: (e) => patch(s, { rotation: Number(e.target.value) }, 'Rotation changed') },
            [[0, 'Landscape'], [90, 'Portrait (90°)'], [180, 'Upside down'], [270, 'Portrait (270°)']].map(([v, l]) => h('option', { value: v, selected: (s.rotation || 0) === v }, translate(l)))))),
        h('label', { class: 'field' }, translate('Language on screen'), h('select', { onchange: (e) => patch(s, { language: e.target.value }, 'Language changed — the screen updates now') },
          h('option', { value: '', selected: !s.language }, localize`Club default (${(state.languages.find((l) => l.code === state.settings.language) || { name: 'English' }).name})`),
          state.languages.map((l) => h('option', { value: l.code, selected: s.language === l.code }, l.name)))),
        h('div', { class: 'actions' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => command(s, 'identify') }, icon('target'), translate('Identify')),
          h('button', { class: 'btn sm', type: 'button', onclick: () => command(s, 'reload') }, icon('refresh'), translate('Reload')),
          h('a', { class: 'btn sm', href: `/player/?screen=${encodeURIComponent(s.id)}`, target: '_blank', rel: 'noopener' }, icon('external'), translate('Open')),
          h('button', {
            class: 'btn sm ghost danger', type: 'button',
            onclick: async () => {
              if (!(await confirmDialog(localize`Remove “${s.name}”?`, 'If the screen is still running it will reappear with the default playlist the next time it checks in.'))) return;
              try { await api('DELETE', `/screens/${encodeURIComponent(s.id)}`); await refresh(); render(); } catch (err) { toast(err.message, 'error'); }
            },
          }, icon('trash'), translate('Remove')))));

    const urlCode = h('code', {});
    const slugInput = h('input', { type: 'text', value: screenSlug, maxlength: 64, 'aria-label': translate('New screen id'), oninput: (e) => { screenSlug = e.target.value.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^[-_]+/, ''); syncUrl(); } });
    const syncUrl = () => { urlCode.textContent = `${baseUrl()}/player/?screen=${screenSlug || 'my-screen'}`; };
    syncUrl();

    const howTo = h('details', { class: 'card panel-box', open: !state.screens.length },
      h('summary', { style: 'cursor:pointer;font-weight:700' }, translate('Add a screen')),
      h('ol', { class: 'steps', style: 'margin-top:14px' },
        h('li', {}, h('strong', {}, translate('Raspberry Pi with the PitchTribe image: ')), translate('plug it into the TV and switch on. It appears here by itself, named after the Pi.')),
        h('li', {}, h('strong', {}, translate('Any other screen ')), translate('(smart TV browser, a PC or a second Pi): pick a name, then open this address full-screen on it:'),
          h('div', { class: 'stack', style: 'margin-top:8px;gap:8px' },
            h('label', { class: 'field' }, translate('Screen id'), slugInput),
            h('div', { class: 'copy-row' }, urlCode,
              h('button', { class: 'btn sm', type: 'button', onclick: () => navigator.clipboard?.writeText(urlCode.textContent).then(() => toast('Copied'), () => toast('Copy failed — select the text instead', 'error')) }, icon('copy'), translate('Copy'))))),
        h('li', {}, translate('Once it shows up below, choose its playlist.'))));

    return shell('screens',
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, translate('Screens')), h('p', {}, translate('Every display connected to PitchTribe. Updates every few seconds.')))),
      h('div', { class: 'stack' },
        howTo,
        cards.length ? h('div', { class: 'screens' }, cards) : h('div', { class: 'card empty' }, h('h2', {}, translate('No screens yet')), h('p', {}, translate('Follow the steps above — your first screen will appear here.')))));
  }

  // ============================================================ guest wi-fi
  let portal = null; // GET /api/portal
  let portalLoading = false;
  async function loadPortal() {
    if (portalLoading) return;
    portalLoading = true;
    try { portal = await api('GET', '/portal'); } catch (err) { toast(err.message, 'error'); }
    portalLoading = false;
    if (currentView === 'wifi') render();
  }

  function viewWifi() {
    if (!portal) {
      loadPortal();
      return shell('wifi', h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, translate('Guest Wi-Fi')))), h('p', { class: 'muted' }, translate('Loading…')));
    }
    const p = portal.settings;
    const st = portal.stats;
    const running = st.serviceSeenAt && Date.now() - Date.parse(st.serviceSeenAt) < 3 * 60_000;
    const f = {
      enabled: h('input', { type: 'checkbox', checked: p.enabled }),
      ssid: h('input', { type: 'text', value: p.ssid, maxlength: 32, required: true }),
      radio: h('select', {}, [
        ['auto', 'Automatic — the USB aerial if one is plugged in, otherwise built-in'],
        ['builtin', 'The Pi’s built-in Wi-Fi'],
        ['usb', 'USB Wi-Fi aerial (e.g. Alfa)'],
        ['off', 'None — ceiling access points only'],
      ].map(([v, l]) => h('option', { value: v, selected: p.radio === v }, translate(l)))),
      band: h('select', {}, [['2.4', '2.4 GHz — reaches further, through walls'], ['5', '5 GHz — faster, shorter range']]
        .map(([v, l]) => h('option', { value: v, selected: p.band === v }, translate(l)))),
      channel: h('select', {}),
      accessPoints: h('input', { type: 'checkbox', checked: p.accessPoints }),
      sessionMinutes: h('select', {}, [[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [480, '8 hours'], [1440, '24 hours']].map(([v, l]) => h('option', { value: v, selected: p.sessionMinutes === v }, translate(l)))),
      downMbps: h('input', { type: 'number', min: 1, max: 200, value: p.downMbps }),
      upMbps: h('input', { type: 'number', min: 1, max: 100, value: p.upMbps }),
      headline: h('input', { type: 'text', value: p.headline, maxlength: 120, required: true }),
      message: h('textarea', { maxlength: 1000 }, p.message),
      terms: h('textarea', { maxlength: 6000, required: true }, p.terms),
      accent: h('input', { type: 'color', value: p.accent }),
      logoAssetId: h('select', {}, h('option', { value: '' }, translate('Club initial')), state.assets.filter((a) => a.type === 'image').map((a) => h('option', { value: a.id, selected: a.id === p.logoAssetId }, a.name))),
      redirectUrl: h('input', { type: 'url', value: p.redirectUrl, placeholder: translate('https://yourclub.example (optional)') }),
      collectEmail: h('select', {}, [['off', 'Don’t ask'], ['optional', 'Ask (optional)'], ['required', 'Required to connect']].map(([v, l]) => h('option', { value: v, selected: p.collectEmail === v }, translate(l)))),
      consentText: h('input', { type: 'text', value: p.consentText, maxlength: 300 }),
    };
    f.terms.style.minHeight = '180px';
    const fillChannels = (keep) => {
      const list = f.band.value === '5' ? [36, 40, 44, 48] : [1, 6, 11];
      const pick = list.includes(keep) ? keep : list[f.band.value === '5' ? 0 : 1];
      f.channel.replaceChildren(...list.map((c) => h('option', { value: c, selected: c === pick }, localize`Channel ${c}`)));
    };
    fillChannels(p.channel);
    f.band.addEventListener('change', () => fillChannels(Number(f.channel.value)));
    const bandRow = h('div', { class: 'row-2' },
      h('label', { class: 'field' }, translate('Band'), f.band),
      h('label', { class: 'field' }, translate('Radio channel'), f.channel, h('span', { class: 'hint' }, translate('Try another if the signal is poor.'))));
    const syncRadio = () => { bandRow.hidden = f.radio.value === 'off'; };
    f.radio.addEventListener('change', syncRadio);
    const frame = h('iframe', { class: 'portal-preview', title: translate('Splash page preview'), src: `/api/portal/preview?accent=${encodeURIComponent(p.accent)}&t=${Date.now()}` });
    f.accent.addEventListener('input', () => { frame.src = `/api/portal/preview?accent=${encodeURIComponent(f.accent.value)}&t=${Date.now()}`; });

    const form = h('form', {
      class: 'card panel-box form-grid',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!form.reportValidity()) return;
        const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
        for (const k of ['channel', 'sessionMinutes', 'downMbps', 'upMbps']) body[k] = Number(body[k]);
        if (body.enabled && body.radio === 'off' && !body.accessPoints) {
          toast('Choose a Wi-Fi radio, or switch on ceiling access points', 'error');
          return;
        }
        try {
          const r = await api('PUT', '/portal', body);
          portal.settings = r.settings;
          render();
          // Don't promise a network the Pi can't broadcast: without the add-on
          // these settings are saved and nothing applies them.
          toast(!r.settings.enabled ? 'Saved — guest Wi-Fi is off'
            : portal.installed ? 'Saved — the Wi-Fi updates in a few seconds'
              : 'Saved, but the guest Wi-Fi add-on isn’t installed on this Pi yet', portal.installed ? 'ok' : 'error');
          setTimeout(() => { if (currentView === 'wifi') { portal = null; render(); } }, 8000); // pick up the hardware check
        } catch (err) { toast(err.message, 'error'); }
      },
    },
      h('h2', {}, translate('Network')),
      h('label', { class: 'switch' }, f.enabled, translate('Guest Wi-Fi on')),
      h('label', { class: 'field' }, translate('Network name (SSID)'), f.ssid),
      h('h2', { style: 'margin-top:8px' }, translate('Coverage')),
      h('label', { class: 'field' }, translate('Broadcast from'), f.radio,
        h('span', { class: 'hint' }, translate('A USB Wi-Fi adapter with aerials reaches much further than the built-in Wi-Fi. Plug it into a blue USB port; it’s picked up by itself.'))),
      bandRow,
      h('label', { class: 'switch' }, f.accessPoints, translate('Ceiling access points, on a USB network adapter')),
      h('p', { class: 'small muted' }, translate('For bigger venues: access points around the building, cabled to a PoE switch plugged into the Pi’s USB network adapter. They all share this sign-in page. '),
        h('a', { href: 'https://pitchtribe.media/docs/guest-wifi#bigger-venues', target: '_blank', rel: 'noopener' }, translate('How to set them up'))),
      h('div', { class: 'row-2' },
        h('label', { class: 'field' }, translate('Session length'), f.sessionMinutes, h('span', { class: 'hint' }, translate('Guests tap “Connect” again afterwards.'))),
        h('div', { class: 'row-2' }, h('label', { class: 'field' }, translate('Download limit (Mbit/s)'), f.downMbps), h('label', { class: 'field' }, translate('Upload (Mbit/s)'), f.upMbps))),
      h('p', { class: 'small muted' }, translate('Limits are per device. Guests can reach the internet only — never the club’s own computers, tills or this dashboard.')),
      h('h2', { style: 'margin-top:8px' }, translate('Splash page')),
      h('label', { class: 'field' }, translate('Headline'), f.headline, h('span', { class: 'hint' }, translate('{club} is replaced with your club’s name.'))),
      h('label', { class: 'field' }, translate('Message'), f.message),
      h('div', { class: 'row-2' }, h('label', { class: 'field' }, translate('Logo'), f.logoAssetId, h('span', { class: 'hint' }, translate('From your content library — upload a PNG with a transparent background for best results.'))), h('label', { class: 'field' }, translate('Colour'), f.accent)),
      h('label', { class: 'field' }, translate('Terms of use'), f.terms, h('span', { class: 'hint' }, translate('A sensible starting point is filled in. Have someone at the club check it suits you.'))),
      h('label', { class: 'field' }, translate('After connecting, offer a link to'), f.redirectUrl),
      h('h2', { style: 'margin-top:8px' }, translate('Email addresses')),
      h('div', { class: 'row-2' }, h('label', { class: 'field' }, translate('Ask guests for their email'), f.collectEmail), h('label', { class: 'field' }, translate('Marketing consent wording'), f.consentText)),
      h('p', { class: 'small muted' }, translate('Guests choose separately whether you may email them — the consent box is never pre-ticked. Only contact people who said yes, and delete the list when you no longer need it.')),
      h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, translate('Save'))));

    const stats = h('div', { class: 'card panel-box stack', style: 'gap:12px' },
      h('h2', {}, translate('Status')),
      h('dl', { class: 'kv' },
        h('dt', {}, translate('Portal service')), h('dd', {}, running ? translate('Running')
          : !p.enabled ? translate('Off')
            : portal.installed ? translate('Starting up — give it a minute, then check Hardware below')
              : translate('Not installed on this Pi')),
        h('dt', {}, translate('Connected now')), h('dd', {}, String(st.active)),
        h('dt', {}, translate('Connections today')), h('dd', {}, String(st.today)),
        h('dt', {}, translate('Last 7 days')), h('dd', {}, String(st.week))),
      p.collectEmail !== 'off' || portal.guests.count
        ? h('div', { class: 'stack', style: 'gap:8px' },
          h('p', { class: 'small' }, localize`${portal.guests.count} email address${portal.guests.count === 1 ? '' : 'es'} collected, ${portal.guests.consented} agreed to hear from you.`),
          h('div', { class: 'actions' },
            h('a', { class: 'btn sm', href: '/api/portal/guests.csv', download: 'wifi-guests.csv' }, icon('upload'), translate('Download CSV')),
            h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
              if (!(await confirmDialog('Delete all collected email addresses?', 'This can’t be undone. Download the CSV first if you need it.'))) return;
              await api('DELETE', '/portal/guests');
              portal = null;
              render();
              toast('Guest list deleted');
            } }, icon('trash'), translate('Delete list'))))
        : null,
      h('details', { class: 'help' }, h('summary', {}, translate('How the hardware is set up')),
        h('p', { style: 'margin-top:8px' }, translate('The guest network runs on the Pi’s built-in Wi-Fi (or a USB aerial) while the Pi’s network cable stays plugged into the club router. Cards written from the PitchTribe SD card image already have everything they need — switch Guest Wi-Fi on above and it applies by itself.')),
        h('p', {}, translate('On a Pi that was set up by hand, install the guest Wi-Fi part once, from a terminal on the Pi over SSH (switch SSH on under Settings → Remote access):')),
        h('pre', {}, translate('curl -sSL https://pitchtribe.media/install.sh | sudo PITCHTRIBE_PORTAL=1 bash')),
        h('p', {}, h('a', { href: 'https://pitchtribe.media/docs/guest-wifi', target: '_blank', rel: 'noopener' }, translate('Step-by-step guide')))));

    // Saving settings the Pi cannot apply looks exactly like success, so say so
    // in the one place nobody can miss, not only in the sidebar.
    const notInstalled = portal.installed ? null : h('div', { class: 'card panel-box stack', style: 'gap:8px' },
      h('h2', { style: 'color:var(--danger)' }, translate('⚠ The guest Wi-Fi part isn’t installed on this Pi')),
      h('p', { class: 'small' }, translate('You can save the settings below, but nothing on this Pi will broadcast the network, so it won’t appear on anyone’s phone. Install it once over SSH (Settings → Remote access), then these settings apply by themselves:')),
      h('div', { class: 'help' }, h('pre', {}, translate('curl -sSL https://pitchtribe.media/install.sh | sudo PITCHTRIBE_PORTAL=1 bash'))),
      h('p', { class: 'small muted' }, translate('Cards written from the PitchTribe SD card image have it already. '),
        h('a', { href: 'https://pitchtribe.media/docs/guest-wifi', target: '_blank', rel: 'noopener' }, translate('Guest Wi-Fi guide'))));

    syncRadio();
    return shell('wifi',
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, translate('Guest Wi-Fi')), h('p', {}, translate('Free Wi-Fi for visitors, with your own sign-in page.')))),
      notInstalled,
      h('div', { class: 'editor-layout wifi-layout' },
        form,
        h('aside', { class: 'stack' }, h('div', { class: 'card panel-box' }, h('h2', {}, translate('Preview')), frame), stats, hardwareCard(portal.hardware))));
  }

  /** What the Wi-Fi add-on found on the Pi the last time it applied the settings. */
  function hardwareCard(hw) {
    const head = h('h2', {}, translate('Hardware'));
    if (!hw) {
      return h('div', { class: 'card panel-box stack', style: 'gap:8px' }, head,
        h('p', { class: 'small muted' }, translate('Not checked yet. The Wi-Fi add-on lists the Pi’s radios and adapters here when it applies your settings.')));
    }
    const label = (d) => {
      if (d.kind === 'wifi') return d.bus === 'usb' ? (d.product ? localize`USB Wi-Fi aerial (${d.product})` : translate('USB Wi-Fi aerial')) : translate('Built-in Wi-Fi');
      if (d.bus === 'usb') return d.product ? localize`USB network adapter (${d.product})` : translate('USB network adapter');
      return 'Network port';
    };
    const role = (d) => {
      if (d.name === hw.wifi) return 'Broadcasting guest Wi-Fi';
      if (d.name === hw.wired) return d.carrier ? 'Access points — cable connected' : 'Access points — no cable plugged in';
      if (d.kind === 'ethernet' && d.bus === 'builtin') return d.carrier ? 'Internet — connected' : 'Internet — no cable plugged in';
      return 'Not used';
    };
    return h('div', { class: 'card panel-box stack', style: 'gap:10px' }, head,
      h('div', { class: 'stack', style: 'gap:8px' }, hw.devices.map((d) => h('div', {},
        h('div', { style: 'font-weight:600' }, translate(label(d))),
        h('div', { class: 'small muted' }, translate(role(d)))))),
      hw.problems.length ? h('div', { class: 'stack', style: 'gap:6px' }, hw.problems.map((t) => h('p', { class: 'small', style: 'color:var(--danger)' }, '⚠ ', translate(t)))) : null,
      h('p', { class: 'small muted' }, localize`Checked ${new Date(hw.checkedAt).toLocaleString()}. Plugging an adapter in or out re-checks by itself.`));
  }

  // ============================================================== settings
  function viewSettings() {
    const club = h('input', { type: 'text', value: state.settings.clubName, maxlength: 80, required: true });
    const lang = h('select', {}, state.languages.map((l) => h('option', { value: l.code, selected: (state.settings.language || 'en') === l.code }, l.name)));
    const def = h('select', {},
      h('option', { value: '', selected: !state.settings.defaultPlaylistId }, translate('— None —')),
      state.playlists.map((p) => h('option', { value: p.id, selected: p.id === state.settings.defaultPlaylistId }, p.name)));
    const general = h('form', {
      class: 'card panel-box form-grid',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('PUT', '/settings', { clubName: club.value, defaultPlaylistId: def.value || null, language: lang.value });
          await refresh();
          render();
          toast('Settings saved');
        } catch (err) { toast(err.message, 'error'); }
      },
    },
      h('h2', {}, translate('Club')),
      h('label', { class: 'field' }, translate('Club name'), club, h('span', { class: 'hint' }, translate('Shown on notices, menus and fixture slides.'))),
      h('label', { class: 'field' }, translate('Playlist for new screens'), def),
      h('label', { class: 'field' }, translate('Screen language'), lang, h('span', { class: 'hint' }, translate('Built-in labels, dates and times on your screens. Your own notices and menus show as you write them; built-in quizzes and jokes stay in English. Individual screens can override this on the Screens page.'))),
      h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, translate('Save'))));

    const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
    const pw = h('form', {
      class: 'card panel-box form-grid',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/settings/password', { current: cur.value, next: next.value });
          cur.value = next.value = '';
          toast('Password changed — other devices have been signed out');
        } catch (err) { toast(err.message, 'error'); }
      },
    },
      h('h2', {}, translate('Admin password')),
      h('label', { class: 'field' }, translate('Current password'), cur),
      h('label', { class: 'field' }, translate('New password'), next, h('span', { class: 'hint' }, translate('At least 8 characters.'))),
      h('div', {}, h('button', { class: 'btn', type: 'submit' }, translate('Change password'))));

    const sports = sportsCard();
    const widgetSettings = widgetsCard();
    const backupsBox = backupCard();
    const remoteBox = remoteAccessCard();
    const supportBox = supportAccessCard();
    const secureBox = secureConnectionCard();

    const about = h('div', { class: 'card panel-box stack', style: 'gap:10px' },
      h('h2', {}, translate('About')),
      h('dl', { class: 'kv' },
        h('dt', {}, translate('Version')), h('dd', {}, state.version),
        osUpdateRow(),
        h('dt', {}, translate('Dashboard')), h('dd', {}, state.dashboardUrls.length ? state.dashboardUrls.join('  ') : location.origin),
        h('dt', {}, translate('Content')), h('dd', {}, localize`${state.assets.length} items · ${fmtBytes(state.assets.reduce((n, a) => n + (a.file?.size || 0), 0))} of media`)),
      osUpdateNotes(),
      h('p', { class: 'small muted' }, translate('PitchTribe is free, open-source software (MIT licence).')));

    return shell('settings',
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, translate('Settings')))),
      h('div', { class: 'stack', style: 'max-width:640px' }, general, sports, widgetSettings, backupsBox, remoteBox, supportBox, secureBox, pw, about));
  }

  /* Settings → About: the nightly Raspberry Pi OS update ------------------------------
     Written by the root helper (deploy/update/os-update.sh) and read into
     state.osUpdate by app/lib/os-update.js. Until this, finding out whether a
     card was patched took SSH, so nobody looked: a club sees a restart waiting,
     or a Pi that quietly stopped being patched, only if it is said here. */
  function osUpdateRow() {
    const u = state.osUpdate;
    if (!u || !u.available) {
      return [h('dt', {}, translate('Raspberry Pi OS')),
        h('dd', { class: 'muted' }, translate('Not checked yet — the nightly update fills this in the first time it runs.'))];
    }
    const when = u.checkedAt ? ago(Date.parse(u.checkedAt)) : 'at an unknown time';
    const summary = u.result === 'offline' ? `Couldn’t reach the update service · tried ${when}`
      : u.result === 'error' ? `Last update didn’t finish · ${when}`
        : u.upgraded ? `${u.upgraded} update${u.upgraded === 1 ? '' : 's'} installed · ${when}`
          : `Up to date · checked ${when}`;
    return [h('dt', {}, translate('Raspberry Pi OS')),
      h('dd', u.level === 'warn' ? { style: 'color:var(--danger)' } : {}, summary)];
  }

  function osUpdateNotes() {
    const u = state.osUpdate;
    if (!u || !u.available) return null;
    const warn = (...text) => h('p', { class: 'small', style: 'color:var(--danger)' }, '⚠ ', ...text);
    const out = [];
    // The one that matters: the helper never restarts a screen by itself, so a
    // kernel fix sits there installed-but-inert until somebody is told.
    if (u.rebootRequired) {
      out.push(warn('A restart is waiting. One of the updates needs the Pi restarted before it takes effect — ',
        'PitchTribe never does that by itself, in case a match is on. Restart it when it suits the club; the screens come back on their own.'));
    }
    if (u.silent) {
      out.push(warn(`The nightly update hasn’t run for ${u.daysSinceCheck} days. `,
        'If the Pi has been switched off, that’s nothing to worry about — it catches up on the next night it’s on.'));
    } else if (u.unpatched) {
      out.push(u.daysSincePatched === null
        ? warn('This Pi has never managed to fetch its operating-system updates. Check that it can reach the internet: until it can, it isn’t getting security fixes.')
        : warn(`Nothing has been installed for ${u.daysSincePatched} days. `,
          'The Pi tries every night and can’t reach the update service — check its internet connection, because meanwhile the card isn’t getting security fixes.'));
    } else if (u.result === 'offline') {
      out.push(h('p', { class: 'small muted' }, translate('The Pi couldn’t reach the update service on its last try. That happens — it tries again tonight.')));
    } else if (u.result === 'error') {
      out.push(warn(`The last update stopped part way${u.message ? ` (${u.message})` : ''}. `,
        'It tries again tonight. If it keeps happening, the memory card may be full.'));
    }
    if (u.packages.length) {
      out.push(h('details', { class: 'help' },
        h('summary', {}, u.upgraded > u.packages.length ? localize`What was installed (first ${u.packages.length} of ${u.upgraded})` : translate('What was installed')),
        h('p', { class: 'small muted', style: 'margin-top:8px' }, u.packages.join(', '))));
    }
    return out;
  }

  // Settings → Secure connection -------------------------------------------------------
  let secureBusy = false;

  function secureConnectionCard() {
    const head = [
      h('h2', {}, translate('Secure connection (HTTPS)')),
      h('p', { class: 'small muted' }, translate('Encrypts what passes between your phone and the Pi — the dashboard password most of all — on the club’s network.')),
    ];
    const box = (...kids) => h('div', { class: 'card panel-box stack', style: 'gap:10px' }, ...head, ...kids);
    const t = state.tls;
    if (!t || !t.available) {
      return box(h('p', { class: 'small muted' }, translate('This Pi is serving the dashboard over plain '), h('code', {}, translate('http')), translate(' only. HTTPS starts by itself on a Pi running PitchTribe 0.4.2 or later; on an older one, update it from Settings → Remote access.')));
    }
    const secureNow = location.protocol === 'https:';
    const toggle = h('input', { type: 'checkbox', checked: Boolean(t.redirect), disabled: secureBusy });
    toggle.addEventListener('change', async () => {
      secureBusy = true;
      const want = toggle.checked;
      try {
        await api('PUT', '/tls', { redirect: want });
        await refresh();
        toast(want ? 'The dashboard now sends people to HTTPS' : 'The dashboard no longer redirects');
      } catch (err) { toast(err.message, 'error'); }
      secureBusy = false;
      render();
    });

    return box(
      h('p', { class: 'small' }, secureNow
        ? h('span', {}, translate('You are on '), h('strong', {}, translate('HTTPS')), translate(' now.'))
        : h('span', {}, translate('You are on plain '), h('strong', {}, translate('http')), translate('. The secure address is '), h('a', { href: t.url }, t.url))),
      h('dl', { class: 'kv' },
        h('dt', {}, translate('Certificate')), h('dd', {}, h('code', { style: 'word-break:break-all' }, t.fingerprint || '—')),
        h('dt', {}, translate('Renews')), h('dd', {}, t.notAfter ? new Date(t.notAfter).toLocaleDateString() : '—')),
      h('p', { class: 'small muted' }, translate('Your browser will warn you the first time, and it is right to: the Pi signed its own certificate, because no certificate authority will vouch for a name like '), h('code', {}, t.names?.[0] || translate('pitchtribe.local')), translate(' on a private network. Continue past the warning once, and check that the fingerprint your browser shows matches the one above — that is what tells you it is this Pi and not something else on the network.')),
      h('label', { class: 'switch' }, toggle, translate('Send the dashboard to HTTPS')),
      h('p', { class: 'small muted' }, translate('Off by default, so nobody meets a warning unasked. With it on, opening the dashboard over '), h('code', {}, translate('http')), translate(' jumps to HTTPS. Screens and the TV on this Pi are left on '), h('code', {}, translate('http')), translate(' — they have no keyboard to dismiss a warning with — and they carry nothing private. If a phone will not get past the warning, add '), h('code', {}, translate('?nossl')), translate(' to the dashboard address to come back over '), h('code', {}, translate('http')), '.'));
  }

  // Settings → Remote access -----------------------------------------------------------
  let remoteInfo = null; // GET /api/remote-access
  let remoteBusy = false;

  async function loadRemote() {
    try { remoteInfo = await api('GET', '/remote-access'); } catch (err) { toast(err.message, 'error'); }
    if (currentView === 'settings') render();
  }

  function remoteAccessCard() {
    const head = [
      h('h2', {}, translate('Remote access (SSH)')),
      h('p', { class: 'small muted' }, translate('Lets you log in to the Pi from a computer — to update PitchTribe, add guest Wi-Fi, or reset a password — without a keyboard and screen.')),
    ];
    if (!remoteInfo) {
      loadRemote();
      return h('div', { class: 'card panel-box stack', style: 'gap:10px' }, ...head, h('p', { class: 'small muted' }, translate('Loading…')));
    }
    if (!remoteInfo.available) {
      /* Which "unavailable" this is comes from the server, because the two
         readings want opposite things said: no helper on this machine at all,
         or a helper that is there and kept its state file unreadable. Telling a
         club standing in front of a Pi that it isn't one, and saying nothing
         about repairing it, was the wrong half of that. */
      return h('div', { class: 'card panel-box stack', style: 'gap:10px' }, ...head,
        h('p', { class: 'small muted' }, remoteInfo.unavailableReason
          || translate('Remote access is switched on from a Raspberry Pi running PitchTribe 0.2 or later.')));
    }
    const st = remoteInfo.status;
    const on = st.sshActive;
    const name = st.username || st.users[0] || 'clubadmin';
    const enabled = h('input', { type: 'checkbox', checked: on });
    const user = h('input', { type: 'text', value: name, maxlength: 31, autocomplete: 'off', autocapitalize: 'none', spellcheck: false, pattern: '[a-z][a-z0-9-]{2,30}' });
    const pass = h('input', { type: 'password', autocomplete: 'new-password', minlength: 10, placeholder: on ? translate('Leave empty to keep the current one') : '' });
    const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const loginRows = h('div', { class: 'stack', style: 'gap:10px' },
      h('label', { class: 'field' }, translate('Username'), user, h('span', { class: 'hint' }, translate('Small letters, numbers and hyphens. Use the name you set in Raspberry Pi Imager to give it a new password.'))),
      h('label', { class: 'field' }, on ? translate('New SSH password') : translate('SSH password'), pass, h('span', { class: 'hint' }, translate('At least 10 characters. Write it down somewhere safe — it isn’t the dashboard password.'))));
    const sync = () => { loginRows.hidden = !enabled.checked; };
    enabled.addEventListener('change', sync);
    sync();

    const form = h('form', {
      class: 'card panel-box form-grid',
      onsubmit: async (e) => {
        e.preventDefault();
        const turningOn = enabled.checked;
        if (turningOn && !pass.value && !on) { toast('Choose an SSH password', 'error'); return; }
        if (turningOn && on && !pass.value && user.value === name) { toast('Nothing to change — enter a new password, or switch it off', 'error'); return; }
        if (!turningOn && !on) { toast('Remote access is already off'); return; }
        remoteBusy = true;
        try {
          const r = await api('POST', '/remote-access', { enabled: turningOn, username: user.value.trim(), password: pass.value, currentPassword: current.value });
          current.value = pass.value = '';
          const last = await awaitRemoteRequest(r.requestId);
          toast(last ? last.message : 'The Pi hasn’t answered yet — check again in a minute', last && !last.ok ? 'error' : undefined);
        } catch (err) { toast(err.message, 'error'); }
        remoteBusy = false;
        await loadRemote();
      },
    },
      ...head,
      h('p', { class: 'small' }, on
        ? h('span', {}, translate('SSH is '), h('strong', {}, translate('on')), translate('. From a computer on the club network: '), h('code', {}, localize`ssh ${name}@${location.hostname}`))
        : h('span', {}, translate('SSH is '), h('strong', {}, translate('off')), '.')),
      h('label', { class: 'switch' }, enabled, translate('Remote access on')),
      loginRows,
      h('label', { class: 'field' }, translate('Your dashboard password'), current, h('span', { class: 'hint' }, translate('Needed to change remote access, because the SSH login can change anything on the Pi.'))),
      st.last && !st.last.ok && !String(st.last.action || '').startsWith('support-')
        ? h('p', { class: 'small', style: 'color:var(--danger)' }, `⚠ ${st.last.message}`) : null,
      h('div', {}, h('button', { class: 'btn primary', type: 'submit', disabled: remoteBusy }, remoteBusy ? translate('Working…') : translate('Save'))),
      h('p', { class: 'small muted' }, translate('Anyone with the SSH login can change anything on the Pi. Use a strong password, and switch it off when you don’t need it.')));
    return form;
  }

  // Settings → Remote access → support access ------------------------------------------
  let supportBusy = false;

  /** Wait for the root helper to pick our request up, then show what it said. */
  async function awaitRemoteRequest(requestId) {
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const now = await api('GET', '/remote-access').catch(() => null);
      if (now?.status?.lastRequestId === requestId) {
        remoteInfo = now;
        return now.status.last;
      }
    }
    return null;
  }

  function supportAccessCard() {
    const head = [
      h('h2', {}, translate('Let PitchTribe support connect')),
      h('p', { class: 'small muted' }, translate('Off until you switch it on. It lets us look at this Pi to help with a problem, without anyone opening a port on the club’s router.')),
    ];
    const box = (...kids) => h('div', { class: 'card panel-box stack', style: 'gap:10px' }, ...head, ...kids);
    if (!remoteInfo) return box(h('p', { class: 'small muted' }, translate('Loading…')));
    if (!remoteInfo.available) {
      return box(h('p', { class: 'small muted' }, remoteInfo.unavailableReason
        || translate('Support access is switched on from a Raspberry Pi running PitchTribe.')));
    }
    const s = remoteInfo.status.support || {};
    if (!s.installed) {
      return box(h('p', { class: 'small muted' }, translate('This Pi doesn’t have the Raspberry Pi Connect client, so support access isn’t available here. '),
        translate('SSH on the club network, above, is the way in.')));
    }

    const hoursOptions = remoteInfo.supportHours || [6];
    const hoursDefault = remoteInfo.supportHoursDefault || hoursOptions[0];
    const hours = h('select', {},
      ...hoursOptions.map((n) => h('option', { value: String(n), selected: n === hoursDefault }, n === 1 ? translate('1 hour') : localize`${n} hours`)));
    const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });

    const act = async (body, confirmText) => {
      if (confirmText && !confirm(translate(confirmText))) return;
      supportBusy = true;
      render();
      try {
        const r = await api('POST', '/remote-access', { ...body, currentPassword: current.value });
        current.value = '';
        const last = await awaitRemoteRequest(r.requestId);
        toast(last ? last.message : 'The Pi hasn’t answered yet — check again in a minute', last && !last.ok ? 'error' : undefined);
      } catch (err) { toast(err.message, 'error'); }
      supportBusy = false;
      await loadRemote();
    };

    // On: the sign-in to finish, how long is left, and the way to end it now.
    if (s.enabled) {
      const left = s.expiresAt ? Math.max(0, new Date(s.expiresAt) - Date.now()) : 0;
      const mins = Math.round(left / 60000);
      const countdown = !s.expiresAt ? 'no end time recorded — it will be ended at the next check'
        : left <= 0 ? 'any moment now'
          : mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)} h ${mins % 60} min`;
      const end = h('button', { class: 'btn', type: 'button', disabled: supportBusy },
        supportBusy ? translate('Working…') : translate('End support access'));
      end.addEventListener('click', () => act({ support: { enabled: false } }, 'End support access now?'));
      return box(
        h('p', { class: 'small' }, translate('Support access is '), h('strong', {}, s.signedIn ? translate('on') : translate('waiting to be finished')), '.'),
        !s.signedIn && s.signin
          ? h('div', { class: 'stack', style: 'gap:6px' },
            h('p', { class: 'small' }, translate('Finish on a phone or computer: open '), h('a', { href: s.signin.url, target: '_blank', rel: 'noopener' }, s.signin.url),
              translate(' and sign in with the club’s own Raspberry Pi ID. Make one there if the club hasn’t got one.')),
            s.signin.code ? h('p', { class: 'small' }, translate('Code: '), h('code', { style: 'font-size:1.2em' }, s.signin.code)) : null)
          : null,
        h('dl', { class: 'kv' },
          h('dt', {}, translate('Ends')), h('dd', {}, countdown),
          h('dt', {}, translate('Support connected')), h('dd', {}, s.connected ? translate('now') : ago(s.lastConnection ? new Date(s.lastConnection).getTime() : 0)),
          h('dt', {}, translate('Signed in as')), h('dd', {}, s.user || '—')),
        h('label', { class: 'field' }, translate('Your dashboard password'), current, h('span', { class: 'hint' }, translate('Needed to end support access, the same as to start it.'))),
        h('div', {}, end),
        h('p', { class: 'small muted' }, translate('It ends by itself at the time above even if you never come back to this page. The club owns the Raspberry Pi ID it is signed in to, so you can also remove this device at '),
          h('a', { href: 'https://connect.raspberrypi.com', target: '_blank', rel: 'noopener' }, translate('connect.raspberrypi.com')), translate(' at any time.')));
    }

    // Off: the normal state of every card.
    const stuckEnd = h('button', { class: 'btn', type: 'button', disabled: supportBusy },
      supportBusy ? translate('Working…') : translate('Try signing out again'));
    stuckEnd.addEventListener('click', () => act({ support: { enabled: false } }));
    const form = h('form', {
      class: 'card panel-box form-grid',
      onsubmit: (e) => { e.preventDefault(); act({ support: { enabled: true, hours: Number(hours.value) } }); },
    },
      ...head,
      h('p', { class: 'small' }, translate('Support access is '), h('strong', {}, translate('off')), '.'),
      // The Pi has no bounded session, and yet Raspberry Pi Connect says it is
      // signed in. The card tries to sign out by itself every few minutes, but
      // "off" would be a lie to leave on the screen in the meantime.
      s.signedIn ? h('div', { class: 'stack', style: 'gap:6px' },
        h('p', { class: 'small', style: 'color:var(--danger)' },
          translate('⚠ Raspberry Pi Connect still reports this Pi as signed in, with no support session behind it. '),
          translate('This Pi keeps trying to sign out on its own; to be certain, remove the device at '),
          h('a', { href: 'https://connect.raspberrypi.com', target: '_blank', rel: 'noopener' }, translate('connect.raspberrypi.com')), '.'),
        h('div', {}, stuckEnd)) : null,
      h('label', { class: 'field' }, translate('Let support connect for'), hours, h('span', { class: 'hint' }, translate('It ends by itself when the time is up — there is no option to leave it on indefinitely.'))),
      h('label', { class: 'field' }, translate('Your dashboard password'), current, h('span', { class: 'hint' }, translate('Needed to start support access, because it gives us a shell on this Pi.'))),
      remoteInfo.status.last && !remoteInfo.status.last.ok && String(remoteInfo.status.last.action || '').startsWith('support-')
        ? h('p', { class: 'small', style: 'color:var(--danger)' }, `⚠ ${remoteInfo.status.last.message}`) : null,
      h('div', {}, h('button', { class: 'btn primary', type: 'submit', disabled: supportBusy }, supportBusy ? translate('Working…') : translate('Turn support access on'))),
      h('p', { class: 'small muted' }, translate('This uses Raspberry Pi Connect. You will be given a link to finish at, where you sign in with the '),
        h('strong', {}, translate('club’s own')), translate(' Raspberry Pi ID — not a PitchTribe account — so the club can see the device and remove it whenever it likes. '),
        translate('Nothing is opened on the club’s router: the Pi connects outwards. SSH, above, is not affected either way.')));
    return form;
  }

  // Settings → Backups --------------------------------------------------------------
  let backupInfo = null; // GET /api/backup
  let backupBusy = '';

  async function loadBackup() {
    try { backupInfo = await api('GET', '/backup'); } catch (err) { toast(err.message, 'error'); }
    if (currentView === 'settings') render();
  }

  async function backupAction(body, busyText, okText) {
    backupBusy = busyText;
    render();
    try {
      const r = await api('POST', '/backup/request', body);
      // Not api(): after a restore the old session is gone, and a 401 must end the wait, not loop back to sign-in.
      const last = await waitForBackup(r.requestId, async () => {
        const res = await fetch('/api/backup', { credentials: 'same-origin', cache: 'no-store' });
        if (res.status === 401) return { done: true };
        return res.ok ? (await res.json()).status : null;
      });
      if (body.action === 'restore' && last.ok) {
        toast(okText);
        await sleep(1500);
        backupBusy = '';
        backupInfo = null;
        return boot(); // restored data has its own password
      }
      toast(last.ok ? okText : last.message, last.ok ? undefined : 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
    backupBusy = '';
    await loadBackup();
  }

  /* The printed card. A club that loses its memory card *and* this code has
     lost its backup, which is the one new way encryption can bite — so it is
     generated rather than chosen, shown large, and printable on paper. */
  function printRecoveryCode(code) {
    const sheet = h('div', { id: 'print-code' },
      h('h1', {}, localize`PitchTribe backup recovery code${state && state.settings && state.settings.clubName ? ` — ${state.settings.clubName}` : ''}`),
      h('p', {}, localize`Printed ${new Date().toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}`),
      h('div', { class: 'recovery-code' }, code),
      h('p', {}, translate('Keep this somewhere safe, and not with the USB stick — a thief who takes both has everything.')),
      h('p', {}, translate('If the Raspberry Pi’s memory card ever fails, type this code into the PitchTribe set-up screen to get the club’s content, photos, settings and password back off the backup stick. Without it, and without the old memory card, those backups cannot be read — by anybody, including us.')),
      h('p', {}, translate('You can see this code again at any time: sign in to the dashboard and go to Settings → Backups.')));
    document.body.append(sheet);
    document.body.classList.add('printing-code');
    const tidy = () => { document.body.classList.remove('printing-code'); sheet.remove(); window.removeEventListener('afterprint', tidy); };
    window.addEventListener('afterprint', tidy);
    window.print();
    setTimeout(tidy, 60000); // afterprint is not fired by every browser
  }

  function showRecoveryCode(code, { firstTime = false } = {}) {
    const formatted = code.match(/.{1,4}/g).join('-');
    modal({
      title: firstTime ? 'Write this code down now' : 'Backup recovery code',
      body: h('div', { class: 'stack', style: 'gap:12px' },
        h('p', { class: 'small' }, firstTime
          ? translate('Backups on the USB stick are encrypted from now on. This code is the only way to read them if this Pi’s memory card fails. Print it, or write it down, and keep it away from the stick.')
          : translate('This is the code that unlocks the backups on your USB stick after a memory-card failure. Keep it away from the stick itself.')),
        h('div', { class: 'recovery-code' }, formatted),
        h('p', { class: 'small muted' }, translate('Letters and numbers only — there is no O, I, L or U in it, so nothing can be mistaken for a 0 or a 1.'))),
      footer: (close) => [
        h('button', { class: 'btn', type: 'button', onclick: () => navigator.clipboard?.writeText(formatted).then(() => toast('Copied'), () => toast('Copy failed — write it down instead', 'error')) }, icon('copy'), translate('Copy')),
        h('button', { class: 'btn', type: 'button', onclick: () => printRecoveryCode(formatted) }, translate('Print')),
        h('button', { class: 'btn primary', type: 'button', onclick: close }, firstTime ? translate('I have written it down') : translate('Close')),
      ],
    });
  }

  async function revealRecoveryCode({ firstTime = false } = {}) {
    try {
      const { code } = await api('GET', '/backup/recovery');
      if (!code) return toast('There is no recovery code yet — switch encryption on first.', 'error');
      showRecoveryCode(code, { firstTime });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /** Encryption, for a club that has already chosen a stick. */
  function encryptionRow(cfg, st) {
    const on = Boolean(cfg.encrypt);
    const code = Boolean(st.encryption && st.encryption.recoveryCode);
    const box = h('div', { class: 'stack', style: 'gap:6px;margin-top:4px' });
    append(box, [
      on
        ? h('p', { class: 'small' }, translate('🔒 Backups on this stick are encrypted. A stick that goes missing gives away nothing but the club’s name and when the backups were taken.'))
        : h('p', { class: 'small' }, translate('Backups on this stick are not encrypted. Anyone who picks it up can read the guest Wi-Fi sign-ups, every photo and the dashboard password’s hash, on any computer.')),
      h('div', { class: 'actions' },
        on
          ? h('button', { class: 'btn sm', type: 'button', disabled: !code, onclick: () => revealRecoveryCode() }, translate('Show recovery code'))
          : h('button', { class: 'btn sm primary', type: 'button', onclick: () => turnEncryptionOn() }, translate('Encrypt these backups')),
        on
          ? h('button', { class: 'btn sm ghost', type: 'button', onclick: async () => {
            if (!(await confirmDialog('Stop encrypting backups?', 'The next backup, and every one after it, can be read on any computer by anyone holding the stick. Backups already on the stick stay encrypted.', { confirmLabel: 'Stop encrypting' }))) return;
            backupAction({ action: 'encrypt', on: false }, 'Switching encryption off…', 'Encryption switched off');
          } }, translate('Stop encrypting'))
          : null),
    ]);
    return box;
  }

  async function turnEncryptionOn() {
    const ok = await confirmDialog(
      'Encrypt the backups on this stick?',
      'You will be shown a recovery code to print. If this Pi’s memory card fails, that code is the only way to read the backups — lose both and the backups are gone. Encrypting starts now and takes a few minutes if the club has a lot of video.',
      { confirmLabel: 'Encrypt and show me the code', danger: false }
    );
    if (!ok) return;
    await backupAction({ action: 'encrypt', on: true }, 'Encrypting the backups on the stick…', 'Backups on the stick are encrypted');
    await revealRecoveryCode({ firstTime: true });
  }

  function backupCard() {
    const head = [
      h('h2', {}, translate('Backups')),
      h('p', { class: 'small muted' }, translate('A copy of everything — content, photos and videos, playlists, screens, settings and the password — so a failed memory card is a quick fix, not a fresh start.')),
    ];
    if (!backupInfo) {
      loadBackup();
      return h('div', { class: 'card panel-box stack', style: 'gap:10px' }, ...head, h('p', { class: 'small muted' }, translate('Loading…')));
    }
    const st = backupInfo.status || {};
    const cfg = backupInfo.config;
    const sticks = st.sticks || [];
    const size = (k) => `${fmtBytes(k.free)} free of ${fmtBytes(k.size)}`;
    const usb = [h('h3', { style: 'font-size:1rem;margin-top:6px' }, translate('USB stick'))];

    if (!backupInfo.available) {
      usb.push(h('p', { class: 'small muted' }, translate('USB backups work on a Raspberry Pi with PitchTribe installed. Use “Download backup” below meanwhile.')));
    } else if (backupBusy || st.running) {
      usb.push(h('p', { class: 'small' }, backupBusy || (st.running === 'restore' ? translate('Restoring…') : translate('Backing up…'))));
    } else if (cfg) {
      const stick = sticks.find((k) => k.uuid === cfg.uuid);
      const mine = stick?.backups?.find((b) => b.snapshots.length) || null;
      const name = cfg.label || 'the USB stick';
      usb.push(stick
        ? h('p', { class: 'small' }, localize`Backing up every night to “${name}” (${size(stick)}).`)
        : h('p', { class: 'small', style: 'color:var(--danger)' }, localize`⚠ The backup stick “${name}” isn’t plugged in. Plug it back into the Pi.`));
      if (st.last) {
        usb.push(h('p', { class: 'small', style: st.last.ok ? '' : 'color:var(--danger)' },
          st.last.ok ? localize`Last: ${st.last.message.toLowerCase()} ${fmtWhen(st.last.at)} ✓` : `⚠ ${st.last.message} (${fmtWhen(st.last.at)})`));
      }
      if (mine) usb.push(h('p', { class: 'small muted' }, localize`${mine.snapshots.length} backup${mine.snapshots.length === 1 ? '' : 's'} on the stick — the last 30 are kept.`));
      usb.push(h('div', { class: 'actions' },
        h('button', { class: 'btn sm primary', type: 'button', disabled: !stick, onclick: () => backupAction({ action: 'now' }, 'Backing up now…', 'Backed up to the USB stick') }, translate('Back up now')),
        h('button', { class: 'btn sm', type: 'button', onclick: async () => {
          if (!(await confirmDialog('Stop backing up to this stick?', 'Backups already on it are kept.', { confirmLabel: 'Stop backups', danger: false }))) return;
          backupAction({ action: 'stop' }, 'Switching off…', 'USB backups switched off');
        } }, translate('Stop using this stick'))));
      usb.push(encryptionRow(cfg, st));
    } else if (sticks.length) {
      usb.push(h('p', { class: 'small' }, translate('Choose the stick to back up to. PitchTribe keeps its backups in a folder of their own and leaves everything else on the stick alone.')));
      usb.push(h('p', { class: 'small muted' }, translate('The backups are encrypted, and you will be shown a recovery code to print — a stick in a drawer holds your guest sign-ups, your photos and your password, so it should not be readable by whoever finds it.')));
      for (const k of sticks) {
        usb.push(h('div', { class: 'actions', style: 'align-items:center' },
          h('span', { class: 'small', style: 'flex:1' }, `${k.label || 'USB stick'} · ${size(k)}`),
          h('button', { class: 'btn sm primary', type: 'button', disabled: Boolean(k.error), onclick: async () => {
            await backupAction({ action: 'use', uuid: k.uuid, encrypt: true }, 'Making the first backup…', 'Backups switched on — first backup done');
            await revealRecoveryCode({ firstTime: true });
          } }, translate('Use this stick for backups'))));
      }
    } else {
      usb.push(h('p', { class: 'small muted' }, translate('Plug a USB stick into the Pi and it appears here within a few seconds. Most sticks work as they come (FAT32 or exFAT). 32 GB is plenty for most clubs.')));
      setTimeout(() => { if (currentView === 'settings' && !backupBusy) loadBackup(); }, 6000);
    }

    // Restore from the stick, while signed in (e.g. to undo a big mistake).
    const restorable = sticks.flatMap((k) => (k.backups || []).flatMap((b) => b.snapshots.map((snap) => ({ k, host: b.host, snap }))))
      .sort((x, y) => (x.snap.at < y.snap.at ? 1 : -1));
    if (backupInfo.available && restorable.length && !backupBusy && !st.running) {
      const pick = h('select', {}, restorable.map((o, i) => h('option', { value: String(i) }, `${o.snap.club || o.host} — ${fmtWhen(o.snap.at)}`)));
      usb.push(h('details', { class: 'help' }, h('summary', {}, translate('Restore from the USB stick')),
        h('div', { class: 'stack', style: 'gap:8px;margin-top:8px' },
          h('p', { class: 'small muted' }, translate('Puts everything back as it was at that time, including the password. Changes made since are lost.')),
          pick,
          h('div', {}, h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
            const o = restorable[Number(pick.value)];
            if (!(await confirmDialog(localize`Restore the backup from ${fmtWhen(o.snap.at)}?`, 'Everything changes back to how it was then, and everyone is signed out.', { confirmLabel: 'Restore' }))) return;
            backupAction({ action: 'restore', uuid: o.k.uuid, host: o.host, snapshot: o.snap.id }, 'Restoring… the screens go blank for a moment.', 'Restored — sign in again');
          } }, translate('Restore'))))));
    }

    const fileInput = h('input', { type: 'file', accept: '.gz,.tgz,application/gzip', hidden: true, onchange: async () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      if (!(await confirmDialog(localize`Restore from ${f.name}?`, 'Everything is replaced with what’s in the file, including the password, and everyone is signed out.', { confirmLabel: 'Restore' }))) return;
      try {
        toast('Restoring…');
        await uploadBackup('/backup/restore-file', f);
        toast('Restored — sign in again');
        await sleep(1200);
        boot();
      } catch (err) { toast(err.message, 'error'); }
    } });
    const file = [
      h('h3', { style: 'font-size:1rem;margin-top:10px' }, translate('Backup file')),
      h('p', { class: 'small muted' }, translate('Download everything as one file to keep on the club laptop or shared drive. Big video collections make a big file.')),
      h('div', { class: 'actions' },
        h('a', { class: 'btn sm', href: '/api/backup/download', download: '' }, translate('Download backup')),
        h('button', { class: 'btn sm', type: 'button', onclick: () => fileInput.click() }, translate('Restore from file…')),
        fileInput),
    ];
    return h('div', { class: 'card panel-box stack', style: 'gap:10px' }, ...head, ...usb, ...file);
  }

  function sportsCard() {
    const sp = state.sports;
    const chosen = new Set(sp.leagues);
    const enabled = h('input', { type: 'checkbox', checked: sp.enabled });
    const tz = h('input', { type: 'text', value: sp.timezone, maxlength: 60 });
    const status = new Map(sp.status.map((st) => [st.key, st]));
    const copyBtn = (text) => h('button', { class: 'btn sm', type: 'button', onclick: () => navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed — select the text instead', 'error')) }, icon('copy'), translate('Copy'));
    const sportsBase = `${baseUrl()}/feeds`;

    const form = h('form', {
      class: 'card panel-box form-grid',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          state.sports = await api('PUT', '/settings/sports', { enabled: enabled.checked, leagues: [...chosen], timezone: tz.value });
          render();
          toast(enabled.checked ? 'Sports feeds on — fetching scores now' : 'Sports feeds off');
          if (enabled.checked) setTimeout(async () => { await refresh().catch(() => {}); if (currentView === 'settings') render(); }, 4000);
        } catch (err) { toast(err.message, 'error'); }
      },
    },
      h('h2', {}, translate('Sports feeds')),
      h('p', { class: 'small muted' }, translate('Fixtures, live scores and results from public feeds, for “Live scores” slides. Needs an internet connection.')),
      h('label', { class: 'switch' }, enabled, translate('Fetch sports scores')),
      h('div', { class: 'field' }, translate('Competitions'),
        h('div', { class: 'chips' }, sp.catalog.map((l) => {
          const chip = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(chosen.has(l.key)),
            onclick: () => { chosen.has(l.key) ? chosen.delete(l.key) : chosen.add(l.key); chip.setAttribute('aria-pressed', String(chosen.has(l.key))); } }, l.name);
          return chip;
        }))),
      h('label', { class: 'field' }, translate('Timezone'), tz, h('span', { class: 'hint' }, translate('For kick-off times on the sports display page, e.g. Europe/London.'))),
      sp.running && h('dl', { class: 'kv' }, sp.catalog.filter((l) => status.has(l.key)).map((l) => {
        const st = status.get(l.key);
        return [h('dt', {}, l.name), h('dd', {}, st.error ? `⚠ ${translate(st.error)}` : localize`${st.events} matches${st.live ? ` · ${st.live} live` : ''} · updated ${st.fetchedAt ? ago(Date.parse(st.fetchedAt)) : 'pending'}`)];
      })),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'submit' }, translate('Save')),
        sp.running && h('button', { class: 'btn', type: 'button', onclick: async () => {
          try { state.sports = await api('POST', '/sports/refresh', {}); render(); toast('Scores refreshed'); } catch (err) { toast(err.message, 'error'); }
        } }, icon('refresh'), translate('Refresh now'))),
      sp.running && h('details', { class: 'help' },
        h('summary', {}, translate('Display page, API and AI assistants (MCP)')),
        h('div', { class: 'stack', style: 'margin-top:10px;gap:10px' },
          h('p', {}, translate('A ready-made rotating scores page any screen can open, a JSON API, and an MCP endpoint so AI assistants can read scores and trigger refreshes.')),
          h('div', { class: 'copy-row' }, h('code', {}, `${sportsBase}/display`), copyBtn(`${sportsBase}/display`)),
          h('div', { class: 'copy-row' }, h('code', {}, `${sportsBase}/api/snapshot`), copyBtn(`${sportsBase}/api/snapshot`)),
          h('div', { class: 'copy-row' }, h('code', {}, `${sportsBase}/mcp`), copyBtn(`${sportsBase}/mcp`)),
          h('p', {}, translate('MCP and other POST requests need this bearer token:')),
          h('div', { class: 'copy-row' }, h('code', {}, sp.apiToken), copyBtn(sp.apiToken),
            h('button', { class: 'btn sm', type: 'button', onclick: async () => {
              if (!(await confirmDialog('New token?', 'Anything using the current token will stop working until it is updated.', { confirmLabel: 'Generate', danger: false }))) return;
              try { state.sports = await api('POST', '/settings/sports/token', {}); render(); toast('New token generated'); } catch (err) { toast(err.message, 'error'); }
            } }, icon('refresh'), translate('New'))))));
    return form;
  }

  /* ================================================================= people
     The club's dashboard logins, one record per volunteer, instead of everyone
     sharing a single password. Every rule lives on the server
     (lib/user-model.js) and its refusals are already written for a club
     volunteer, so this page puts them on screen as they arrive rather than
     inventing its own wording.

     Two things it has to get right. A generated starter password exists only in
     the response that created it — the server keeps a hash and nothing else —
     so if this page does not show it there and then, nobody can ever recover
     it. And the controls that would lock the person clicking out of this very
     page are greyed out here as well as refused by the server, because finding
     out by being locked out is too late to be told. */
  let people = null; // GET /api/users
  let peopleError = null; // why the list could not be read
  let peopleLoading = false;

  const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
  const ROLE_BLURB = {
    owner: 'Runs the club’s screens: content, settings, and who can sign in.',
    editor: 'Puts things on the screens. Cannot change settings or this page.',
    viewer: 'Can look at the dashboard and change nothing.',
  };

  const personName = (u) => u.name || u.username;
  /* Who the dashboard is signed in as. Null while the club still shares one
     password, which is nobody in particular and may do everything. */
  const isSelf = (u) => Boolean(people && people.me && people.me.id === u.id);

  async function loadPeople() {
    if (peopleLoading) return;
    peopleLoading = true;
    try {
      people = await api('GET', '/users');
      peopleError = null;
    } catch (err) {
      people = null;
      peopleError = err.message;
    }
    peopleLoading = false;
    if (currentView === 'people') render();
  }

  function viewPeople() {
    const head = h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, translate('People')),
        h('p', {}, translate('Who can sign in to this dashboard. Give each volunteer their own login and one who moves on can be removed without the rest of the club learning a new password.'))),
      people && h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: loadPeople }, icon('refresh'), translate('Refresh')),
        h('button', { class: 'btn primary', type: 'button', onclick: () => editPerson({}) }, icon('plus'), translate('Add person'))));

    if (!people) {
      if (!peopleError) {
        loadPeople();
        return shell('people', head, h('div', { class: 'card empty' }, translate('Loading…')));
      }
      // The server says which "no" this is — not an owner, or simply offline —
      // and says it better than a guess from the status code would.
      return shell('people', head, h('div', { class: 'card empty' },
        h('h2', {}, translate('Can’t show the people list')),
        h('p', {}, peopleError),
        h('div', { class: 'actions', style: 'justify-content:center;margin-top:14px' },
          h('button', { class: 'btn', type: 'button', onclick: () => { peopleError = null; render(); loadPeople(); } }, icon('refresh'), translate('Try again')))));
    }

    const rows = people.users.map((u) => {
      const self = isSelf(u);
      const status = !u.active
        ? h('span', { class: 'badge expired' }, translate('Suspended'))
        : u.mustChangePassword
          ? h('span', { class: 'badge off-hours' }, translate('New password due'))
          : h('span', { class: 'badge live' }, translate('Active'));
      return h('tr', { class: u.active ? null : 'suspended' },
        h('td', {}, h('div', { class: 'people-who' },
          h('div', { class: 'people-name' }, h('strong', {}, personName(u)), self && h('span', { class: 'badge' }, translate('You'))),
          h('span', { class: 'people-sub' }, u.username, u.email ? ` · ${u.email}` : ''))),
        h('td', {}, h('span', { class: `badge role-${u.role}` }, translate(ROLE_LABEL[u.role] || u.role))),
        h('td', {}, status),
        h('td', { class: 'people-when' }, u.lastLoginAt ? ago(Date.parse(u.lastLoginAt)) : translate('never signed in')),
        h('td', {}, h('div', { class: 'actions' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => editPerson(u) }, translate('Edit')),
          h('button', { class: 'btn sm', type: 'button', title: localize`Give ${personName(u)} a new password`, onclick: () => resetPersonPassword(u) }, icon('key'), translate('Password')),
          h('button', {
            class: 'btn sm danger icon', type: 'button', disabled: self,
            'aria-label': localize`Remove ${personName(u)}`,
            title: self ? translate('You cannot remove your own account') : localize`Remove ${personName(u)}`,
            onclick: () => removePerson(u),
          }, icon('trash')))));
    });

    const roles = h('details', { class: 'help' },
      h('summary', {}, translate('What the roles can do')),
      h('dl', { class: 'kv', style: 'margin-top:10px' },
        (people.roles || []).map((r) => [h('dt', {}, translate(ROLE_LABEL[r] || r)), h('dd', { class: 'wrap' }, translate(ROLE_BLURB[r] || ''))])),
      h('p', { class: 'small', style: 'margin-top:10px' }, translate('There is always at least one owner: PitchTribe will not let the last one be removed, suspended or demoted.')));

    const list = people.users.length
      ? h('div', { class: 'card panel-box stack', style: 'gap:14px' },
        h('table', { class: 'people' },
          h('thead', {}, h('tr', {},
            h('th', {}, translate('Person')),
            h('th', {}, translate('Role')),
            h('th', {}, translate('Status')),
            h('th', {}, translate('Last signed in')),
            h('th', {}, h('span', { class: 'sr-only' }, translate('Actions'))))),
          h('tbody', {}, rows)),
        roles)
      : h('div', { class: 'card empty' },
        h('h2', {}, translate('Nobody has their own login yet')),
        h('p', {}, translate('Everyone who looks after the screens shares the one dashboard password. Add a person to give them a login of their own.')),
        h('div', { class: 'actions', style: 'justify-content:center;margin-top:14px' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => editPerson({}) }, icon('plus'), translate('Add the first person'))));

    return shell('people', head, h('div', { class: 'stack', style: 'max-width:820px' }, list));
  }

  /** Add somebody, or change the details of somebody already on the list. */
  function editPerson(user) {
    const isNew = !user.id;
    const self = !isNew && isSelf(user);
    const err = h('p', { class: 'error-text', role: 'alert' });

    const username = h('input', {
      type: 'text', value: user.username || '', maxlength: 32, minlength: 3, required: true,
      autocomplete: 'off', autocapitalize: 'none', spellcheck: false,
      pattern: '[a-z0-9][a-z0-9._-]{2,31}', placeholder: translate('e.g. jane.doe'),
    });
    const name = h('input', { type: 'text', value: user.name || '', maxlength: 80, placeholder: translate('e.g. Jane Doe') });
    const email = h('input', { type: 'email', value: user.email || '', maxlength: 200, autocomplete: 'off', placeholder: translate('e.g. jane@riversidefc.example') });
    const role = h('select', { disabled: self }, (people.roles || []).map((r) =>
      h('option', { value: r, selected: (user.role || 'editor') === r }, translate(ROLE_LABEL[r] || r))));
    const active = h('input', { type: 'checkbox', checked: user.active !== false, disabled: self });
    const password = isNew
      ? h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 200, placeholder: translate('Leave blank to make one up') })
      : null;

    const roleHint = h('span', { class: 'hint' });
    const syncRoleHint = () => {
      roleHint.textContent = self
        ? translate('You cannot change your own role — ask another owner to do it.')
        : translate(ROLE_BLURB[role.value] || '');
    };
    role.addEventListener('change', syncRoleHint);
    syncRoleHint();

    const body = h('form', { class: 'form-grid', onsubmit: (e) => { e.preventDefault(); save(); } },
      h('div', { class: 'row-2' },
        h('label', { class: 'field' }, translate('Username'), username,
          h('span', { class: 'hint' }, translate('What they type to sign in: small letters, numbers, dots, dashes and underscores.'))),
        h('label', { class: 'field' }, translate('Full name'), name,
          h('span', { class: 'hint' }, translate('Shown on this page. Optional.')))),
      h('label', { class: 'field' }, translate('Email'), email,
        h('span', { class: 'hint' }, translate('Optional, and only used to tell one volunteer from another.'))),
      h('label', { class: 'field' }, translate('Role'), role, roleHint),
      h('div', { class: 'field' }, translate('Account'),
        h('label', { class: 'switch' }, active, translate('Can sign in')),
        h('span', { class: 'hint' }, self
          ? translate('You cannot switch off your own account.')
          : translate('Switch this off to keep the record but stop them signing in — they lose the dashboard on their next click.'))),
      password && h('label', { class: 'field' }, translate('Starter password'), password,
        h('span', { class: 'hint' }, translate('At least 8 characters. Leave it blank and PitchTribe makes one up for you to read out once, and asks them to choose their own the first time they sign in.'))),
      err);

    const submit = h('button', { class: 'btn primary', type: 'button', onclick: () => body.requestSubmit() }, isNew ? translate('Add person') : translate('Save'));
    const m = modal({
      title: isNew ? 'Add a person' : localize`Edit ${personName(user)}`,
      body,
      footer: (close) => [h('button', { class: 'btn', type: 'button', onclick: close }, translate('Cancel')), submit],
    });
    setTimeout(() => username.focus(), 30);

    async function save() {
      const payload = {
        username: username.value.trim().toLowerCase(),
        name: name.value.trim(),
        email: email.value.trim(),
        role: role.value,
        active: active.checked,
      };
      if (password && password.value) payload.password = password.value;
      /* The server refuses both of these for your own account. Sending them
         unchanged would turn "I fixed my email address" into a refusal. */
      if (self) { delete payload.role; delete payload.active; }
      submit.disabled = true;
      try {
        const res = isNew
          ? await api('POST', '/users', payload)
          : await api('PATCH', `/users/${encodeURIComponent(user.id)}`, payload);
        m.close();
        await loadPeople();
        if (res.temporaryPassword) showStarterPassword(res.user, res.temporaryPassword);
        else toast(isNew ? localize`${personName(res.user)} can now sign in` : 'Saved');
      } catch (e) {
        err.textContent = e.message;
        submit.disabled = false;
      }
    }
  }

  /* A made-up password is in this one response and nowhere else: the server
     stored a hash of it and threw the rest away. Dismiss this without writing
     it down and the only way back is another reset — so say so, and make it
     big enough to read out across a clubhouse. */
  function showStarterPassword(user, secret) {
    modal({
      title: 'Read this password out now',
      body: h('div', { class: 'stack', style: 'gap:12px' },
        h('p', { class: 'small' }, h('strong', {}, personName(user)), translate(' signs in with the username '), h('code', {}, user.username), translate(' and this password:')),
        h('div', { class: 'recovery-code' }, secret),
        h('p', { class: 'small muted' }, translate('This is the only time it is shown — PitchTribe keeps no copy of it. They are asked to choose their own password the first time they sign in. If this one gets lost before then, use '), h('strong', {}, translate('Password')), translate(' on the people list to make another.'))),
      footer: (close) => [
        h('button', { class: 'btn', type: 'button', onclick: () => navigator.clipboard?.writeText(secret).then(() => toast('Copied'), () => toast('Copy failed — read it off the screen instead', 'error')) }, icon('copy'), translate('Copy')),
        h('button', { class: 'btn primary', type: 'button', onclick: close }, translate('Done')),
      ],
    });
  }

  /** Give somebody a new password — the owner's own password first. */
  function resetPersonPassword(user) {
    const err = h('p', { class: 'error-text', role: 'alert' });
    const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 200, placeholder: translate('Leave blank to make one up') });
    const current = h('input', { type: 'password', autocomplete: 'current-password', required: true });

    const body = h('form', { class: 'form-grid', onsubmit: (e) => { e.preventDefault(); go(); } },
      h('p', { class: 'small' }, translate('A new password for '), h('strong', {}, personName(user)), ' (', h('code', {}, user.username), ').'),
      h('label', { class: 'field' }, translate('New password'), next,
        h('span', { class: 'hint' }, translate('At least 8 characters. Leave it blank and PitchTribe makes one up for you to read out once, and asks them to choose their own next time they sign in. One they typed themselves here is theirs to keep.'))),
      h('label', { class: 'field' }, translate('Your own dashboard password'), current,
        h('span', { class: 'hint' }, translate('Confirms it is you doing this, and not somebody who found the dashboard left open.'))),
      err);

    const submit = h('button', { class: 'btn primary', type: 'button', onclick: () => body.requestSubmit() }, translate('Set password'));
    const m = modal({
      title: 'New password',
      body,
      footer: (close) => [h('button', { class: 'btn', type: 'button', onclick: close }, translate('Cancel')), submit],
    });
    setTimeout(() => next.focus(), 30);

    async function go() {
      submit.disabled = true;
      try {
        const res = await api('POST', `/users/${encodeURIComponent(user.id)}/password-reset`, {
          currentPassword: current.value,
          ...(next.value ? { password: next.value } : {}),
        });
        m.close();
        await loadPeople();
        if (res.temporaryPassword) showStarterPassword(res.user, res.temporaryPassword);
        else toast(localize`${personName(res.user)} has a new password`);
      } catch (e) {
        err.textContent = e.message;
        current.value = '';
        submit.disabled = false;
      }
    }
  }

  async function removePerson(user) {
    const who = personName(user);
    const ok = await confirmDialog('Remove this person?',
      `${who} will not be able to sign in to the dashboard again. Nothing on the screens changes.`,
      { confirmLabel: 'Remove' });
    if (!ok) return;
    try {
      await api('DELETE', `/users/${encodeURIComponent(user.id)}`);
      toast(localize`${who} removed`);
      await loadPeople();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // ================================================================ router
  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    return { view: parts[0] || 'content', id: parts[1] ? decodeURIComponent(parts[1]) : null };
  }

  function render() {
    if (!state) return;
    const focusedInApp = appEl.contains(document.activeElement);
    const r = parseRoute();
    currentView = r.view;
    if (r.view !== 'playlists' || !r.id) draft = null;
    if (r.view !== 'wifi') portal = null; // fresh stats each visit
    if (r.view !== 'people') { people = null; peopleError = null; } // ditto: who signed in when
    let nodes;
    if (r.view === 'playlists' && r.id) nodes = viewPlaylist(r.id);
    else if (r.view === 'playlists') nodes = viewPlaylists();
    else if (r.view === 'screens') nodes = viewScreens();
    else if (r.view === 'settings') nodes = viewSettings();
    else if (r.view === 'wifi') nodes = viewWifi();
    else if (r.view === 'people') nodes = viewPeople();
    else nodes = viewContent();
    const y = window.scrollY;
    appEl.replaceChildren(...nodes);
    window.scrollTo(0, y);
    // Replacing a view removes its focused control. Give keyboard users a
    // predictable landing place after an action that rebuilds the page.
    if (focusedInApp && document.activeElement === document.body) {
      const heading = appEl.querySelector('h1');
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
  }

  let lastHash = location.hash;
  window.addEventListener('hashchange', () => {
    if (dirty && !confirm(translate('You have unsaved playlist changes. Leave without saving?'))) {
      history.replaceState(null, '', lastHash);
      return;
    }
    if (location.hash !== lastHash) window.scrollTo(0, 0);
    dirty = false;
    lastHash = location.hash;
    render();
    const heading = appEl.querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });

  // Keep screen status fresh without disturbing someone mid-edit.
  setInterval(async () => {
    if (!state || document.hidden) return;
    if (currentView !== 'screens') return;
    const active = document.activeElement;
    // Keep the screen status fresh while someone is using a control, without
    // replacing the focused element or the rest of the page.
    const focusedInApp = active && appEl.contains(active);
    if (document.querySelector('dialog[open]')) return;
    try {
      const previous = new Map(state.screens.map((screen) => [screen.id, screen.online]));
      await refresh();
      const changed = state.screens.filter((screen) => previous.has(screen.id) && previous.get(screen.id) !== screen.online);
      if (changed.length) document.getElementById('screen-status').textContent = changed.map((screen) => screen.online
        ? localize`${screen.name} is online` : localize`${screen.name} is offline`).join('. ');
      if (focusedInApp) {
        for (const card of appEl.querySelectorAll('.screen[data-screen-id]')) {
          const screen = state.screens.find((item) => item.id === card.dataset.screenId);
          if (!screen) continue;
          const dot = card.querySelector('.screen-head .dot');
          if (dot) { dot.classList.toggle('on', Boolean(screen.online)); dot.title = screen.online ? translate('Online') : translate('Offline'); }
          const status = card.querySelector('[data-screen-status]');
          if (status) status.textContent = screen.online ? translate('Online') : localize`Offline · last seen ${ago(screen.lastSeen)}`;
        }
        return;
      }
      render();
    } catch { /* offline: try again later */ }
  }, 10_000);

  async function boot() {
    state = null;
    draft = null;
    dirty = false;
    try {
      const status = await fetch('/api/auth/status', { credentials: 'same-origin' }).then((r) => r.json());
      if (!status.authenticated) return renderAuth(status);
      await refresh();
      if (!location.hash) history.replaceState(null, '', '#/content');
      lastHash = location.hash;
      render();
    } catch (err) {
      appEl.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'card' }, h('h1', {}, translate('Can’t reach PitchTribe')), h('p', { class: 'muted' }, err.message), h('button', { class: 'btn primary', type: 'button', onclick: boot }, translate('Try again')))));
    }
  }

  boot();
})();
