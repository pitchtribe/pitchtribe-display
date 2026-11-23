'use strict';
/* Runs deploy/portal/portal-apply.sh in dry-run mode against a fake /sys and
   checks the hostapd, dnsmasq and nftables configuration it writes, and the
   commands it would run. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', '..', 'deploy', 'portal', 'portal-apply.sh');
const HW = path.join(__dirname, '..', 'lib', 'portal-hw.js');

function fakeSys({ alfa = false, usbLan = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sys-'));
  const mk = (p, files = {}) => {
    fs.mkdirSync(path.join(root, p), { recursive: true });
    for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(root, p, f), `${v}\n`);
  };
  const net = (name, devPath, drv, extra) => {
    mk(devPath);
    mk(`bus/drivers/${drv}`);
    fs.symlinkSync(path.join(root, `bus/drivers/${drv}`), path.join(root, devPath, 'driver'));
    mk(`class/net/${name}`, { type: 1, operstate: 'up', carrier: 1 });
    fs.symlinkSync(path.join(root, devPath), path.join(root, `class/net/${name}/device`));
    if (extra) mk(`class/net/${name}/${extra}`);
  };
  net('eth0', 'devices/platform/axi/ethernet', 'macb');
  net('wlan0', 'devices/platform/axi/mmc1/mmc1:0001:1', 'brcmfmac', 'wireless');
  if (alfa) {
    mk('devices/platform/axi/usb1/1-1', { product: '802.11ac NIC' });
    net('wlan1', 'devices/platform/axi/usb1/1-1/1-1:1.0', 'mt76x2u', 'phy80211');
  }
  if (usbLan) {
    mk('devices/platform/axi/usb2/2-1', { product: 'USB 10/100/1000 LAN' });
    net('eth1', 'devices/platform/axi/usb2/2-1/2-1:1.0', 'r8152');
  }
  return root;
}

function apply(settings, sysOpts) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-state-'));
  const etc = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-etc-'));
  fs.mkdirSync(path.join(etc, 'NetworkManager', 'conf.d'), { recursive: true });
  fs.writeFileSync(path.join(state, 'portal-network.json'), JSON.stringify({
    enabled: true, ssid: 'Riverside Guest', channel: 6, downMbps: 10, upMbps: 3, ...settings,
  }));
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PORTAL_DRY_RUN: '1', PORTAL_ETC: etc, PORTAL_STATE_DIR: state, PORTAL_HW: HW, SYS_ROOT: fakeSys(sysOpts),
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const read = (f) => { try { return fs.readFileSync(path.join(etc, f), 'utf8'); } catch { return null; } };
  return {
    out: r.stdout,
    err: r.stderr,
    hostapd: read('hostapd/hostapd.conf'),
    dnsmasq: read('dnsmasq.d/pitchtribe-portal.conf'),
    nft: read('pitchtribe/portal.nft'),
    nm: read('NetworkManager/conf.d/99-pitchtribe-portal.conf'),
    status: JSON.parse(fs.readFileSync(path.join(state, 'portal-hardware.json'), 'utf8')),
  };
}

test('apply: built-in radio on 2.4 GHz, bridged, with the larger guest range', () => {
  const r = apply({ radio: 'auto', band: '2.4', channel: 11 });
  assert.match(r.hostapd, /^interface=wlan0$/m);
  assert.match(r.hostapd, /^bridge=br-guest$/m);
  assert.match(r.hostapd, /^hw_mode=g$/m);
  assert.match(r.hostapd, /^channel=11$/m);
  assert.match(r.hostapd, /^ssid=Riverside Guest$/m);
  assert.match(r.dnsmasq, /^interface=br-guest$/m);
  assert.match(r.dnsmasq, /^dhcp-range=10\.42\.0\.20,10\.42\.3\.250,255\.255\.252\.0,2h$/m);
  assert.match(r.nft, /iifname "br-guest" ip saddr != @allowed drop/);
  assert.match(r.nft, /oifname "eth0" masquerade/);
  assert.match(r.out, /\+ ip addr add 10\.42\.0\.1\/22 dev br-guest/);
  assert.match(r.out, /\+ systemctl restart hostapd\.service/);
  assert.match(r.out, /\+ bridge link set dev wlan0 isolated on/);
  assert.equal(r.nm.trim().split('\n').pop(), 'unmanaged-devices=interface-name:br-guest;interface-name:wlan0');
  assert.equal(r.status.wifi, 'wlan0');
});

test('apply: the input chain ends in a drop, which is what keeps guests off the dashboard', () => {
  const r = apply({ radio: 'auto' });
  const chain = r.nft.match(/\n\s*chain input \{\n([\s\S]*?)\n\s*\}\n/);
  assert.ok(chain, 'portal.nft writes an input chain');
  const rules = chain[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  // The chain's policy is accept, so this closing drop is the only thing shutting
  // it: delete the line and every port the Pi listens on — the dashboard, and the
  // unauthenticated /healthz with its disk, memory and load figures — answers any
  // guest on the club wifi. It also has to stay *last*, because in front of the
  // accepts it would take DHCP, DNS and the sign-in sheet down with it.
  assert.equal(rules.at(-1), 'iifname "br-guest" drop');
  assert.equal(rules[0], 'type filter hook input priority filter; policy accept;');
  // What guests are let through on the way to that drop.
  assert.deepEqual(rules.slice(1, -1), [
    'iifname "br-guest" udp dport { 53, 67 } accept',
    'iifname "br-guest" tcp dport { 53, 8082 } accept',
    'iifname "br-guest" icmp type echo-request accept',
    'iifname "br-guest" ct state established,related accept',
  ]);
});

test('apply: an Alfa USB adapter on 5 GHz takes over from the built-in radio', () => {
  const r = apply({ radio: 'auto', band: '5', channel: 44 }, { alfa: true });
  assert.match(r.hostapd, /^interface=wlan1$/m);
  assert.match(r.hostapd, /^hw_mode=a$/m);
  assert.match(r.hostapd, /^ieee80211ac=1$/m);
  assert.match(r.hostapd, /^channel=44$/m);
  assert.match(r.hostapd, /^country_code=GB$/m);
  assert.match(r.out, /wlan1 \(5 GHz, channel 44\)/);
  assert.equal(r.status.wifi, 'wlan1');
});

test('apply: a 2.4 GHz channel saved with 5 GHz falls back to a valid 5 GHz channel', () => {
  const r = apply({ radio: 'builtin', band: '5', channel: 6 });
  assert.match(r.hostapd, /^channel=36$/m);
});

test('apply: ceiling access points join the bridge on the USB network adapter, isolated', () => {
  const r = apply({ radio: 'auto', accessPoints: true }, { usbLan: true });
  assert.match(r.out, /\+ ip link set eth1 master br-guest/);
  assert.match(r.out, /\+ bridge link set dev eth1 isolated on/);
  assert.match(r.nm, /interface-name:eth1/);
  assert.doesNotMatch(r.out, /eth0 master/, 'the uplink never joins the guest bridge');
  assert.equal(r.status.wired, 'eth1');
  assert.match(r.out, /access points on eth1/);
});

test('apply: access points only, with the radio off, runs no hostapd', () => {
  const r = apply({ radio: 'off', accessPoints: true }, { usbLan: true });
  assert.equal(r.hostapd, null);
  assert.doesNotMatch(r.out, /restart hostapd/);
  assert.match(r.dnsmasq, /^interface=br-guest$/m);
});

test('apply: a missing USB adapter is reported, not fatal', () => {
  const r = apply({ radio: 'usb' });
  assert.match(r.err, /No USB Wi-Fi adapter found/);
  assert.match(r.err, /no radio or access-point port/);
  assert.deepEqual(r.status.problems.length, 1);
});

test('apply: setup window refuses to start the open guest AP', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-state-'));
  const etc = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-etc-'));
  const active = path.join(state, 'active');
  fs.writeFileSync(active, '');
  fs.writeFileSync(path.join(state, 'portal-network.json'), JSON.stringify({ enabled: true }));
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: {
    ...process.env, PORTAL_DRY_RUN: '1', PORTAL_ETC: etc, PORTAL_STATE_DIR: state,
    PORTAL_HW: HW, SYS_ROOT: fakeSys(), PITCHTRIBE_SETUP_ACTIVE: active,
  } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing guest Wi-Fi activation/);
  assert.doesNotMatch(r.stdout, /restart hostapd/);
  assert.match(r.stdout, /stop pitchtribe-portal\.service hostapd\.service dnsmasq\.service/);
});

test('apply: disabling guest Wi-Fi releases NetworkManager radio ownership', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-state-'));
  const etc = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-etc-'));
  const nmDir = path.join(etc, 'NetworkManager', 'conf.d');
  fs.mkdirSync(nmDir, { recursive: true });
  fs.writeFileSync(path.join(nmDir, '99-pitchtribe-portal.conf'), '[keyfile]\nunmanaged-devices=interface-name:wlan0\n');
  fs.writeFileSync(path.join(state, 'portal-network.json'), JSON.stringify({ enabled: false }));
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: {
    ...process.env, PORTAL_DRY_RUN: '1', PORTAL_ETC: etc, PORTAL_STATE_DIR: state,
    PORTAL_HW: HW, SYS_ROOT: fakeSys(),
  } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rm -f .*99-pitchtribe-portal\.conf/);
  assert.match(r.stdout, /reload NetworkManager/);
});
