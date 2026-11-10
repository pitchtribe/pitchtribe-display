'use strict';
/* The path from a commit to a club's Pi. These are pinning tests: each one
   fails if a change quietly reopens something the security review closed, with
   the reason in the assertion message rather than in a commit nobody rereads. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

test('no workflow trusts a third-party action by a tag that can move', () => {
  for (const f of fs.readdirSync(WORKFLOWS)) {
    const text = read(path.join('.github', 'workflows', f));
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:-\s*)?uses:\s*(\S+)/);
      if (!m) continue;
      const ref = m[1];
      // A reusable workflow in this repository moves only when we move it.
      if (ref.startsWith('./')) continue;
      assert.match(
        ref,
        /@[0-9a-f]{40}$/,
        `${f}: ${ref} is pinned by tag. A moved tag runs someone else's code with our secrets — `
          + 'deploy.yml hands CLOUDFLARE_API_TOKEN to wrangler-action. Pin the commit, version in a comment.'
      );
      assert.match(line, /#\s*v?\d/, `${f}: ${ref} needs a trailing version comment, or nobody can read the pin`);
    }
  }
});

test('the released image is signed by the build, not just checksummed', () => {
  const image = read('.github/workflows/image.yml');
  assert.match(image, /actions\/attest-build-provenance@[0-9a-f]{40}/,
    'the .sha256 beside the image detects corruption, not tampering: whoever can replace the image '
      + 'can replace the checksum. The attestation is what ties it to this repository and commit.');
  assert.match(image, /id-token:\s*write/, 'attestation needs an OIDC token');
  assert.match(image, /attestations:\s*write/);
  // Attesting before the upload would mean a failed attestation left a release
  // with no assets at all. The release matters more than the signature.
  assert.ok(
    image.indexOf('gh release upload') < image.indexOf('Attest the image'),
    'attest after uploading, so a failing attestation does not cost the release its assets'
  );
  assert.match(read('docs/updates-backups.html'), /gh attestation verify/,
    'a signature nobody is told how to check is not much of a signature');
});

test('something is watching for a vulnerable dependency', () => {
  const dependabot = read('.github/dependabot.yml');
  for (const dir of ['/', '/app', '/signage-server']) {
    assert.ok(
      new RegExp(`directory:\\s*${dir}\\s*$`, 'm').test(dependabot),
      `${dir} has its own package-lock.json and needs its own Dependabot entry`
    );
  }
  assert.match(dependabot, /package-ecosystem:\s*github-actions/,
    'the action pins above are commit SHAs, so only Dependabot will ever update them');
  assert.match(read('.github/workflows/codeql.yml'), /languages:\s*javascript-typescript/);
});

test('the download page cannot be reached in plaintext, and the trade is written down', () => {
  // The first plaintext request to the site is the one a volunteer makes before
  // copying `curl … | sudo bash`, so it is the one worth never making.
  assert.match(read('html/_headers'), /Strict-Transport-Security:.*includeSubDomains;\s*preload/,
    'preload is what stops the first request to pitchtribe.media going over http at all');
  // And on the club's own network the dashboard is http by default, which is a
  // defensible trade but only if a club is told about it.
  const dash = read('docs/dashboard.html');
  assert.match(dash, /unencrypted/, 'say plainly that a password over http crosses the Wi-Fi in the clear');
  assert.match(dash, /id="https"/, 'and say how to turn HTTPS on');
});

test('the one-line installer installs a release, and fails closed', () => {
  const sh = read('deploy/bootstrap.sh');
  assert.doesNotMatch(sh, /PITCHTRIBE_REF:-main/,
    'the one-liner runs as root on a club Pi: it must not install whatever is on main at that moment');
  assert.match(sh, /releases\/latest/);
  assert.match(sh, /could not work out the latest PitchTribe release/,
    'a failed lookup must stop, not fall back to a branch');
  assert.match(sh, /Nothing was installed/, 'a tag that does not name the checked-out commit must abort');
});
