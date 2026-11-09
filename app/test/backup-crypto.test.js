'use strict';
/* Encrypted USB backups.
 *
 * The case that matters most is the last one in this file: the memory card has
 * died, so the key the Pi held has died with it, and the only thing left is a
 * printed code. If that test ever goes red, a club with a dead card and a stick
 * full of backups cannot get its data back. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backup, restore, listBackups, hostDirFor, ROOT } = require('../lib/backup');
const enc = require('../lib/backup-crypto');
const helper = require('../bin/backup');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const GUEST = 'jo@example.com';
const HASH = 'scrypt$the-club-password-hash';

function dataDir({ club = 'Riverside FC', media = { 'a1.jpg': 'photo-one', 'b2.mp4': 'video-two' } } = {}) {
  const dir = tmp('pt-data-');
  fs.mkdirSync(path.join(dir, 'media'));
  for (const [f, body] of Object.entries(media)) fs.writeFileSync(path.join(dir, 'media', f), body);
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    settings: { clubName: club, adminHash: HASH, widgets: { trains: { token: 'rail-secret' } } },
    assets: Object.keys(media).map((f) => ({ id: f, file: { filename: f } })),
    playlists: [], screens: [],
  }));
  fs.writeFileSync(path.join(dir, 'portal-guests.jsonl'), `${JSON.stringify({ email: GUEST, consent: true })}\n`);
  return dir;
}

/** Every byte of every file under a folder, so "is this still readable?" is one call. */
function allBytes(dir) {
  const parts = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else parts.push(Buffer.from(e.name), fs.readFileSync(p));
    }
  };
  walk(dir);
  return Buffer.concat(parts);
}

test('the recovery code reads back the way a volunteer would type it', () => {
  const code = enc.newRecoveryCode();
  assert.equal(code.length, 24);
  assert.equal(enc.formatCode(code), code.match(/.{4}/g).join('-'));
  assert.equal(enc.normalizeCode(enc.formatCode(code)), code);
  assert.equal(enc.normalizeCode(` ${enc.formatCode(code).toLowerCase()} `), code, 'lower case and stray spaces');
  // The alphabet has no I, L or O for exactly this reason.
  assert.equal(enc.normalizeCode('0123456789ABCDEFGHJKMNPQ'), '0123456789ABCDEFGHJKMNPQ');
  assert.equal(enc.normalizeCode('o123456789abcdefghjkmnpq'), '0123456789ABCDEFGHJKMNPQ');
  assert.equal(enc.normalizeCode('0l23456789ABCDEFGHJKMNPQ'), '0123456789ABCDEFGHJKMNPQ');
  assert.throws(() => enc.normalizeCode('too-short'), /24 letters and numbers/);
  assert.throws(() => enc.normalizeCode(''), /24 letters and numbers/);
});

test('keys.json never holds the key bare, and opens either way round', () => {
  const smk = enc.newMasterKey();
  const machineKey = enc.newMasterKey();
  const code = enc.newRecoveryCode();
  const keys = enc.wrapMaster({ smk, machineKey, recoveryCode: code });

  const asText = JSON.stringify(keys);
  assert.ok(!asText.includes(smk.toString('base64')), 'the stick master key is not written down');
  assert.ok(!asText.includes(machineKey.toString('base64')), 'nor is the machine key');
  assert.ok(!asText.includes(code), 'nor is the recovery code');

  assert.deepEqual(enc.unwrapMaster(keys, { machineKey }), { smk, via: 'machine' });
  assert.deepEqual(enc.unwrapMaster(keys, { recoveryCode: code }), { smk, via: 'recovery' });
  assert.equal(enc.unwrapMaster(keys, { machineKey: enc.newMasterKey() }), null, 'another Pi cannot open it');
  assert.equal(enc.unwrapMaster(keys, { recoveryCode: enc.newRecoveryCode() }), null, 'nor can another code');
  assert.equal(enc.unwrapMaster(keys, {}), null, 'nor can nothing at all');
});

