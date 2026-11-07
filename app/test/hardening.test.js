'use strict';
/* The hardening in deploy/ and image/ is all configuration: nothing imports it,
   so nothing would notice if it drifted. These tests pin the decisions that are
   easy to "improve" into an outage — tightening the service until the dashboard
   can't bind port 80, or hardening SSH until no club can get in. Each one says
   what breaks if it fails. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Without comment lines — these files explain in comments what they don't do,
    so "is this setting absent?" has to be asked of the instructions only. */
const code = (p) => read(p).split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

/** The [Service] directives of a unit, as a list of [key, value] pairs. */
function serviceDirectives(unit) {
  const out = [];
  let section = '';
  for (const raw of unit.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#') || !line) continue;
    if (line.startsWith('[')) { section = line; continue; }
    if (section !== '[Service]') continue;
    const eq = line.indexOf('=');
    if (eq > 0) out.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
  }
  return out;
}
const directive = (pairs, key) => pairs.filter(([k]) => k === key).map(([, v]) => v);

test('dashboard service: keeps the one capability it needs to serve port 80', () => {
  const pairs = serviceDirectives(read('deploy/pitchtribe.service'));
  // The dashboard runs as the unprivileged "pitchtribe" user on port 80. Drop
  // this capability — an empty CapabilityBoundingSet is the usual mistake — and
  // the service fails to start on every club's Pi.
  assert.deepEqual(directive(pairs, 'AmbientCapabilities'), ['CAP_NET_BIND_SERVICE']);
  assert.deepEqual(directive(pairs, 'CapabilityBoundingSet'), ['CAP_NET_BIND_SERVICE']);
  assert.equal(directive(pairs, 'User')[0], 'pitchtribe');
});

test('dashboard service: no MemoryDenyWriteExecute, which would stop Node starting', () => {
  const pairs = serviceDirectives(read('deploy/pitchtribe.service'));
  // V8 maps its JIT pages write-then-execute. This directive looks like free
  // hardening and makes Node exit immediately.
  assert.deepEqual(directive(pairs, 'MemoryDenyWriteExecute'), []);
});

test('dashboard service: /proc stays readable for the guest Wi-Fi', () => {
  const pairs = serviceDirectives(read('deploy/pitchtribe.service'));
  // app/lib/portal.js reads /proc/net/arp to match a guest's device. ProcSubset=pid
  // hides everything in /proc except process directories, which breaks that.
  assert.deepEqual(directive(pairs, 'ProcSubset'), []);
  assert.match(read('app/lib/portal.js'), /\/proc\/net\/arp/);
});

test('dashboard service: netlink stays, so Settings → About can list addresses', () => {
  const pairs = serviceDirectives(read('deploy/pitchtribe.service'));
  const families = directive(pairs, 'RestrictAddressFamilies')[0].split(/\s+/);
  // os.networkInterfaces() reads the interfaces over a netlink socket.
  for (const want of ['AF_UNIX', 'AF_INET', 'AF_INET6', 'AF_NETLINK']) {
    assert.ok(families.includes(want), `RestrictAddressFamilies must keep ${want}`);
  }
});

test('dashboard service: the club data folder is the only writable path', () => {
  const pairs = serviceDirectives(read('deploy/pitchtribe.service'));
  assert.deepEqual(directive(pairs, 'ProtectSystem'), ['strict']);
  assert.deepEqual(directive(pairs, 'ReadWritePaths'), ['/var/lib/pitchtribe']);
  // /opt/pitchtribe must not be writable: the dashboard should not be able to
  // rewrite the code that serves it.
  for (const [, v] of pairs.filter(([k]) => k === 'ReadWritePaths')) {
    assert.ok(!v.includes('/opt/pitchtribe'), 'the app directory must stay read-only');
  }
});

test('dashboard service: the expected sandbox is actually switched on', () => {
  const pairs = serviceDirectives(read('deploy/pitchtribe.service'));
  for (const key of ['NoNewPrivileges', 'ProtectHome', 'PrivateTmp', 'PrivateDevices',
    'ProtectKernelTunables', 'ProtectKernelModules', 'ProtectKernelLogs', 'ProtectControlGroups',
    'ProtectClock', 'ProtectHostname', 'RestrictSUIDSGID', 'RestrictRealtime',
    'RestrictNamespaces', 'LockPersonality', 'RemoveIPC']) {
    assert.deepEqual(directive(pairs, key), ['true'], `${key} should be true`);
  }
  assert.deepEqual(directive(pairs, 'SystemCallFilter'), ['@system-service']);
  assert.deepEqual(directive(pairs, 'SystemCallArchitectures'), ['native']);
  assert.deepEqual(directive(pairs, 'ProtectProc'), ['invisible']);
  assert.deepEqual(directive(pairs, 'UMask'), ['0077']);
});

