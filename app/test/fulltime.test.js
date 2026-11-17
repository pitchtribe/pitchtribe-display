'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSnippet, embedDocument, EMBED_CSP } = require('../lib/fulltime');

// Shaped like the snippets Full-Time generates: a placeholder the script fills in.
const SCRIPT_SNIPPET =
  '<div id="lrep567300589"></div>\n' +
  '<script type="text/javascript" src="https://fulltime.thefa.com/client/api/cs1/567300589.js?selectedSeason=218511240"></script>';

const html = (snippet) => embedDocument(parseSnippet(snippet));

test('a script snippet keeps its placeholder and its source', () => {
  const nodes = parseSnippet(SCRIPT_SNIPPET);
  assert.deepEqual(
    nodes.filter((n) => n.kind === 'div').map((n) => n.id),
    ['lrep567300589']
  );
  const script = nodes.find((n) => n.kind === 'script');
  assert.equal(script.src, 'https://fulltime.thefa.com/client/api/cs1/567300589.js?selectedSeason=218511240');
  const doc = embedDocument(nodes);
  assert.match(doc, /<div id="lrep567300589">/);
  assert.match(doc, /<script src="https:\/\/fulltime\.thefa\.com\/client\/api\/cs1\/567300589\.js\?selectedSeason=218511240"><\/script>/);
});

test('an iframe snippet keeps the size Full-Time asked for', () => {
  const nodes = parseSnippet('<iframe src="https://fulltime-league.thefa.com/Table.do?divisionseason=378401116" width="350" height="500" frameborder="0"></iframe>');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].width, 350);
  assert.equal(nodes[0].height, 500);
  assert.match(embedDocument(nodes), /width="350" height="500"/);
});

test('a bare Full-Time address is read as a frame', () => {
  const nodes = parseSnippet('https://fulltime.thefa.com/table.html?selectedSeason=218511240');
  assert.equal(nodes[0].kind, 'iframe');
  assert.equal(nodes[0].src, 'https://fulltime.thefa.com/table.html?selectedSeason=218511240');
});

test('protocol-relative sources are upgraded to https', () => {
  const nodes = parseSnippet('<div id="lrep1"></div><script src="//fulltime.thefa.com/client/api/cs1/1.js"></script>');
  assert.equal(nodes.find((n) => n.kind === 'script').src, 'https://fulltime.thefa.com/client/api/cs1/1.js');
});

test('http sources are rewritten rather than left in the clear', () => {
  const nodes = parseSnippet('<script src="http://fulltime-league.thefa.com/Table.do?divisionseason=1"></script>');
  assert.match(nodes[0].src, /^https:\/\//);
});

test('only thefa.com may be embedded', () => {
  for (const host of ['example.com', 'thefa.com.evil.test', 'notthefa.com', 'localhost']) {
    assert.throws(
      () => parseSnippet(`<script src="https://${host}/x.js"></script>`),
      (err) => err.status === 400 && /thefa\.com|full web address/i.test(err.message),
      host
    );
  }
  // The real host and its subdomains are fine.
  assert.ok(parseSnippet('<script src="https://thefa.com/x.js"></script>').length);
  assert.ok(parseSnippet('<script src="https://fulltime.thefa.com/x.js"></script>').length);
});

test('inline script is refused, even behind an allowed src', () => {
  assert.throws(() => parseSnippet('<script>alert(1)</script>'), /no src|inline script/i);
  assert.throws(
    () => parseSnippet('<script src="https://fulltime.thefa.com/x.js">fetch("/api/state")</script>'),
    /inline script/i
  );
});

test('event handlers and unknown elements are refused', () => {
  assert.throws(() => parseSnippet('<div id="a" onload="alert(1)"></div><script src="https://fulltime.thefa.com/x.js"></script>'), /onload/);
  assert.throws(() => parseSnippet('<img src="https://fulltime.thefa.com/x.png" onerror="alert(1)">'), /<img>/);
  assert.throws(() => parseSnippet('<object data="x"></object>'), /<object>/);
});

test('a paste with nothing to load is refused rather than shown blank', () => {
  assert.throws(() => parseSnippet('<div id="lrep1"></div>'), /no Full-Time table/i);
  assert.throws(() => parseSnippet(''), /required/i);
});

test('attribute values from a snippet cannot break out of the markup', () => {
  // A quote and a tag in an id would otherwise end the attribute early.
  assert.throws(() => parseSnippet('<div id="a&quot;><script>alert(1)</script>"></div>'), /usable element id|not something we can embed/i);
  const doc = html('<div id="lrep1" class="ft table"></div><script src="https://fulltime.thefa.com/x.js"></script>');
  assert.ok(!doc.includes('<script>alert'), 'no injected inline script');
});

test('a malformed paste is refused promptly rather than hanging the parser', () => {
  // An unclosed tag full of empty quotes used to give the regex engine two ways
  // to read every quote, and it backtracked exponentially: 24 of them took a
  // minute. parseSnippet runs when a panel is served as well as when it is
  // saved, so that was every screen's request wedged, not just one save.
  const nasty = `<A${'""'.repeat(400)}`;
  const started = Date.now();
  assert.throws(() => parseSnippet(nasty), /no Full-Time table|not something we can embed/i);
  const ms = Date.now() - started;
  assert.ok(ms < 1000, `parsing should stay linear, took ${ms}ms`);
});

test('attribution text survives but is escaped', () => {
  const doc = html('<script src="https://fulltime.thefa.com/x.js"></script><p>Powered by <a href="https://fulltime.thefa.com/">Full-Time</a> & the FA</p>');
  assert.match(doc, /Powered by/);
  assert.match(doc, /&amp; the FA/);
  assert.match(doc, /<a href="https:\/\/fulltime\.thefa\.com\/" rel="noreferrer nofollow">/);
});

test('the embed document sandboxes Full-Time and names no other origin', () => {
  assert.match(EMBED_CSP, /sandbox allow-scripts/);
  assert.match(EMBED_CSP, /default-src 'none'/);
  assert.match(EMBED_CSP, /frame-ancestors 'self'/);
  assert.ok(!/allow-same-origin/.test(EMBED_CSP), 'never same-origin: it must not reach the dashboard cookie');
  for (const directive of EMBED_CSP.split(';')) {
    const hosts = directive.match(/https?:\/\/[^\s;]+/g) || [];
    for (const host of hosts) assert.match(host, /thefa\.com$/, `${directive} names only thefa.com`);
  }
});

test('a fixed zoom is used as given, and fit is the default', () => {
  assert.match(embedDocument(parseSnippet(SCRIPT_SNIPPET), { zoom: 2 }), /fixed=2/);
  assert.match(embedDocument(parseSnippet(SCRIPT_SNIPPET)), /fixed=0/);
});

test('a snippet longer than the limit is refused', () => {
  const long = `<div id="a"></div><script src="https://fulltime.thefa.com/${'x'.repeat(4100)}.js"></script>`;
  assert.throws(() => parseSnippet(long), /too long/i);
});
