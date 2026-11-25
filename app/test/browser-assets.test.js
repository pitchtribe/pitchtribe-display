'use strict';
/* The dashboard and the player are classic scripts in a browser, so nothing on
   the server ever parses them. v0.5.0-pre.1 shipped an admin.js whose string
   delimiters had been replaced by curly quotes — a file the browser could not
   parse at all. The Pi served it happily, the page kept the "Loading…" shell it
   starts with, and the card looked like a hung boot for three hours. The suite
   was green throughout: 265 tests and not one of them read the front end.

   These checks are the cheapest thing that would have caught it. They parse
   what the Pi serves, and they find the files rather than listing them, because
   the asset added after the list was written is the one that goes unchecked. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');

function scriptsUnder(dir) {
  return fs.readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(dir, f))
    .sort();
}

test('every script the Pi serves to a browser can actually be parsed', () => {
  const files = scriptsUnder(PUBLIC);

  // A readdir that came back empty would turn this into a no-op that passes.
  assert.ok(files.length >= 5, `only ${files.length} browser scripts found — expected at least 5`);

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const name = path.relative(PUBLIC, file);
    // These are plain <script src> files, not modules, so a vm.Script parse is
    // the same work the browser does before it runs a line.
    assert.doesNotThrow(
      () => new vm.Script(source, { filename: name }),
      `${name} does not parse, so the page that loads it never starts`,
    );
  }
});

test('the dashboard and player shells do not name a script that is missing', () => {
  for (const page of ['admin', 'player']) {
    const html = fs.readFileSync(path.join(PUBLIC, page, 'index.html'), 'utf8');
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.length > 0, `${page}/index.html loads no script — it cannot replace its own boot screen`);

    for (const src of srcs) {
      // Root-relative paths are served from public/; the rest sit next to the page.
      const file = src.startsWith('/') ? path.join(PUBLIC, src) : path.join(PUBLIC, page, src);
      assert.ok(fs.existsSync(file), `${page}/index.html asks for ${src}, which is not there`);
    }
  }
});

test('the dashboard boot screen is only ever replaced by script', () => {
  // The symptom to protect against is a screen stuck on this text, so keep the
  // relationship between the shell and the script that clears it explicit.
  const html = fs.readFileSync(path.join(PUBLIC, 'admin', 'index.html'), 'utf8');
  assert.match(html, /Loading…/, 'the boot screen moved — check what now signals a dashboard that never started');

  const admin = fs.readFileSync(path.join(PUBLIC, 'admin', 'admin.js'), 'utf8');
  assert.match(admin, /#app|getElementById\('app'\)/, 'admin.js no longer takes over #app, so the boot screen would stay up');
});
