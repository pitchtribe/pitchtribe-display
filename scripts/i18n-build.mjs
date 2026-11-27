// Builds the translated website: dist/<lang>/index.html and dist/<lang>/buy.html,
// hreflang alternates on every page, the language switcher, and a multilingual
// sitemap.
//
//   node scripts/i18n-build.mjs           build (after `npm run copy`)
//   node scripts/i18n-build.mjs --update  append new English strings to i18n/source.json
//   node scripts/i18n-build.mjs --check   report untranslated strings per language
//
// i18n/source.json is the list of English strings; i18n/<lang>.json maps a
// string's position in that list to its translation. Positions never change
// (new strings are appended), so edits to the English pages can't misalign
// existing translations: a changed sentence simply shows in English until it is
// translated, and --check lists it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANGS, PAGES, extract, transform } from './i18n-lib.mjs';

const SITE = 'https://pitchtribe.media';
const HTML = 'html';
const DIST = 'dist';
const mode = process.argv[2] || '--build';

const sourceFile = 'i18n/source.json';
const source = JSON.parse(readFileSync(sourceFile, 'utf8'));
const index = new Map(source.map((s, i) => [s, i]));
const pagesHtml = Object.fromEntries(PAGES.map((p) => [p, readFileSync(join(HTML, p), 'utf8')]));

// Keep the version badge in sync with app/package.json — patch source, index, and HTML in memory
// so the build always reflects the current release without touching source files.
const { version: _appVersion } = JSON.parse(readFileSync('app/package.json', 'utf8'));
const _vBadge = `v${_appVersion} stable`;
source.forEach((s, i) => { if (/^v\d+\.\d+\.\d+ stable$/.test(s)) source[i] = _vBadge; });
index.clear(); source.forEach((s, i) => index.set(s, i));
for (const p of Object.keys(pagesHtml)) pagesHtml[p] = pagesHtml[p].replace(/v\d+\.\d+\.\d+ stable/g, _vBadge);

const current = [...new Set(PAGES.flatMap((p) => extract(pagesHtml[p])))];
const unknown = current.filter((s) => !index.has(s));

// Strings that are the same in every language (names, specs, codes) — not reported as missing.
const SAME = /^(PITCH|TRIBE|EN|PitchTribe|GitHub|Amazon|The Pi Hut|FAQ|OS|CPU|RAM|GPU|USB|4K|PCIe 2\.0|Micro-HDMI ×2|USB 3\.0 ×2|VideoCore VII|BCM2712 · 4× A76|2\.4 GHz|GbE \+ Wi-Fi|microSD \/ NVMe|hostapd \+ dnsmasq \+ nftables|Raspberry Pi( 5| OS| OS Lite \((?:Bookworm|Trixie)\)| 5\.)?|English|Français|Español|Deutsch|Italiano|Português|Polski|Русский|中文|日本語|[A-D]|\d.*|.*@.*|Riverside FC|Rovers United|Northdale Ath|City Athletic|Hilltop Town|Valley Wanderers|Parkside|Old Boys XI|Reading|Glastonbury|Isle of Wight|Download|London Kings Cross|Peterborough|Brighton|Victoria|Central|Elizabeth line|EZY45TK|RYR92QF|RiversideFC-Guest|A320 · .*|B38M · .*|PITCHTRIBE · HDMI OUT|Daniel Newbury.*|— Riverside FC)$/;

if (mode === '--update') {
  if (!unknown.length) console.log('i18n: source.json is up to date');
  else {
    writeFileSync(sourceFile, `${JSON.stringify([...source, ...unknown], null, 1)}\n`);
    console.log(`i18n: appended ${unknown.length} new string(s) to ${sourceFile}:\n  ${unknown.join('\n  ')}`);
  }
  process.exit(0);
}

