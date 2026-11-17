// The clubhouse wall, as one self-contained HTML page.
//
// Design law, non-negotiable: everything must survive a two-second glance from six metres
// across a loud room. One idea per slide, no tables beyond five rows, nothing small except
// the line that says when the data was read.
//
// The page carries no external assets — no fonts, no CDN, no icons — because the normal
// condition in a village pavilion is no internet. It keeps its own hours, counts down to
// Saturday on its own clock, and when it cannot reach the server it says so in a sentence
// a volunteer can act on. It never shows a stack trace, a blank screen or a browser error
// page.
import {
  WEEKDAYS, DAY_KEYS, zoneParts, toMinutes, isOpen, nextOpenWords, daysToSaturday, countdownWords,
  longDate,
} from './clubhouse.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DASH = '–'; // en dash: a score is 3–2, not 3-2
const score = (n) => (n === null || n === undefined ? '?' : esc(n));
const where = (homeAway) => (homeAway === 'home' ? 'at home' : 'away');

/** The hours and the countdown are the card's own job, so the browser gets the real
    functions rather than a second implementation that can drift from this one. */
const CLIENT_RULES = `
const WEEKDAYS = ${JSON.stringify(WEEKDAYS)};
const DAY_KEYS = ${JSON.stringify(DAY_KEYS)};
${zoneParts}
${toMinutes}
${isOpen}
${nextOpenWords}
${daysToSaturday}
${countdownWords}
`;

function eyebrow(parts) {
  const text = parts.filter(Boolean).join(' · ');
  return text ? `<p class="eyebrow">${esc(text)}</p>` : '';
}

