'use strict';
/* Runs deploy/bootstrap.sh — the `curl … | sudo bash` one-liner — against stub
   `curl` and `git` binaries, in its dry-run mode, so the version it chooses can
   be checked without installing anything.

   The point of these tests: that script runs as root on a club's Pi, and it
   used to install whatever happened to be on the main branch at that moment. It
   must now install a release, and must stop rather than guess. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', '..', 'deploy', 'bootstrap.sh');
const SHA = 'a'.repeat(40);

/**
 * A PATH holding fake `curl` and `git`, so nothing here touches the network.
 * The stubs log every call, so a test can assert what was *not* asked for too.
 */
function stubs({ tag = 'v9.9.9', apiSha = SHA, head = SHA, curlFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-boot-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');

  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash
echo "curl $*" >>${JSON.stringify(log)}
${curlFails ? 'exit 22' : ''}
url="\${!#}"
case "$url" in
  */releases/latest) printf '{"url":"x","tag_name":"${tag}","name":"PitchTribe ${tag}"}' ;;
  */commits/*)       printf '{"sha":"${apiSha}","commit":{"message":"x"},"parents":[{"sha":"%s"}]}' "${'b'.repeat(40)}" ;;
  *) exit 22 ;;
esac
`);

  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
echo "git $*" >>${JSON.stringify(log)}
if [[ "$1" == clone ]]; then
  dest="\${!#}"
  mkdir -p "$dest/deploy"
  printf '#!/usr/bin/env bash\\necho INSTALL-RAN\\n' >"$dest/deploy/install.sh"
  exit 0
fi
if [[ "$*" == *rev-parse* ]]; then echo "${head}"; exit 0; fi
exit 0
`);
  fs.chmodSync(path.join(bin, 'curl'), 0o755);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  return { bin, log, dir };
}

function run(env = {}, opts = {}) {
  const { bin, log, dir } = stubs(opts);
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      PITCHTRIBE_BOOTSTRAP_DRY_RUN: '1',
      ...env,
    },
  });
  return { ...r, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

test('with nothing asked for, it installs the latest release — not the main branch', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Latest release: v9\.9\.9/);
  assert.match(r.calls, /releases\/latest/, 'it asks GitHub which release is current');
  assert.match(r.calls, /git clone --depth 1 --branch v9\.9\.9/);
  assert.doesNotMatch(r.calls, /--branch main/, 'the old behaviour: whatever is on main');
  assert.doesNotMatch(r.stdout, /INSTALL-RAN/, 'a dry run installs nothing');
});

test('it stops rather than guessing when it cannot reach the releases API', () => {
  const r = run({}, { curlFails: true });
  assert.notEqual(r.status, 0, 'failing closed is the whole point');
  assert.match(r.stderr, /could not work out the latest PitchTribe release/);
  assert.match(r.stderr, /PITCHTRIBE_REF=main/, 'and it names the way round it');
  assert.doesNotMatch(r.calls, /git clone/, 'nothing was fetched');
});

test('a tag that does not name the commit we were given installs nothing', () => {
  const r = run({}, { head: 'c'.repeat(40), apiSha: SHA });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Nothing was installed/);
  assert.match(r.stderr, new RegExp(SHA), 'it says which commit it expected');
});

test('an explicit ref is still honoured, and a branch is not commit-checked', () => {
  const r = run({ PITCHTRIBE_REF: 'main' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /git clone --depth 1 --branch main/);
  assert.doesNotMatch(r.calls, /releases\/latest/, 'no lookup when the version is named');
  assert.doesNotMatch(r.calls, /commits\/main/, 'a branch has no fixed commit to check');
});

test('a mirror has to name its own version rather than falling back to a branch', () => {
  const r = run({ PITCHTRIBE_REPO: 'https://git.example.org/pitchtribe/display.git' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not on GitHub/);
  assert.match(r.stderr, /PITCHTRIBE_REF=/);
  assert.doesNotMatch(r.calls, /git clone/);
});
