#!/usr/bin/env node
'use strict';
/* For sandboxes without root: fetch the Debian packages Playwright's Chromium
   needs and unpack them into a local sysroot, so the browser can run with
   LD_LIBRARY_PATH pointing at it. On a normal machine use
   `npx playwright install-deps chromium` instead.

   Usage: node tools/fetch-chromium-libs.js [sysroot-dir]
   Prints the LD_LIBRARY_PATH to export. */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const MIRROR = process.env.DEBIAN_MIRROR || 'https://deb.debian.org/debian';
const SUITE = process.env.DEBIAN_SUITE || 'trixie';
const ARCH = 'amd64';
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', '.sysroot'));

// Packages that provide the libraries the headless shell links against.
const WANT = [
  'libasound2t64', 'libatk-bridge2.0-0t64', 'libatk1.0-0t64', 'libatspi2.0-0t64', 'libcairo2', 'libcups2t64',
  'libdbus-1-3', 'libdrm2', 'libgbm1', 'libglib2.0-0t64', 'libnspr4', 'libnss3', 'libpango-1.0-0', 'libpangocairo-1.0-0',
  'libx11-6', 'libxcb1', 'libxcomposite1', 'libxdamage1', 'libxext6', 'libxfixes3', 'libxkbcommon0', 'libxrandr2',
  'libxcursor1', 'libxi6', 'libxtst6', 'libxss1', 'libxshmfence1', 'fonts-liberation', 'fonts-noto-color-emoji',
];

function installed() {
  const set = new Set();
  try {
    const status = fs.readFileSync('/var/lib/dpkg/status', 'utf8');
    for (const block of status.split('\n\n')) {
      const name = /^Package: (.+)$/m.exec(block);
      if (name && /^Status: install ok installed$/m.test(block)) set.add(name[1]);
    }
  } catch { /* no dpkg status */ }
  return set;
}

async function packagesIndex() {
  const url = `${MIRROR}/dists/${SUITE}/main/binary-${ARCH}/Packages.gz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const text = zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
  const byName = new Map();
  const provides = new Map();
  for (const block of text.split('\n\n')) {
    const get = (k) => { const m = new RegExp(`^${k}: (.+)$`, 'm').exec(block); return m ? m[1] : ''; };
    const name = get('Package');
    if (!name) continue;
    const pkg = { name, filename: get('Filename'), depends: get('Depends'), preDepends: get('Pre-Depends') };
    byName.set(name, pkg);
    for (const p of get('Provides').split(',').map((s) => s.trim().split(' ')[0]).filter(Boolean)) {
      if (!provides.has(p)) provides.set(p, name);
    }
  }
  return { byName, provides };
}

function depNames(pkg) {
  const out = [];
  for (const clause of `${pkg.depends},${pkg.preDepends}`.split(',')) {
    const alt = clause.trim().split('|')[0].trim().split(' ')[0];
    if (alt) out.push(alt.replace(/:any$/, ''));
  }
  return out;
}

async function main() {
  const have = installed();
  const { byName, provides } = await packagesIndex();
  const resolve = (n) => byName.get(n) || byName.get(provides.get(n));
  const need = new Map();
  const queue = [...WANT];
  while (queue.length) {
    const n = queue.shift();
    const pkg = resolve(n);
    if (!pkg || need.has(pkg.name) || have.has(pkg.name)) continue;
    // Leave the C runtime and init system alone; the host has them.
    if (/^(libc6|libgcc-s1|libstdc\+\+6|gcc-\d+-base|libsystemd0|libudev1|init-system-helpers|debconf|dpkg|perl-base|adduser|libselinux1|libpam)/.test(pkg.name)) continue;
    need.set(pkg.name, pkg);
    queue.push(...depNames(pkg));
  }
  fs.mkdirSync(ROOT, { recursive: true });
  const debDir = path.join(ROOT, '.debs');
  fs.mkdirSync(debDir, { recursive: true });
  for (const pkg of need.values()) {
    const deb = path.join(debDir, path.basename(pkg.filename));
    if (!fs.existsSync(deb)) {
      const res = await fetch(`${MIRROR}/${pkg.filename}`);
      if (!res.ok) throw new Error(`${pkg.filename} -> ${res.status}`);
      fs.writeFileSync(deb, Buffer.from(await res.arrayBuffer()));
    }
    execFileSync('dpkg-deb', ['-x', deb, ROOT]);
    process.stdout.write(`${pkg.name} `);
  }
  // A fontconfig file that looks in the sysroot, for hosts with no fonts at all.
  fs.writeFileSync(path.join(ROOT, 'fonts.conf'), `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${ROOT}/usr/share/fonts</dir>
  <cachedir>${ROOT}/.fontcache</cachedir>
  <include ignore_missing="yes">${ROOT}/etc/fonts/conf.d</include>
  <alias><family>Inter</family><prefer><family>Liberation Sans</family></prefer></alias>
  <alias><family>system-ui</family><prefer><family>Liberation Sans</family></prefer></alias>
  <alias><family>sans-serif</family><prefer><family>Liberation Sans</family><family>DejaVu Sans</family><family>Noto Color Emoji</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>Liberation Mono</family><family>DejaVu Sans Mono</family></prefer></alias>
</fontconfig>
`);
  console.log(`\n${need.size} packages unpacked into ${ROOT}`);
  console.log(`Now run the capture with:  SYSROOT=${ROOT} node capture.js`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
