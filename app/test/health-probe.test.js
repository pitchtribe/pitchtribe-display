'use strict';
/* The watcher's own exit codes.
 *
 * A watcher with no route to the club LAN once filed a critical "the card is
 * down" report about a card nobody had looked at (PIT-71): every transport
 * error came out as exit 2. These tests pin the line between "the card is
 * down" and "I could not see the card", because getting it wrong is a report
 * that reads as urgent and says nothing, and it fails quietly — the probe is
 * just as confident either way. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PROBE = path.join(__dirname, '..', '..', 'scripts', 'health-probe.mjs');

/** Runs the probe to completion. A non-zero exit is a result here, not a throw. */
const probe = (args) => new Promise((resolve) => {
  execFile(process.execPath, [PROBE, ...args, '--json'], (err, stdout, stderr) => {
    resolve({ code: err ? err.code : 0, json: stdout.trim() ? JSON.parse(stdout) : null, stderr });
  });
});

test('probe: a name that cannot resolve is unobservable, not down', async () => {
  // .invalid is reserved precisely so it never resolves anywhere.
  const r = await probe(['--host', 'pitchtribe.invalid', '--fingerprint', 'aa:bb']);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, 'unobservable');
  // Not `false`: the probe failed to look, it did not find the card down.
  assert.equal(r.json.up, null);
  assert.match(r.json.error, /ENOTFOUND/);
});

test('probe: a refused connection on a reachable host is still down', async () => {
  // The fault the probe exists to catch: something answers at the IP level and
  // the service is not there. Must not be softened into "unobservable".
  const r = await probe(['--host', 'localhost', '--port', '1', '--http']);
  assert.equal(r.code, 2);
  assert.equal(r.json.up, false);
  assert.equal(r.json.reason, undefined);
});

test('probe: a healthy card is still exit 0', async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/healthz');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '0.4.2' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const r = await probe(['--host', 'localhost', '--port', String(server.address().port), '--http']);
  assert.equal(r.code, 0);
  assert.equal(r.json.up, true);
  assert.equal(r.json.version, '0.4.2');
});

/* --address, and the outage it exists for.
 *
 * A card sat with its service stopped through nine consecutive firings (PIT-76)
 * because the watcher's resolver failed first: the probe exited 3 "unobservable"
 * and nobody was woken. Honest, and blind. These two pin the way out — going to
 * the address while keeping the certificate's name for SNI, the Host header and
 * the pin — and they pin it from the direction that failed, i.e. with a name
 * that genuinely does not resolve. */

test('probe: --address reaches the card when the name does not resolve', async (t) => {
  let sawHost = null;
  const server = http.createServer((req, res) => {
    sawHost = req.headers.host;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '0.4.2' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;

  // .invalid never resolves, so this only works by going to the address.
  const r = await probe(['--host', 'pitchtribe.invalid', '--address', '127.0.0.1', '--port', String(port), '--http']);
  assert.equal(r.code, 0);
  assert.equal(r.json.up, true);
  assert.equal(r.json.version, '0.4.2');
  // The card has to be addressed by its name, not by where the packets went:
  // that header is what picks a vhost, and over TLS the same name is the SNI
  // that decides which certificate is offered to the pin.
  assert.equal(sawHost, `pitchtribe.invalid:${port}`);
  // Said out loud, because the resolver this bypassed is still broken.
  assert.ok(r.json.notes.some((n) => /by address/.test(n)), r.json.notes.join('; '));
});

test('probe: a stopped service is down even when the name does not resolve', async () => {
  // Exactly PIT-76: nothing listening on the card's web port, and a watcher
  // whose resolver cannot see the name. Before --address this was a 3 that read
  // as "my fault, look at the watcher"; it has to be a 2 about the card.
  const r = await probe(['--host', 'pitchtribe.invalid', '--address', '127.0.0.1', '--port', '1', '--http']);
  assert.equal(r.code, 2);
  assert.equal(r.json.up, false);
  assert.equal(r.json.reason, undefined);
  // And it says where it tried, so the report is actionable on its own.
  assert.equal(r.json.address, '127.0.0.1');
});