const tables = Object.fromEntries(LANGS.map(({ code }) => {
  const file = `i18n/${code}.json`;
  const t = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  for (const [k, v] of Object.entries(t)) {
    // Translations are inserted as HTML text: no tags, and & only as an entity.
    if (/[<>]/.test(v) || /&(?![a-z]+;|#\d+;)/i.test(v)) throw new Error(`${file} [${k}] must not contain < > or a bare &: ${v}`);
    if (!source[k]) throw new Error(`${file} has key ${k}, which is not in source.json`);
  }
  // Patch translated version badge to match the app version injected above
  const vBadgeIdx = index.get(_vBadge);
  if (vBadgeIdx !== undefined && t[vBadgeIdx] !== undefined) {
    t[vBadgeIdx] = t[vBadgeIdx].replace(/v\d+\.\d+\.\d+/, `v${_appVersion}`);
  }
  return [code, t];
}));

if (mode === '--check') {
  const minCoverageArg = process.argv.find((arg) => arg.startsWith('--min-coverage='));
  const minCoverage = minCoverageArg ? Number(minCoverageArg.split('=')[1]) : 0;
  if (!Number.isFinite(minCoverage) || minCoverage < 0 || minCoverage > 100) throw new Error('--min-coverage must be a percentage from 0 to 100');
  if (unknown.length) console.log(`New English strings not in source.json (run --update):\n  ${unknown.join('\n  ')}\n`);
  let belowMinimum = false;
  for (const { code } of LANGS) {
    const missing = current.filter((s) => !SAME.test(s) && (!index.has(s) || tables[code][index.get(s)] === undefined));
    const coverage = 100 * (current.length - missing.length) / current.length;
    if (coverage < minCoverage) belowMinimum = true;
    console.log(`${code}: ${current.length - missing.length}/${current.length} strings (${coverage.toFixed(1)}%)${missing.length ? `, missing:\n  ${missing.join('\n  ')}` : ' ✓'}`);
  }
  if (belowMinimum) console.error(`i18n: at least one locale is below ${minCoverage}% coverage`);
  process.exit(belowMinimum ? 1 : 0);
}

// ---------------------------------------------------------------- build
const urlFor = (lang, page) => `${SITE}${lang === 'en' ? '' : `/${lang}`}${page === 'index.html' ? '/' : '/buy'}`;
const all = [{ code: 'en', locale: 'en_GB', html: 'en-GB' }, ...LANGS];

function alternates(page) {
  return [
    ...all.map((l) => `  <link rel="alternate" hreflang="${l.html}" href="${urlFor(l.code, page)}">`),
    `  <link rel="alternate" hreflang="x-default" href="${urlFor('en', page)}">`,
  ].join('\n');
}

function localise(html, lang, page) {
  const t = tables[lang.code];
  let out = transform(html, (text) => {
    const i = index.get(text);
    return i !== undefined && t[i] !== undefined ? t[i] : text;
  });
  out = out
    .replace('<html lang="en-GB">', `<html lang="${lang.html}">`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${urlFor(lang.code, page)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${urlFor(lang.code, page)}$2`)
    .replace(/(<meta property="og:locale" content=")[^"]*(")/, `$1${lang.locale}$2`)
    // Internal page links stay in the visitor's language (switcher links carry hreflang and are left alone).
    .replace(/<a\b([^>]*?)\shref="\/(buy)?([#][^"]*)?"/g, (all, attrs, buy, hash) =>
      (/\shreflang=/.test(attrs) ? all : `<a${attrs} href="/${lang.code}/${buy || ''}${hash || ''}"`));
  // Switcher: current language label and aria-current.
  out = out
    .replace('<span data-lang-current>EN</span>', `<span data-lang-current>${lang.code.toUpperCase()}</span>`)
    .replace(/ hreflang="en" lang="en" aria-current="true"/, ' hreflang="en" lang="en"')
    .replace(new RegExp(` hreflang="${lang.code}" lang="${lang.code}"`), ` hreflang="${lang.code}" lang="${lang.code}" aria-current="true"`);
  return out;
}

const withAlternates = (html, page) => html.replace('</head>', `${alternates(page)}\n</head>`);

for (const page of PAGES) {
  writeFileSync(join(DIST, page), withAlternates(pagesHtml[page], page));
  for (const lang of LANGS) {
    mkdirSync(join(DIST, lang.code), { recursive: true });
    writeFileSync(join(DIST, lang.code, page), withAlternates(localise(pagesHtml[page], lang, page), page));
  }
}

// Multilingual sitemap with alternates.
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${PAGES.flatMap((page) => all.map((l) => `  <url>
    <loc>${urlFor(l.code, page)}</loc>
${all.map((a) => `    <xhtml:link rel="alternate" hreflang="${a.html}" href="${urlFor(a.code, page)}"/>`).join('\n')}
    <changefreq>${page === 'index.html' ? 'weekly' : 'monthly'}</changefreq>
    <priority>${l.code === 'en' ? (page === 'index.html' ? '1.0' : '0.8') : (page === 'index.html' ? '0.9' : '0.7')}</priority>
  </url>`)).join('\n')}
</urlset>
`;
writeFileSync(join(DIST, 'sitemap.xml'), sitemap);

if (unknown.length) console.warn(`i18n: ${unknown.length} English string(s) not in source.json yet (shown in English) — run: npm run i18n:update`);
console.log(`i18n: built ${LANGS.length} languages × ${PAGES.length} pages`);
