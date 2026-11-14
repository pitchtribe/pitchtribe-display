// The six-metre test, measured instead of asserted.
//
// The brief's one non-negotiable design law is that everything survives a two-second
// glance from six metres across a loud room — and that it is "photographed and checked,
// not asserted". A photograph needs a television and a camera. The arithmetic does not,
// and it catches the failure a photograph catches: text that is too small for the room.
//
// This file measures the real page. It reads the stylesheet the renderer ships, works out
// how big each piece of text actually is on a given screen at a given distance, and says
// which tier it clears. It is not a substitute for the photograph — a photograph also
// catches contrast, glare and reflections, which no arithmetic here can see. It is the
// part that can be checked on every commit, so the photograph is a confirmation rather
// than a discovery.
//
// How the numbers work:
//   · A 16:9 screen's height is 0.4903 of its diagonal.
//   · Font size is declared in vh, so 1vh is a hundredth of that height.
//   · Capital-letter height is about 0.70 of the font size in the system sans faces this
//     page asks for (Roboto, Helvetica, Arial, Segoe UI). Cap height — not font size — is
//     what the eye resolves, so every figure below is cap height.
//   · Angular size in arcminutes is what legibility actually depends on; a 43-inch screen
//     at four metres and a 65-inch screen at six are the same reading task.

const HEIGHT_PER_DIAGONAL = 9 / Math.sqrt(16 * 16 + 9 * 9); // 0.49029 for 16:9
const MM_PER_INCH = 25.4;
const CAP_PER_EM = 0.70;
const RAD_TO_ARCMIN = (180 / Math.PI) * 60;

/**
 * The two thresholds, in arcminutes of cap height.
 *
 * Normal acuity resolves detail at about 1 arcminute, which puts the bare threshold of
 * letter recognition near 5. Signage practice is far more generous, because reading is
 * not detection: the familiar trade rule of one inch of letter height per ten feet of
 * distance works out at 29 arcminutes for comfortable reading, and its outer limit of one
 * inch per twenty-five feet at 12. Those two numbers are the tiers below.
 */
export const GLANCE_ARCMIN = 25; // the slide's one idea, read in two seconds, at an angle
export const LEGIBLE_ARCMIN = 12; // a fact you need, read with a deliberate look

/** A plain clubhouse television, and the distance the brief names. */
export const BASELINE = { diagonalInches: 43, distanceMetres: 6 };

/**
 * What each piece of text on the wall is for. This map is the point of the whole file:
 * a class that isn't listed is a measurement failure rather than a pass, so new small
 * text cannot arrive on the wall later without someone deciding which tier it belongs in.
 *
 *   idea     — the one thing the slide says. Must clear GLANCE_ARCMIN.
 *   fact     — information the room relies on, chiefly the date (trust rule 1) and which
 *              of the club's sides played. Must clear LEGIBLE_ARCMIN.
 *   fine     — provenance. Deliberately the smallest thing on the wall; no floor.
 */
export const ROLES = {
  score: 'idea',
  words: 'idea',
  'club-name': 'idea',
  count: 'idea',
  'form li': 'idea',
  'table li': 'idea',
  'others li': 'idea',
  'rhythm li': 'idea',
  date: 'fact',
  line: 'fact',
  eyebrow: 'fact',
  notice: 'fact',
  legend: 'fine',
  footer: 'fine',
};

/**
 * Measured exceptions, each with a reason. An exception is a decision someone made with
 * the number in front of them; silence is not.
 */
export const EXCEPTIONS = {
  // The three list-shaped slides. The brief asks for a five-row table and for everyone
  // else's results, and it also says no small text — those two wishes do not both fit on
  // a 43-inch screen at six metres, so this is where the tension gets resolved out loud.
  //
  // What a glance gets from these slides is not a row of text: it is the shape. Our row
  // is the lit one, so "third" arrives as a position on the screen rather than as
  // reading. The numbers behind it are a second look, at the 'fact' floor. Both are
  // measured below, and `node scripts/six-metre.js` prints the screen size at which each
  // of them reaches the glance tier too — on a 65-inch set they all do.
  'table li': {
    floorArcmin: LEGIBLE_ARCMIN,
    why: 'The lit row is the glance; the position and points behind it are a second look. '
      + 'Five rows at glance size would need a 78-inch screen or an overflowing slide.',
  },
  'others li': {
    floorArcmin: LEGIBLE_ARCMIN,
    why: "Four of the division's results at a time. The glance says \"other people played\"; "
      + 'the scores are what the bar then argues about, which is a look, not a glance.',
  },
  'rhythm li': {
    floorArcmin: LEGIBLE_ARCMIN,
    why: 'Training nights and bar hours are the one slide nobody needs in two seconds — '
      + 'it is the slide you read because you are already waiting at the bar.',
  },
  notice: {
    floorArcmin: 10,
    why: "The outage banner shares the screen with a slide rather than replacing it, and "
      + 'the thing it asks for happens at the router, not at six metres. Sized to be read '
      + 'from about four and a half metres and to stay within two lines.',
  },
};

