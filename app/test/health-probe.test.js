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