test('a stolen stick gives up nothing but when and which club', () => {
  const data = dataDir();
  const stick = tmp('pt-stick-');
  const smk = enc.newMasterKey();
  const m = backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', version: '0.4.3', now: new Date('2026-11-04T03:30:00Z'), smk });

  assert.equal(m.encrypted, true);
  const bytes = allBytes(stick);
  assert.ok(!bytes.includes(GUEST), 'no guest email addresses');
  assert.ok(!bytes.includes(HASH), 'no password hash');
  assert.ok(!bytes.includes('rail-secret'), 'no third-party API keys');
  assert.ok(!bytes.includes('photo-one'), 'and the photos are encrypted too — this is the safeguarding one');

  // manifest.json stays readable on purpose: the first-run screen has to be
  // able to offer "Riverside FC — Wednesday 03:30" before anyone has signed in.
  const host = hostDirFor(stick, 'bar-tv');
  const manifest = JSON.parse(fs.readFileSync(path.join(host, 'snapshots', m.id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.club, 'Riverside FC');
  assert.equal(manifest.encrypted, true);
  assert.deepEqual(listBackups(stick)[0].snapshots.map((s) => s.id), [m.id]);

  // Restoring it back gives the club everything.
  const fresh = tmp('pt-fresh-');
  restore({ stickDir: stick, host: 'bar-tv', id: m.id, dataDir: fresh, smk });
  const db = JSON.parse(fs.readFileSync(path.join(fresh, 'db.json'), 'utf8'));
  assert.equal(db.settings.adminHash, HASH);
  assert.equal(db.settings.clubName, 'Riverside FC');
  assert.match(db.settings.sessionSecret, /^[0-9a-f]{64}$/, 'a restore still mints a new session secret');
  // And the snapshot itself carries none, encrypted or not: a secret that
  // survives a round trip brings every 30-day cookie back with it.
  const onStickDb = JSON.parse(enc.decryptToBuffer(path.join(host, 'snapshots', m.id, 'db.json'), smk, `snapshots/${m.id}/db.json`).toString('utf8'));
  assert.equal(onStickDb.settings.sessionSecret, undefined);
  assert.equal(onStickDb.settings.adminHash, HASH, 'but the club still gets its password back');
  assert.equal(fs.readFileSync(path.join(fresh, 'media', 'a1.jpg'), 'utf8'), 'photo-one');
  assert.equal(fs.readFileSync(path.join(fresh, 'media', 'b2.mp4'), 'utf8'), 'video-two');
  assert.match(fs.readFileSync(path.join(fresh, 'portal-guests.jsonl'), 'utf8'), /jo@example\.com/);
  assert.equal(fs.statSync(path.join(fresh, 'db.json')).mode & 0o777, 0o600);
});

test('without the key an encrypted backup says so, rather than failing oddly', () => {
  const data = dataDir();
  const stick = tmp('pt-stick-');
  const smk = enc.newMasterKey();
  const m = backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-04T03:30:00Z'), smk });
  const fresh = tmp('pt-fresh-');
  assert.throws(
    () => restore({ stickDir: stick, host: 'bar-tv', id: m.id, dataDir: fresh, smk: null }),
    /encrypted\. Type the recovery code/
  );
  assert.throws(
    () => restore({ stickDir: stick, host: 'bar-tv', id: m.id, dataDir: fresh, smk: enc.newMasterKey() }),
    /damaged, or the USB stick has been tampered with/,
    'the wrong key reads as a damaged stick, not as empty data'
  );
});

test('an edited stick fails the restore instead of installing what is on it', () => {
  const data = dataDir();
  const stick = tmp('pt-stick-');
  const smk = enc.newMasterKey();
  const m = backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-04T03:30:00Z'), smk });
  const host = hostDirFor(stick, 'bar-tv');

  // Someone with the stick flips a byte in a photo.
  const photo = path.join(host, 'media', 'a1.jpg');
  const edited = fs.readFileSync(photo);
  edited[edited.length - 20] ^= 0x80;
  fs.writeFileSync(photo, edited);

  const fresh = tmp('pt-fresh-');
  assert.throws(() => restore({ stickDir: stick, host: 'bar-tv', id: m.id, dataDir: fresh, smk }), /tampered with/);
  assert.ok(!fs.existsSync(path.join(fresh, 'media', 'a1.jpg')), 'nothing half-decrypted is left behind');
  assert.deepEqual(fs.readdirSync(path.join(fresh, 'media')), [], 'and no .part files either');

  // The same for the database: a swapped db.json does not become the club.
  const stick2 = tmp('pt-stick-');
  const m2 = backup({ dataDir: data, stickDir: stick2, hostname: 'bar-tv', now: new Date('2026-11-05T03:30:00Z'), smk });
  const db2 = path.join(hostDirFor(stick2, 'bar-tv'), 'snapshots', m2.id, 'db.json');
  const body = fs.readFileSync(db2);
  body[body.length - 1] ^= 0x01;
  fs.writeFileSync(db2, body);
  assert.throws(() => restore({ stickDir: stick2, host: 'bar-tv', id: m2.id, dataDir: tmp('pt-fresh-'), smk }), /tampered with/);
});

test('a file cannot be moved between snapshots unnoticed', () => {
  const data = dataDir();
  const stick = tmp('pt-stick-');
  const smk = enc.newMasterKey();
  const a = backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-04T03:30:00Z'), smk });
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({ settings: { clubName: 'Riverside FC', adminHash: 'a-newer-hash' }, assets: [], playlists: [], screens: [] }));
  const b = backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-05T03:30:00Z'), smk });
  const snaps = path.join(hostDirFor(stick, 'bar-tv'), 'snapshots');

  // Put the older database into the newer snapshot. Each file's key and its
  // authenticated data are tied to where it sits, so this does not read.
  fs.copyFileSync(path.join(snaps, a.id, 'db.json'), path.join(snaps, b.id, 'db.json'));
  assert.throws(() => restore({ stickDir: stick, host: 'bar-tv', id: b.id, dataDir: tmp('pt-fresh-'), smk }), /tampered with/);
});

test('encrypted media is still copied once, and switching encryption on rewrites it', () => {
  const data = dataDir();
  const stick = tmp('pt-stick-');
  const smk = enc.newMasterKey();
  const host = hostDirFor(stick, 'bar-tv');

  // Plain to begin with, the way an existing club's stick already is.
  const plain = backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-01T03:30:00Z'), smk: null });
  assert.equal(plain.encrypted, false);
  assert.equal(fs.readFileSync(path.join(host, 'media', 'a1.jpg'), 'utf8'), 'photo-one');

  // The club switches encryption on. The next run re-writes the media.
  backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-02T03:30:00Z'), smk });
  assert.ok(enc.looksEncrypted(path.join(host, 'media', 'a1.jpg')));
  assert.equal(fs.statSync(path.join(host, 'media', 'a1.jpg')).size, 'photo-one'.length + enc.OVERHEAD);

  // And the run after that leaves it alone — media is copied once, not nightly.
  const before = fs.statSync(path.join(host, 'media', 'b2.mp4')).mtimeMs;
  backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-03T03:30:00Z'), smk });
  assert.equal(fs.statSync(path.join(host, 'media', 'b2.mp4')).mtimeMs, before, 'not re-encrypted every night');

  // The older, plain snapshot still restores, even though the media it points
  // at is encrypted now. Which files are encrypted is decided by looking.
  const fresh = tmp('pt-fresh-');
  restore({ stickDir: stick, host: 'bar-tv', id: plain.id, dataDir: fresh, smk });
  assert.equal(fs.readFileSync(path.join(fresh, 'media', 'a1.jpg'), 'utf8'), 'photo-one');
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, 'db.json'), 'utf8')).settings.adminHash, HASH);
});