export const screenHeightMm = (diagonalInches) => diagonalInches * MM_PER_INCH * HEIGHT_PER_DIAGONAL;

/** Cap height in millimetres of `vh` units of type on a screen of that diagonal. */
export const capHeightMm = (vh, diagonalInches) => (vh / 100) * screenHeightMm(diagonalInches) * CAP_PER_EM;

/** Angular cap height in arcminutes. The only number that matters. */
export function arcminutes(vh, { diagonalInches, distanceMetres } = BASELINE) {
  const cap = capHeightMm(vh, diagonalInches);
  return 2 * Math.atan(cap / (2 * distanceMetres * 1000)) * RAD_TO_ARCMIN;
}

/** The smallest screen on which `vh` of type clears `arcmin` at that distance. */
export function minDiagonalInches(vh, { distanceMetres, arcmin } = { ...BASELINE, arcmin: GLANCE_ARCMIN }) {
  const cap = 2 * distanceMetres * 1000 * Math.tan(arcmin / RAD_TO_ARCMIN / 2);
  const height = (cap / CAP_PER_EM) * (100 / vh);
  return height / (MM_PER_INCH * HEIGHT_PER_DIAGONAL);
}

/** The furthest you can stand from a screen of that diagonal and still clear `arcmin`. */
export function maxDistanceMetres(vh, { diagonalInches, arcmin } = { ...BASELINE, arcmin: GLANCE_ARCMIN }) {
  const cap = capHeightMm(vh, diagonalInches);
  return cap / (2 * Math.tan(arcmin / RAD_TO_ARCMIN / 2)) / 1000;
}

// ------------------------------------------------------------------- reading the page
/**
 * Every font size the stylesheet declares, keyed by the selector's class path.
 *
 * The page carries one short stylesheet of single-class rules, written in this repo, so a
 * regex is honest here in a way it would not be against someone else's CSS. `.form li`
 * becomes the key `form li`; `footer` stays `footer`.
 */
export function styleSizes(html) {
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  if (!style) return {};
  const out = {};
  // Comments first: the stylesheet explains itself in prose, and prose has colons in it.
  const css = style[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m = rule.exec(css);
  while (m) {
    const size = /font-size:\s*([\d.]+)vh/.exec(m[2]);
    if (size) {
      for (const selector of m[1].split(',')) {
        const key = selector.trim().replace(/\./g, '').replace(/\s+/g, ' ');
        if (key && !key.includes(':') && !key.includes('*')) out[key] = Number(size[1]);
      }
    }
    m = rule.exec(css);
  }
  return out;
}

/**
 * The effective size of an element, given its classes and the list it may sit in.
 *
 * Only one class per element in this stylesheet declares a size, except `.big.words
 * .club-name` where the later rule wins — which is also the larger. So the largest
 * declared size is the effective one here, and that is exact rather than approximate.
 */
function sizeOf(classes, sizes, parentClass) {
  const keys = [...classes];
  if (parentClass) keys.push(`${parentClass} li`);
  const found = keys.map((k) => sizes[k]).filter((v) => typeof v === 'number');
  return found.length ? Math.max(...found) : null;
}

const roleOf = (classes, parentClass) => {
  const keys = parentClass ? [`${parentClass} li`, ...classes] : [...classes];
  for (const k of keys) if (ROLES[k]) return { role: ROLES[k], by: k };
  return { role: null, by: keys[0] ?? '' };
};

const TEXT_TAGS = /<(p|footer|li)\b([^>]*)>([\s\S]*?)<\/\1>/g;
const classAttr = (attrs) => (/class="([^"]*)"/.exec(attrs)?.[1] ?? '').split(/\s+/).filter(Boolean);
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const strip = (s) => s
  .replace(/<[^>]*>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m])
  .replace(/\s+/g, ' ')
  .trim();

/** Every text-bearing element of one slide, with its size, role and tier verdict. */
function slideElements(section, sizes, screen) {
  const out = [];
  const lists = /<ul class="([^"]*)">([\s\S]*?)<\/ul>/g;
  const inList = new Map();
  let l = lists.exec(section);
  while (l) {
    inList.set(l[2], l[1].split(/\s+/)[0]);
    l = lists.exec(section);
  }

  TEXT_TAGS.lastIndex = 0;
  let m = TEXT_TAGS.exec(section);
  while (m) {
    const tag = m[1];
    const classes = tag === 'footer' ? ['footer'] : classAttr(m[2]);
    let parentClass = null;
    if (tag === 'li') for (const [body, cls] of inList) if (body.includes(m[0])) parentClass = cls;
    const vh = sizeOf(classes, sizes, parentClass);
    const { role, by } = roleOf(classes, parentClass);
    if (vh !== null || role) {
      out.push({
        tag,
        selector: parentClass ? `${parentClass} li` : (classes[0] ?? tag),
        text: strip(m[3]),
        vh,
        role,
        roleBy: by,
        arcmin: vh === null ? null : arcminutes(vh, screen),
      });
    }
    m = TEXT_TAGS.exec(section);
  }
  return out;
}