test('SSH hardening: leaves the only way in that the dashboard offers', () => {
  const conf = read('deploy/ssh/10-pitchtribe-hardening.conf');
  const settings = conf.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  // Settings → Remote access works by setting a password for the login
  // (app/bin/remote-access.js calls chpasswd), so password logins must stay on.
  assert.ok(!settings.some((l) => /^\s*PasswordAuthentication\b/i.test(l)),
    'must not touch PasswordAuthentication — remote access sets a password');
  // The docs tell people to run `ssh yourname@pitchtribe.local`, which is port 22.
  assert.ok(!settings.some((l) => /^\s*Port\b/i.test(l)),
    'must not move the SSH port — the setup docs use the default');
  assert.ok(settings.some((l) => /^\s*PermitRootLogin\s+no\b/i.test(l)));
  assert.ok(settings.some((l) => /^\s*PermitEmptyPasswords\s+no\b/i.test(l)));
  assert.ok(settings.some((l) => /^\s*MaxAuthTries\s+3\b/i.test(l)));
});

test('installer: SSH hardening is installed, validated, and never starts SSH', () => {
  const sh = read('deploy/install.sh');
  assert.match(sh, /sshd_config\.d\//);
  assert.match(sh, /10-pitchtribe-hardening\.conf/);
  // A config sshd refuses to parse would make the Pi unreachable, so the
  // installer checks it and backs its own file out.
  assert.match(sh, /sshd -t/);
  // ...but only backs it out when sshd names our file. `sshd -t` also fails
  // when there are no host keys, which is every fresh image, and reverting on
  // that would drop this hardening from every card we build.
  assert.match(sh, /sshd -t 2>&1 \| grep -q '10-pitchtribe-hardening/);
  // Hardening SSH must not be what switches remote access on.
  assert.match(sh, /systemctl is-active --quiet ssh\.service/);
});

test('image: cmdline.txt is rewritten as a single line', () => {
  const sh = read('image/build.sh');
  // The bootloader reads the first line of cmdline.txt and ignores the rest, so
  // appending a second line silently drops those parameters. A line-wise
  // regex replace over this file is the classic way to get that wrong.
  assert.match(sh, /read -r cmdline <"\$CMDLINE"/);
  assert.match(sh, /printf '%s\\n' "\$cmdline" >"\$CMDLINE"/);
  assert.ok(!/sed -i.*cmdline\.txt/.test(code('image/build.sh')), 'do not rewrite cmdline.txt line-wise');
});

test('image: no read-only root, and the filesystem check stays on', () => {
  const sh = code('image/build.sh');
  // The club's whole configuration — database, media, backups — lives in
  // /var/lib/pitchtribe on the root filesystem. An overlay root would throw it
  // away on every reboot.
  assert.ok(!/enable_overlayfs/.test(sh), 'an overlay root would discard all club data');
  assert.ok(!/enable_bootro/.test(sh));
  // These cards get unplugged rather than shut down; the boot-time check is
  // what repairs the filesystem afterwards.
  assert.ok(!/fsck\.mode=skip/.test(sh));
});

test('image: boot hardening is applied', () => {
  const sh = read('image/build.sh');
  assert.match(sh, /enable_uart=0/);
  assert.match(sh, /dtoverlay=disable-bt/);
  assert.match(sh, /disable_splash=1/);
  for (const param of ['quiet', 'loglevel=3', 'logo.nologo', 'vt.global_cursor_default=0']) {
    assert.ok(sh.includes(param), `cmdline.txt should set ${param}`);
  }
});

test('no firewall is installed, because the guest portal already runs nftables', () => {
  // UFW and the portal's nftables ruleset would fight over the same tables, and
  // a deny-incoming default without holes for mDNS, DHCP and DNS breaks both
  // http://pitchtribe.local and the guest Wi-Fi. See deploy/portal/portal-apply.sh.
  assert.ok(!/\bufw\b/.test(code('deploy/install.sh')), 'do not add UFW alongside the portal nftables rules');
  assert.match(read('deploy/install.sh'), /nftables/);
});