test('an interrupted encrypted backup leaves the earlier ones readable', () => {
  const data = dataDir();
  const stick = tmp('pt-stick-');
  const smk = enc.newMasterKey();
  const first = backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-01T03:30:00Z'), smk });
  const snaps = path.join(hostDirFor(stick, 'bar-tv'), 'snapshots');
  fs.mkdirSync(path.join(snaps, '2026-11-02T03-30-00Z.part'));
  fs.writeFileSync(path.join(hostDirFor(stick, 'bar-tv'), 'media', 'c3.png.part'), 'half an encryption');
  assert.equal(listBackups(stick)[0].snapshots.length, 1, 'half-written snapshots are ignored');
  backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-03T03:30:00Z'), smk });
  assert.ok(!fs.existsSync(path.join(snaps, '2026-11-02T03-30-00Z.part')), 'and tidied up');
  assert.ok(!fs.existsSync(path.join(hostDirFor(stick, 'bar-tv'), 'media', 'c3.png.part')));
  restore({ stickDir: stick, host: 'bar-tv', id: first.id, dataDir: tmp('pt-fresh-'), smk });
});

// ------------------------------------------------------------- the whole Pi

/** Pretends to be lsblk/mount/umount/systemctl/chown, with sticks as folders. */
function fakeSystem(sticks) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'lsblk') {
      return JSON.stringify({ blockdevices: [
        { name: 'mmcblk0', type: 'disk', tran: null, children: [{ name: 'mmcblk0p2', type: 'part', fstype: 'ext4', uuid: 'root', mountpoints: ['/'] }] },
        ...sticks.map((s, i) => ({ name: `sd${'ab'[i]}`, path: `/dev/sd${'ab'[i]}`, type: 'disk', tran: 'usb', children: [
          { name: `sd${'ab'[i]}1`, path: `/dev/sd${'ab'[i]}1`, type: 'part', fstype: 'vfat', uuid: s.uuid, label: s.label, size: '32000000000', mountpoints: [null] },
        ] })),
      ] });
    }
    if (cmd === 'mount') {
      const dev = args[2];
      const s = sticks.find((x, i) => `/dev/sd${'ab'[i]}1` === dev);
      fs.rmSync(args[3], { recursive: true, force: true });
      fs.symlinkSync(s.dir, args[3]);
    }
    if (cmd === 'umount') fs.rmSync(args[0], { force: true });
    return '';
  };
  return { exec, calls };
}

