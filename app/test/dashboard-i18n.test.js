const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const adminDir = path.join(__dirname, '..', 'public', 'admin');
const source = fs.readFileSync(path.join(adminDir, 'admin.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(adminDir, 'dashboard-translations.js'), 'utf8'), context);
const catalog = context.window.PTDashboardTranslations;
const screenStrings = require('../public/shared/i18n.js').STRINGS;
const screenEnglish = new Set(Object.values(screenStrings.en));
const navEnglish = new Set(['Content', 'Playlists', 'Screens', 'Wi-Fi', 'People', 'Settings', 'Sign out', 'Sign in', 'Password']);
const codesAndAddresses = new Set([
  '490008660N', '?nossl', 'BIW', 'HTTPS', 'PITCHTRIBE', 'connect.raspberrypi.com',
  'curl -sSL https://pitchtribe.media/install.sh | sudo PITCHTRIBE_PORTAL=1 bash',
  'fulltime.thefa.com', 'http', 'https://', 'https://calendar.google.com/calendar/ical/…/basic.ics',
  'https://huxley2.azurewebsites.net (default)', 'https://yourclub.example (optional)',
  'https://yourclub.example/news/feed', 'pitchtribe.local', 's',
]);

function templateKeys(source) {
  // Scan tagged templates without a build-time parser dependency. Nested
  // interpolation expressions may themselves contain template literals.
  function skipQuoted(i, quote) {
    for (i++; i < source.length; i++) {
      if (source[i] === '\\') { i++; continue; }
      if (source[i] === quote) return i + 1;
      if (quote === '`' && source[i] === '$' && source[i + 1] === '{') i = skipExpression(i + 2) - 1;
    }
    throw new Error('Unclosed string in dashboard source');
  }
  function skipExpression(i) {
    let depth = 1;
    for (; i < source.length; i++) {
      if ('\'"`'.includes(source[i])) { i = skipQuoted(i, source[i]) - 1; continue; }
      if (source[i] === '{') depth++;
      if (source[i] === '}' && --depth === 0) return i + 1;
    }
    throw new Error('Unclosed interpolation in dashboard source');
  }
  const keys = [];
  for (let start = source.indexOf('localize`'); start !== -1; start = source.indexOf('localize`', start + 9)) {
    let key = '';
    let number = 0;
    for (let i = start + 9; i < source.length; i++) {
      if (source[i] === '\\') { key += source.slice(i, i + 2); i++; continue; }
      if (source[i] === '`') { keys.push(key); break; }
      if (source[i] === '$' && source[i + 1] === '{') {
        key += `__VAR${number++}__`;
        i = skipExpression(i + 2) - 1;
      } else key += source[i];
    }
  }
  return keys;
}

test('dashboard locale catalog covers static calls and keeps interpolated values', () => {
  assert.deepEqual(Object.keys(catalog).sort(), ['de', 'es', 'fr', 'it', 'ja', 'pl', 'pt', 'ru', 'zh']);
  const keys = Object.keys(catalog.fr).sort();
  assert.ok(keys.length >= 900);
  for (const [locale, table] of Object.entries(catalog)) {
    assert.deepEqual(Object.keys(table).sort(), keys, `${locale} key coverage`);
    for (const key of keys) {
      assert.ok(typeof table[key] === 'string' && table[key].trim(), `${locale}: ${key}`);
      const markers = (text) => [...text.matchAll(/__VAR\d+__/g)].map((m) => m[0]).sort();
      assert.deepEqual(markers(table[key]), markers(key), `${locale} placeholders: ${key}`);
    }
    for (const key of ['Create dashboard', 'Choose an admin password', 'No screens yet', 'Save changes', 'Dashboard language', 'Sign in to __VAR0__']) {
      assert.ok(table[key], `${locale} missing control: ${key}`);
      assert.notEqual(table[key], key, `${locale} untranslated control: ${key}`);
    }
  }
  const literalCall = /\btranslate\(('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\)/g;
  const missing = new Set();
  let found = 0;
  for (const match of source.matchAll(literalCall)) {
    const key = vm.runInNewContext(match[1]);
    found++;
    if (!catalog.fr[key] && !screenEnglish.has(key) && !navEnglish.has(key) && !codesAndAddresses.has(key)) missing.add(key);
  }
  assert.ok(found >= 600, `only ${found} marked static strings`);
  assert.deepEqual([...missing], [], 'untranslated static UI strings');
  const dynamicKeys = templateKeys(source);
  assert.ok(dynamicKeys.length >= 45, 'dynamic message coverage');
  assert.deepEqual(dynamicKeys.filter((key) => !catalog.fr[key]), [], 'untranslated dynamic UI messages');
});