function slideBody(s) {
  switch (s.kind) {
    case 'result':
      return `${eyebrow([s.team, s.competition])}
        <p class="date">${esc(s.date)}</p>
        <p class="big score ${esc(s.mark ?? '')}">${score(s.ourScore)}${DASH}${score(s.theirScore)}</p>
        <p class="line">v ${esc(s.them)}, ${esc(where(s.homeAway))}</p>`;

    // The honest placeholder. A feature, not a gap: the league secretary is a volunteer too.
    case 'awaiting':
      return `${eyebrow([s.team, s.competition])}
        <p class="date">${esc(s.date)}</p>
        <p class="big words">Result to follow</p>
        <p class="line">v ${esc(s.them)}, ${esc(where(s.homeAway))}</p>`;

    // The league's own wording, shown as written — "Postponed — pitch unplayable".
    case 'calledoff':
      return `${eyebrow([s.team, s.competition])}
        <p class="date">${esc(s.date)}</p>
        <p class="big words">${esc(s.statusText)}</p>
        <p class="line">v ${esc(s.them)}, ${esc(where(s.homeAway))}</p>`;

    case 'next':
      return `${eyebrow(['Next up', s.team, s.competition])}
        <p class="big words">${esc(s.them)}</p>
        <p class="line strong">${esc(s.date)}${s.kickoff ? ` · ${esc(s.kickoff)}` : ''}</p>
        <p class="line">${s.homeAway === 'home' ? 'At home' : `Away${s.venue ? `, ${esc(s.venue)}` : ''}`}</p>`;

    case 'form':
      return `${eyebrow([s.team, 'Last five'])}
        <ul class="form">${s.marks.map((m) => `<li class="${esc(m ?? '')}">${esc(m ?? '?')}</li>`).join('')}</ul>`;

    case 'table':
      return `${eyebrow([s.name, s.updatedLabel ? `as at ${s.updatedLabel}` : ''])}
        <ul class="table">${s.rows.map((r) => `<li${r.us ? ' class="us"' : ''}>
          <span class="pos">${esc(r.position)}</span>
          <span class="club">${esc(r.team)}</span>
          <span class="pld">${esc(r.played ?? '')}</span>
          <span class="pts">${esc(r.points ?? '')}</span>
        </li>`).join('')}</ul>
        <p class="legend">Position · Played · Points${s.rows.some((r) => r.note) ? ` · ${esc(s.rows.find((r) => r.note).note)}` : ''}</p>`;

    case 'division':
      return `${eyebrow(['Around the', s.name])}
        <ul class="others">${s.results.map((r) => `<li>
          <span class="t">${esc(r.home)}</span>
          <span class="s">${score(r.homeScore)}${DASH}${score(r.awayScore)}</span>
          <span class="t away">${esc(r.away)}</span>
        </li>`).join('')}</ul>`;

    case 'identity':
      return `${s.badge ? '<img class="badge" src="badge" alt="" onerror="this.remove()">' : ''}
        <p class="big words club-name">${esc(s.name)}</p>
        ${s.strapline ? `<p class="line">${esc(s.strapline)}</p>` : ''}`;

    case 'rhythm':
      return `${eyebrow(['This week'])}
        <ul class="rhythm">${s.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;

    case 'countdown':
      return `<p class="big count" data-countdown-lead>${esc(s.lead)}</p>
        <p class="line strong" data-countdown-tail>${esc(s.tail)}</p>`;

    case 'photo':
      return `<img class="photo" src="photos/${encodeURIComponent(s.file)}" alt="" onerror="this.closest('.slide').dataset.broken='1'">`;

    default:
      return '';
  }
}

/**
 * @param wall  buildClubhouse() result
 * @param opts  { rotateSeconds, live }
 */
export function renderClubhouse(wall, opts = {}) {
  const rotate = Math.max(5, Number(opts.rotateSeconds) || 12);
  const slides = wall.slides.length
    ? wall.slides
    // Never a blank screen: an empty pool and an empty league still show the club's name.
    : [{ kind: 'identity', name: wall.title, strapline: '', badge: '' }];

  const read = wall.source.fetchedAt ? longDate(wall.source.fetchedAt, wall.tz) : '';
  const footer = [wall.credit, read ? `Results read ${read}` : ''].filter(Boolean).join(' · ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(wall.title)}</title>
<style>
  :root{
    --club:${esc(wall.colours.primary)};
    --ink:${esc(wall.colours.ink)};
    --accent:${esc(wall.colours.accent)};
    --win:#2fd37a;--draw:#d9dde6;--loss:#ff6a6a;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;overflow:hidden;background:#000;color:var(--ink);
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
  /* Outside opening hours the card blacks out its own picture. The television is never
     touched: no CEC, no handshake, nothing to go wrong on the next club's set. */
  body.closed .wall,body.closed .notice{display:none}
  /* …but not to absolutely nothing. A card blacked out and a card that never booted
     look identical on a dark television, and the first one flashed for a building was
     reported as "it didn't load" — on a Tuesday, for a club that opens on Saturdays.
     So a closed card keeps one dim line saying whose it is and when it next opens:
     walk up to the set and it tells you it is alive, while a committee meeting six
     metres away still gets a dark screen. It drifts because a static glyph left on a
     panel for 160 hours a week is how a borrowed television gets damaged. */
  .standby{position:fixed;left:0;right:0;top:46vh;display:none;text-align:center;
    font-size:3.4vh;font-weight:600;letter-spacing:.08em;color:#54545c;
    animation:drift 1800s linear infinite}
  body.closed .standby{display:block}
  @keyframes drift{
    0%{transform:translate(-17vw,-31vh)}  25%{transform:translate(19vw,-11vh)}
    50%{transform:translate(15vw,27vh)}   75%{transform:translate(-19vw,9vh)}
    100%{transform:translate(-17vw,-31vh)}}
  @media (prefers-reduced-motion:reduce){.standby{animation:none}}
  .wall{position:fixed;inset:0;background:var(--club)}
  .slide{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
    justify-content:center;text-align:center;padding:6vh 6vw;gap:1.6vh;
    opacity:0;transition:opacity .7s ease}
  .slide.on{opacity:1}
  .slide[data-broken]{display:none}
  /* Every size below is measured, not chosen by eye: src/legibility.js works out what
     each one comes to in arcminutes of cap height on a 43-inch screen at six metres, and
     test/legibility.test.js fails the build if any of them drops under its floor.
     Run scripts/six-metre.js to print the whole table. */
  .eyebrow{font-size:5.8vh;letter-spacing:.14em;text-transform:uppercase;opacity:.75;font-weight:600}
  .date{font-size:6.4vh;font-weight:600;opacity:.95}
  .big{font-weight:800;line-height:.95;letter-spacing:-.01em}
  .score{font-size:30vh}
  .score.W{color:var(--win)}
  .score.L{color:var(--loss)}
  .words{font-size:12vh;max-width:88vw}
  .club-name{font-size:13vh}
  .count{font-size:34vh;color:var(--accent)}
  .line{font-size:6vh;opacity:.95;max-width:88vw}
  .line.strong{font-weight:700}
  .badge{height:34vh;max-width:60vw;object-fit:contain}
  .photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
  ul{list-style:none;width:100%}
  .form{display:flex;gap:2.4vw;justify-content:center}
  .form li{width:17vh;height:17vh;border-radius:2.5vh;display:flex;align-items:center;justify-content:center;
    font-size:12vh;font-weight:800;color:#06121f;background:var(--draw)}
  .form li.W{background:var(--win)}
  .form li.L{background:var(--loss)}
  .table li{display:grid;grid-template-columns:3.2em 1fr 3.4em 4em;gap:2vw;align-items:center;
    font-size:8vh;font-weight:600;padding:.7vh 2vw;border-radius:1.6vh}
  .table li.us{background:rgba(255,255,255,.18);font-weight:800}
  .table .pos{opacity:.7;text-align:right}
  .table .club{text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .table .pld{opacity:.7;text-align:right}
  .table .pts{text-align:right;color:var(--accent);font-weight:800}
  .legend{font-size:2.6vh;letter-spacing:.1em;text-transform:uppercase;opacity:.6;margin-top:1.5vh}
  .others li{display:grid;grid-template-columns:1fr auto 1fr;gap:2vw;align-items:center;
    font-size:8vh;font-weight:600;padding:1vh 0}
  .others .t{text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .others .t.away{text-align:left}
  .others .s{font-weight:800;color:var(--accent)}
  .rhythm li{font-size:8vh;font-weight:600;padding:1vh 0}
  footer{position:fixed;left:0;right:0;bottom:0;padding:1.4vh 3vw;font-size:2.4vh;
    letter-spacing:.06em;opacity:.65;text-align:center;
    background:linear-gradient(to top,rgba(0,0,0,.45),transparent)}
  /* Shown only after the card has failed to reach its own server for a few minutes:
     one sentence, in words a volunteer can act on, with the age of the data. */
  .notice{position:fixed;left:0;right:0;top:0;padding:1.8vh 3vw;font-size:4.8vh;font-weight:700;
    background:#1d1d1f;color:#ffd34d;text-align:center;display:none}
  .notice.show{display:block}
</style>
</head>
<body>
<div class="wall">
  ${slides.map((s) => `<section class="slide ${esc(s.kind)}">${slideBody(s)}</section>`).join('\n  ')}
  ${footer ? `<footer>${esc(footer)}</footer>` : ''}
</div>
<p class="notice" id="notice"></p>
<p class="standby" id="standby"></p>
<script>
(() => {
  'use strict';
${CLIENT_RULES}
  const TZ = ${JSON.stringify(wall.tz)};
  const HOURS = ${JSON.stringify(wall.hours)};
  const LAST_READ = ${JSON.stringify(wall.source.fetchedAt)};

  const slides = [...document.querySelectorAll('.slide')];
  const notice = document.getElementById('notice');
  const standby = document.getElementById('standby');
  const CLUB = ${JSON.stringify(wall.title)};

  // Pick up where the last page left off, so a reload is not always slide one.
  let i = 0;
  try { i = Number(sessionStorage.getItem('pt-wall')) % slides.length || 0; } catch (e) {}
  const show = () => {
    slides.forEach((s, n) => s.classList.toggle('on', n === i));
    try { sessionStorage.setItem('pt-wall', String(i)); } catch (e) {}
  };
  show();
  if (slides.length > 1) {
    setInterval(() => {
      i = (i + 1) % slides.length;
      // A photograph that failed to load is hidden, so step over it rather than
      // showing an empty slide for twelve seconds.
      for (let guard = 0; guard < slides.length && slides[i].dataset.broken; guard += 1) {
        i = (i + 1) % slides.length;
      }
      show();
    }, ${rotate * 1000});
  }

  // Opening hours, kept by the card. Checked often enough that closing time is not a
  // minute late, and cheap enough to run forever.
  const hours = () => {
    const shut = HOURS && !isOpen(HOURS, new Date(), TZ);
    document.body.classList.toggle('closed', shut);
    // Recomputed each time rather than written once at render: a card is not reloaded
    // for days, so "opens tomorrow at 12:00" would be a lie by the following evening.
    if (shut && standby) {
      const next = nextOpenWords(HOURS, new Date(), TZ);
      standby.textContent = [CLUB, 'closed', next ? 'opens ' + next : null]
        .filter(Boolean).join(' \\u00b7 ');
    }
  };
  hours();
  setInterval(hours, 20000);

  // The countdown's face changes every day because the date does — no reload needed.
  const lead = document.querySelector('[data-countdown-lead]');
  const tail = document.querySelector('[data-countdown-tail]');
  const countdown = () => {
    if (!lead || !tail) return;
    const words = countdownWords(daysToSaturday(new Date(), TZ));
    lead.textContent = words.lead;
    tail.textContent = words.tail;
  };
  countdown();
  setInterval(countdown, 60000);

  // Is the card's own server there? Three misses (about three minutes) before we say
  // anything, because one dropped request is not an outage worth a message on the wall.
  let misses = 0;
  const age = () => {
    if (!LAST_READ) return '';
    const days = Math.floor((Date.now() - Date.parse(LAST_READ)) / 86400000);
    if (!Number.isFinite(days)) return '';
    if (days <= 0) return ' Showing today\\u2019s data.';
    if (days === 1) return ' Showing yesterday\\u2019s data.';
    return ' Showing data from ' + days + ' days ago.';
  };
  const health = () => fetch('api/health', { cache: 'no-store' }).then((r) => r.ok);
  const check = async () => {
    let ok = false;
    try { ok = await health(); } catch (e) { ok = false; }
    misses = ok ? 0 : misses + 1;
    if (misses >= 3) {
      notice.textContent = 'No internet connection \\u2014 unplug the white cable, wait ten seconds, plug it back in.' + age();
      notice.classList.add('show');
    } else if (ok) {
      notice.classList.remove('show');
    }
    return ok;
  };
  check();
  setInterval(check, 60000);

  // Only ever reload when the server answers: a reload into a dead server is a browser
  // error page on the clubhouse wall, which is worse than yesterday's table.
  const reloadIfServed = async () => { if (await check()) location.reload(); };
  ${opts.live === false ? '' : `if ('EventSource' in window) {
    const es = new EventSource('api/stream');
    es.addEventListener('update', reloadIfServed);
  }
  // Watchdog: a fresh page every half hour picks up new photographs and recovers from
  // anything that has quietly wedged in this one.
  setInterval(reloadIfServed, 1800000);`}
})();
</script>
</body>
</html>`;
}