const helperOpts = (sys, data) => ({
  dataDir: data,
  mountDir: path.join(tmp('pt-run-'), 'mnt'),
  hostname: 'bar-tv',
  version: '0.4.3',
  now: () => new Date('2026-11-04T03:30:00Z'),
  exec: sys.exec,
  serviceUser: 'pitchtribe',
});

const ask = (data, req) => fs.writeFileSync(path.join(data, 'backup-request.json'), JSON.stringify(req));

test('the card dies: a printed recovery code is the whole way back', () => {
  const stickDir = tmp('pt-stick-');
  const sys = fakeSystem([{ uuid: 'AAAA-1111', label: 'CLUB', dir: stickDir }]);
  const data = dataDir();
  const o = helperOpts(sys, data);

  // The club picks a stick. New installs encrypt unless told otherwise.
  ask(data, { id: 'r1', action: 'use', uuid: 'AAAA-1111' });
  let s = helper.main('request', o);
  assert.equal(s.last.ok, true, s.last.message);
  assert.deepEqual(s.config, { uuid: 'AAAA-1111', label: 'CLUB', encrypt: true });
  assert.deepEqual(s.encryption, { on: true, machineKey: true, recoveryCode: true });
  assert.equal(s.sticks[0].backups[0].snapshots[0].encrypted, true);
  assert.equal(s.sticks[0].backups[0].locked, false, 'this card can open its own stick');

  // The machine key is 0600, and it is not on the stick: a key carried on the
  // stick it protects is not a key.
  const keyFile = enc.machineKeyPath(data);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(enc.recoveryPath(data)).mode & 0o777, 0o600);
  const onStick = allBytes(stickDir);
  assert.ok(!onStick.includes(fs.readFileSync(keyFile)), 'the machine key never reaches the stick');
  assert.ok(!onStick.includes(GUEST));
  assert.ok(!onStick.includes(enc.KEY_FILE), 'and neither key file is in a snapshot');
  assert.ok(!onStick.includes(enc.RECOVERY_FILE));

  // The club writes the code on a card and puts it in the clubhouse safe.
  const printed = enc.formatCode(enc.readRecoveryCode(data));

  // Then the memory card dies. A new one is flashed: no backup key, no code,
  // nothing at all but the stick and the piece of paper.
  const fresh = tmp('pt-fresh-');
  fs.writeFileSync(path.join(fresh, 'db.json'), JSON.stringify({ settings: { adminHash: '' } }));
  const o2 = helperOpts(sys, fresh);
  assert.equal(enc.readMachineKey(fresh), null);

  s = helper.main('scan', o2);
  const snap = s.sticks[0].backups[0].snapshots[0];
  assert.equal(snap.club, 'Riverside FC', 'the restore picker can still list it');
  assert.equal(snap.encrypted, true);
  assert.equal(s.sticks[0].backups[0].locked, true, 'and knows it must ask for the code');

  // Without the code there is nothing doing, and it says so.
  ask(fresh, { id: 'r2', action: 'restore', uuid: 'AAAA-1111', host: 'bar-tv', snapshot: snap.id });
  assert.match(helper.main('request', o2).last.message, /encrypted\. Type the recovery code/);

  // The wrong code is told apart from no code.
  ask(fresh, { id: 'r3', action: 'restore', uuid: 'AAAA-1111', host: 'bar-tv', snapshot: snap.id, recoveryCode: enc.formatCode(enc.newRecoveryCode()) });
  assert.match(helper.main('request', o2).last.message, /does not match this USB stick/);
  ask(fresh, { id: 'r4', action: 'restore', uuid: 'AAAA-1111', host: 'bar-tv', snapshot: snap.id, recoveryCode: 'nonsense' });
  assert.match(helper.main('request', o2).last.message, /24 letters and numbers/);

  // The code off the printed card, typed the way somebody would type it.
  ask(fresh, { id: 'r5', action: 'restore', uuid: 'AAAA-1111', host: 'bar-tv', snapshot: snap.id, recoveryCode: ` ${printed.toLowerCase()} ` });
  s = helper.main('request', o2);
  assert.equal(s.last.ok, true, s.last.message);
  const db = JSON.parse(fs.readFileSync(path.join(fresh, 'db.json'), 'utf8'));
  assert.equal(db.settings.clubName, 'Riverside FC');
  assert.equal(db.settings.adminHash, HASH, 'the club signs in with its usual password');
  assert.equal(fs.readFileSync(path.join(fresh, 'media', 'b2.mp4'), 'utf8'), 'video-two');
  assert.match(fs.readFileSync(path.join(fresh, 'portal-guests.jsonl'), 'utf8'), /jo@example\.com/);

  // The code does not stay sitting in a file in DATA_DIR afterwards.
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, 'backup-request.json'), 'utf8')).recoveryCode, undefined);

  // This Pi now has a key of its own, back in root's hands after the chown -R
  // that hands the data folder to the dashboard's user.
  assert.ok(enc.readMachineKey(fresh), 'and a backup key, so tonight runs unattended');
  assert.equal(enc.readRecoveryCode(fresh), enc.normalizeCode(printed), 'and can show the club its code again');
  const chowns = sys.calls.filter((c) => c.startsWith('chown'));
  assert.ok(chowns.indexOf(`chown -R pitchtribe:pitchtribe ${fresh}`) < chowns.indexOf(`chown root:root ${enc.machineKeyPath(fresh)}`),
    'the key is handed back to root after the recursive chown, not before');
  assert.ok(sys.calls.includes(`chown pitchtribe:pitchtribe ${enc.recoveryPath(fresh)}`), 'the dashboard can read the code to show it');
  assert.deepEqual(s.config, { uuid: 'AAAA-1111', label: 'CLUB', encrypt: true }, 'and keeps encrypting to the same stick');

  // Tonight's backup needs no code: the machine wrap was put back on the stick.
  s = helper.main('nightly', o2);
  assert.equal(s.last.ok, true, s.last.message);
  assert.equal(s.sticks[0].backups[0].locked, false);
  assert.equal(s.sticks[0].backups[0].snapshots.length, 2);
});

