'use strict';
/* A club's dashboard ports live in exactly one place: the unit file
   deploy/install.sh renders from deploy/pitchtribe.service. Nothing else on the
   Pi records them, so an installer re-run with PITCHTRIBE_PORT unset used to
   move a club back to 80/443 — the upgrade path, and the path for picking up a
   new Environment= line such as TRUST_PROXY (PIT-228). These tests run the real
   port-resolution block out of install.sh against a stub unit file, because the
   installer itself wants root and apt. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const INSTALLER = path.join(ROOT, 'deploy', 'install.sh');
const UNIT_PATH = '/etc/systemd/system/pitchtribe.service';

/** The block of install.sh that decides PORT and HTTPS_PORT, sliced out of the
    real file so that renaming or dropping it fails these tests rather than
    leaving them passing against a stale copy. */
function portBlock() {
  const lines = fs.readFileSync(INSTALLER, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('installed_port()'));
  const to = lines.findIndex((l) => l.startsWith('HTTPS_PORT="${HTTPS_PORT:-'));
  assert.ok(from >= 0, 'install.sh no longer defines installed_port()');
  assert.ok(to > from, 'install.sh no longer falls back to a default HTTPS_PORT');
  return lines.slice(from, to + 1).join('\n');
}

/** Resolves the ports the way install.sh would.
    @param unit  contents of the already-installed unit file, or null for a card
                 nothing has been installed on yet
    @param env   extra environment (PITCHTRIBE_PORT, PITCHTRIBE_HTTPS_PORT)
    @returns { port, httpsPort } */
function resolve(unit, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-install-ports-'));
  const stubUnit = path.join(dir, 'pitchtribe.service');
  if (unit !== null) fs.writeFileSync(stubUnit, unit);
  const script = [
    'set -euo pipefail',
    portBlock().split(UNIT_PATH).join(stubUnit),
    'printf "%s %s\\n" "$PORT" "$HTTPS_PORT"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    // A BASH_ENV startup file (some sandboxes set one) would run before the block.
    env: { ...process.env, BASH_ENV: '', PITCHTRIBE_PORT: '', PITCHTRIBE_HTTPS_PORT: '', ...env },
  });
  assert.equal(r.status, 0, `port resolution failed: ${r.stderr}`);
  const [port, httpsPort] = r.stdout.trim().split(' ');
  return { port, httpsPort };
}

const rendered = (port, httpsPort) => [
  '[Service]',
  'Environment=NODE_ENV=production',
  `Environment=PORT=${port}`,
  `Environment=HTTPS_PORT=${httpsPort}`,
  'Environment=DATA_DIR=/var/lib/pitchtribe',
  'Environment=TRUST_PROXY=loopback',
  'ExecStart=/usr/bin/env node /opt/pitchtribe/app/server.js',
].join('\n');

test('a first install with nothing set gets the documented 80/443', () => {
  assert.deepEqual(resolve(null), { port: '80', httpsPort: '443' });
});

test('a re-run with nothing set keeps the ports the club is already on', () => {
  // The regression this guards: before PIT-228 these came back 80 and 443, and
  // the club's dashboard moved port underneath it on the next upgrade.
  assert.deepEqual(resolve(rendered(8080, 8443)), { port: '8080', httpsPort: '8443' });
});

test('HTTPS_PORT=0 survives a re-run, because 0 is an answer and not an absence', () => {
  // 0 switches HTTPS off (app/lib/tls.js). An emptiness test would hand the
  // club a self-signed listener on 443 it had deliberately turned off.
  assert.deepEqual(resolve(rendered(80, 0)), { port: '80', httpsPort: '0' });
});

test('an explicit PITCHTRIBE_PORT still wins over the installed value', () => {
  assert.deepEqual(
    resolve(rendered(8080, 8443), { PITCHTRIBE_PORT: '9090', PITCHTRIBE_HTTPS_PORT: '9443' }),
    { port: '9090', httpsPort: '9443' },
  );
  // One of the two overridden, the other inherited.
  assert.deepEqual(resolve(rendered(8080, 8443), { PITCHTRIBE_PORT: '9090' }), { port: '9090', httpsPort: '8443' });
});

test('a half-written unit file falls back to the defaults rather than a literal @PORT@', () => {
  // An installer killed between rendering and daemon-reload, or the template
  // itself copied into place: the placeholder must never reach systemd twice.
  assert.deepEqual(resolve(rendered('@PORT@', '@HTTPS_PORT@')), { port: '80', httpsPort: '443' });
  assert.deepEqual(resolve('[Service]\nExecStart=/usr/bin/env node server.js'), { port: '80', httpsPort: '443' });
});

test('a duplicated Environment= line resolves the way systemd reads it: last wins', () => {
  const unit = `${rendered(8080, 8443)}\nEnvironment=PORT=8081`;
  assert.deepEqual(resolve(unit), { port: '8081', httpsPort: '8443' });
});

test('install.sh renders the template rather than editing it in place', () => {
  // The inheritance above is only sound while the rendered unit is the single
  // record of a club's ports; if a second copy appears, this test is the place
  // to decide which one wins.
  const sh = fs.readFileSync(INSTALLER, 'utf8');
  assert.match(sh, /sed -e "s\|@PORT@\|\$PORT\|g" -e "s\|@HTTPS_PORT@\|\$HTTPS_PORT\|g"/);
});