const floorFor = (role, selector) => {
  if (role === 'fine') return 0;
  const exception = EXCEPTIONS[selector];
  if (exception) return exception.floorArcmin;
  return role === 'idea' ? GLANCE_ARCMIN : LEGIBLE_ARCMIN;
};

/**
 * Measure a rendered clubhouse page.
 *
 * Returns one entry per slide kind that appears, each with its elements, the largest
 * thing on it, the smallest screen it reads at a glance on, and a verdict. A class the
 * ROLES map does not know about fails: unmeasured text is not passing text.
 */
export function measurePage(html, screen = BASELINE) {
  const sizes = styleSizes(html);
  const slides = [];
  const sections = /<section class="slide ([^"]*)">([\s\S]*?)<\/section>/g;
  const seen = new Set();
  let m = sections.exec(html);
  while (m) {
    const kind = m[1].trim();
    if (!seen.has(kind)) {
      seen.add(kind);
      const elements = slideElements(m[2], sizes, screen);
      slides.push(buildSlide(kind, elements, screen));
    }
    m = sections.exec(html);
  }

  // The footer and the outage banner live outside the slides but on the same wall.
  const chrome = slideElements(html.slice(html.lastIndexOf('</section>')), sizes, screen)
    .filter((e) => e.selector === 'footer' || e.selector === 'notice')
    .map((e) => ({ ...e, text: e.text || '(the outage banner, empty until it is needed)' }));
  const wall = buildSlide('(whole wall)', chrome, screen);

  const failures = [...slides, wall].flatMap((s) => s.failures);
  return { screen, slides, wall, sizes, failures, pass: failures.length === 0 };
}

function buildSlide(kind, elements, screen) {
  const measured = elements.map((e) => {
    const floor = e.role === null ? null : floorFor(e.role, e.selector);
    const ok = e.vh !== null && e.role !== null && e.arcmin + 1e-9 >= floor;
    return { ...e, floor, ok, exception: EXCEPTIONS[e.selector]?.why ?? null };
  });
  const idea = measured.filter((e) => e.role === 'idea').sort((a, b) => b.vh - a.vh)[0] ?? null;
  const failures = measured.filter((e) => !e.ok).map((e) => ({
    kind,
    selector: e.selector,
    why: e.role === null
      ? `no role in ROLES — unmeasured text on the wall`
      : e.vh === null
        ? 'no font-size found in the stylesheet'
        : `${e.arcmin.toFixed(1)}' of cap height, under the ${e.floor}' floor for a '${e.role}'`,
  }));
  return {
    kind,
    elements: measured,
    idea,
    // The useful install number: how big a screen this slide's one idea needs at the
    // distance asked for, and how far back it still reads on the baseline set.
    glanceMinDiagonal: idea ? minDiagonalInches(idea.vh, { distanceMetres: screen.distanceMetres, arcmin: GLANCE_ARCMIN }) : null,
    glanceMaxDistance: idea ? maxDistanceMetres(idea.vh, { diagonalInches: screen.diagonalInches, arcmin: GLANCE_ARCMIN }) : null,
    failures,
  };
}

// --------------------------------------------------------------- does it fit on screen
/**
 * A rough vertical budget, because nothing here can render.
 *
 * `html,body{overflow:hidden}` means type that is too tall is silently clipped, and a
 * clipped table row is worse than a small one. This estimate is deliberately pessimistic:
 * line box at 1.25em for body text and 0.95em for `.big` (its declared line-height),
 * plus the slide's own 6vh padding top and bottom and 1.6vh gaps between children.
 */
export function verticalBudget(slide, { wrapAt = 1 } = {}) {
  const PADDING = 12;
  const GAP = 1.6;
  const BIG = new Set(['score', 'count', 'words', 'club-name']);
  // `.form` is a flex row of tiles, so its five items are one row tall, not five.
  const ROWS = { 'form li': 17 };
  const groups = new Map();
  for (const e of slide.elements) {
    if (e.selector === 'footer' || e.selector === 'notice') continue;
    const key = e.selector.endsWith(' li') ? e.selector : `${e.selector}:${groups.size}`;
    if (ROWS[e.selector]) {
      groups.set(key, ROWS[e.selector]);
      continue;
    }
    const line = (e.vh ?? 0) * (BIG.has(e.selector) ? 0.95 : 1.25);
    const lines = e.selector === 'words' ? wrapAt : 1;
    const extra = e.selector.endsWith(' li') ? 2 : 0;
    groups.set(key, (groups.get(key) ?? 0) + line * lines + extra);
  }
  const children = new Set([...groups.keys()].map((k) => (k.endsWith(' li') ? k : k.split(':')[0]))).size;
  const content = [...groups.values()].reduce((a, b) => a + b, 0);
  const badge = slide.kind === 'identity' ? 34 : 0;
  return { usedVh: content + badge + PADDING + Math.max(0, children - 1) * GAP, limitVh: 100 };
}