test('an existing club turns encryption on, and can turn it off again', () => {
  const stickDir = tmp('pt-stick-');
  const sys = fakeSystem([{ uuid: 'AAAA-1111', label: 'CLUB', dir: stickDir }]);
  const data = dataDir();
  const o = helperOpts(sys, data);

  // An existing install: the stick was chosen before encryption existed.
  ask(data, { id: 'r1', action: 'use', uuid: 'AAAA-1111', encrypt: false });
  let s = helper.main('request', o);
  assert.equal(s.last.ok, true, s.last.message);
  assert.equal(s.encryption.on, false);
  assert.equal(s.encryption.machineKey, false, 'no key is made for a club that has not asked');
  assert.ok(allBytes(stickDir).includes(GUEST), 'this is what a plain stick in a drawer holds');

  // Settings → Backups → encrypt. It does not wait for 03:30.
  ask(data, { id: 'r2', action: 'encrypt', on: true });
  s = helper.main('request', o);
  assert.equal(s.last.ok, true, s.last.message);
  assert.equal(s.last.message, 'Backups on this stick are encrypted');
  assert.equal(s.encryption.on, true);
  assert.ok(enc.readStickKeys(hostDirFor(stickDir, 'bar-tv')), 'the stick has its wrapped key');
  assert.equal(s.sticks[0].backups[0].snapshots[0].encrypted, true, 'the newest snapshot is encrypted');

  // Off again, for a club that decides the printed code is more risk than help.
  ask(data, { id: 'r3', action: 'encrypt', on: false });
  s = helper.main('request', o);
  assert.equal(s.last.message, 'Encryption switched off');
  assert.equal(s.encryption.on, false);
  assert.equal(s.sticks[0].backups[0].snapshots[0].encrypted, false);

  // And a club with no stick chosen is told what to do first.
  ask(data, { id: 'r4', action: 'stop' });
  helper.main('request', o);
  ask(data, { id: 'r5', action: 'encrypt', on: true });
  assert.match(helper.main('request', o).last.message, /Choose a USB stick/);
});

test('a stick belonging to another club is refused rather than overwritten', () => {
  const stickDir = tmp('pt-stick-');
  const sys = fakeSystem([{ uuid: 'AAAA-1111', label: 'CLUB', dir: stickDir }]);

  // Another Pi's encrypted stick: keys.json neither of this Pi's keys can open.
  const hostDir = hostDirFor(stickDir, 'bar-tv');
  fs.mkdirSync(hostDir, { recursive: true });
  enc.writeStickKeys(hostDir, enc.wrapMaster({ smk: enc.newMasterKey(), machineKey: enc.newMasterKey(), recoveryCode: enc.newRecoveryCode() }));

  const data = dataDir();
  ask(data, { id: 'r1', action: 'use', uuid: 'AAAA-1111' });
  const s = helper.main('request', helperOpts(sys, data));
  assert.equal(s.last.ok, false);
  assert.match(s.last.message, /cannot open|different stick/);
  assert.ok(enc.readStickKeys(hostDir), 'and the other club’s key is left alone');
});
