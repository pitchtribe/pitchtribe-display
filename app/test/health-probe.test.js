'use strict';
/* scripts/health-probe.mjs turns off Node's certificate chain check and pins
   the card's SHA-256 fingerprint instead. CodeQL flags that line
   (`js/disabling-certificate-validation`, alert 41) and the finding is left
   open and assessed in .github/codeql/triage.md.

   That assessment rests on two properties of this script, neither of which was
   pinned by anything until these tests. Both are one careless edit away from
   being false, and if either stops holding, the assessment is wrong rather than
   merely out of date:

   - The pin is compared *after* the handshake, so the request is already sent
     when the certificate is checked. That is only acceptable because the probe
     carries no credential to leak.
   - It fails closed: no fingerprint means it refuses to run, rather than
     quietly becoming a probe that trusts any certificate at all.

   These run the real script as a subprocess against a real card certificate,
   because both properties are about what actually goes on the wire. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const tls = require('../lib/tls');

const PROBE = path.join(__dirname, '..', '..', 'scripts', 'health-probe.mjs');

/** A card certificate made the way the Pi makes its own, with its fingerprint. */
function cardCert(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pitchtribe-probe-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return tls.ensure({ dataDir, hostname: 'lounge-tv' });
}

/** An HTTPS server with that certificate, recording every request it receives. */
async function cardServer(t, cert, body) {
  const seen = [];
  const server = https.createServer({ cert: cert.cert, key: cert.key }, (req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { seen, port: server.address().port };
}

/** Runs the probe and resolves its exit code and output, never rejecting. */
function runProbe(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [PROBE, ...args],
      // A fingerprint left in the environment would satisfy the requirement
      // the fail-closed test below is trying to prove, so clear it.
      { env: { ...process.env, PITCHTRIBE_FINGERPRINT: '' }, timeout: 20000 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
  });
}


/** Runs the JSON probe to completion. A non-zero exit is a result. */
const probe = (args) => new Promise((resolve) => {
  execFile(process.execPath, [PROBE, ...args, '--json'], (err, stdout, stderr) => {
    resolve({ code: err ? err.code : 0, json: stdout.trim() ? JSON.parse(stdout) : null, stderr });
  });
});

const healthyBody = JSON.stringify({
  ok: true,
  version: '0.4.3',
  status: 'ok',
  warnings: [],
  uptime: { hostSeconds: 36622, appSeconds: 36000 },
});

test('the probe sends no credential, which is what makes pinning after the handshake safe', async (t) => {
  const cert = cardCert(t);
  const { seen, port } = await cardServer(t, cert, healthyBody);

  const r = await runProbe(['--host', '127.0.0.1', '--port', String(port), '--fingerprint', cert.fingerprint]);
  assert.equal(r.code, 0, `expected a clean probe, got ${r.code}: ${r.stderr}${r.stdout}`);
  assert.match(r.stdout, /^UP/);
  assert.equal(seen.length, 1);

  /* The point of the test. By the time the fingerprint is compared, everything
     in this list has already reached whoever answered on that address — so the
     list has to stay empty. Adding an authenticated endpoint to this probe
     means pinning inside the handshake instead; see triage.md. */
  for (const header of ['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-pitchtribe']) {
    assert.equal(seen[0].headers[header], undefined, `the probe must not send ${header}`);
  }
  assert.deepEqual(
    Object.keys(seen[0].headers).filter((h) => !['accept', 'user-agent', 'host', 'connection'].includes(h)),
    [],
    'an unexpected header reached the card: check it carries nothing secret before allowing it',
  );
});

test('without a fingerprint it refuses to probe at all, rather than trusting anything', async (t) => {
  const cert = cardCert(t);
  const { seen, port } = await cardServer(t, cert, healthyBody);

  const r = await runProbe(['--host', '127.0.0.1', '--port', String(port)]);
  assert.equal(r.code, 64, 'a missing fingerprint is a usage error, not a silent downgrade');
  assert.match(r.stderr, /--fingerprint is required/);
  // It must give up before opening the connection: a probe that connects and
  // then decides is a probe that can be made to skip the check.
  assert.equal(seen.length, 0, 'the probe contacted the card without a fingerprint to check');

  // --insecure is the only way past, and it has to say so in the output.
  const forced = await runProbe(['--host', '127.0.0.1', '--port', String(port), '--insecure']);
  assert.equal(forced.code, 0);
  assert.match(forced.stdout, /UNVERIFIED/);
});

test('a certificate that does not match is a failure, and the body is never read', async (t) => {
  const cert = cardCert(t);
  const other = cardCert(t);
  assert.notEqual(other.fingerprint, cert.fingerprint, 'two cards must not share a fingerprint');

  // The impostor answers with a perfectly healthy-looking card.
  const body = JSON.stringify({ ok: true, version: '9.9.9-from-the-impostor', uptime: { hostSeconds: 1, appSeconds: 1 } });
  const { port } = await cardServer(t, cert, body);

  const r = await runProbe(['--host', '127.0.0.1', '--port', String(port), '--fingerprint', other.fingerprint]);
  assert.equal(r.code, 2, 'the wrong certificate is "down", not "up with a warning"');
  assert.match(r.stderr, /fingerprint does not match/);
  // Nothing from that response may have been parsed or reported. If the version
  // appears anywhere, the probe trusted a body before checking who sent it.
  assert.doesNotMatch(r.stdout + r.stderr, /9\.9\.9-from-the-impostor/);
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
