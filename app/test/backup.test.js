'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { backup, restore, listBackups, ROOT } = require('../lib/backup');
const { tarChunks, readTar } = require('../lib/tar');
const helper = require('../bin/backup');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A data folder like /var/lib/pitchtribe with a club, a playlist and some media. */
function dataDir({ club = 'Riverside FC', media = { 'a1.jpg': 'photo-one', 'b2.mp4': 'video-two' } } = {}) {
  const dir = tmp('pt-data-');
  fs.mkdirSync(path.join(dir, 'media'));
  for (const [f, body] of Object.entries(media)) fs.writeFileSync(path.join(dir, 'media', f), body);
  fs.writeFileSync(path.join(dir, 'media', 'upload.jpg.part'), 'half an upload');
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    settings: { clubName: club, adminHash: 'hash' }, assets: Object.keys(media).map((f) => ({ id: f, file: { filename: f } })), playlists: [{ id: 'p' }], screens: [],
  }));
  fs.writeFileSync(path.join(dir, 'portal-guests.jsonl'), '{"email":"jo@example.com"}\n');
  return dir;
}

test('backup: snapshot with data files, media copied once, nothing half-written', () => {
  const data = dataDir();
  const stick = tmp('pt-stick-');
  const m = backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', version: '0.1.0', now: new Date('2026-11-04T03:30:00Z') });
  assert.equal(m.id, '2026-11-04T03-30-00Z', 'no colons, so FAT sticks accept it');
  assert.equal(m.club, 'Riverside FC');
  assert.deepEqual(m.media.sort(), ['a1.jpg', 'b2.mp4']);
  const host = path.join(stick, ROOT, 'bar-tv');
  assert.equal(fs.readFileSync(path.join(host, 'media', 'a1.jpg'), 'utf8'), 'photo-one');
  assert.ok(!fs.existsSync(path.join(host, 'media', 'upload.jpg.part')), 'unfinished uploads are skipped');
  assert.ok(fs.existsSync(path.join(host, 'snapshots', m.id, 'db.json')));
  assert.ok(fs.existsSync(path.join(host, 'snapshots', m.id, 'portal-guests.jsonl')));

  // A second backup reuses the media already on the stick.
  const before = fs.statSync(path.join(host, 'media', 'b2.mp4')).mtimeMs;
  const m2 = backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-04T03:30:00Z') });
  assert.equal(m2.id, '2026-11-04T03-30-01Z', 'same second: the id moves on rather than overwriting');
  assert.equal(fs.statSync(path.join(host, 'media', 'b2.mp4')).mtimeMs, before);
  assert.deepEqual(listBackups(stick).map((b) => [b.host, b.snapshots.map((s) => s.id)]), [['bar-tv', [m2.id, m.id]]]);
});

test('backup: keeps the newest snapshots and only the media they need', () => {
  const data = dataDir();
  const stick = tmp('pt-stick-');
  backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-01T03:30:00Z'), keep: 2 });
  fs.rmSync(path.join(data, 'media', 'a1.jpg')); // the club deleted a photo
  fs.writeFileSync(path.join(data, 'media', 'c3.png'), 'new');
  backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-02T03:30:00Z'), keep: 2 });
  const host = path.join(stick, ROOT, 'bar-tv');
  assert.ok(fs.existsSync(path.join(host, 'media', 'a1.jpg')), 'still needed by the older snapshot');
  backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-03T03:30:00Z'), keep: 2 });
  assert.deepEqual(listBackups(stick)[0].snapshots.map((s) => s.id), ['2026-11-03T03-30-00Z', '2026-11-02T03-30-00Z']);
  assert.ok(!fs.existsSync(path.join(host, 'media', 'a1.jpg')), 'no kept snapshot needs it any more');
  assert.ok(fs.existsSync(path.join(host, 'media', 'c3.png')));
});

test('backup: an interrupted backup leaves the earlier ones intact', () => {
  const data = dataDir();
  const stick = tmp('pt-stick-');
  backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-01T03:30:00Z') });
  fs.mkdirSync(path.join(stick, ROOT, 'bar-tv', 'snapshots', '2026-11-02T03-30-00Z.part'));
  assert.equal(listBackups(stick)[0].snapshots.length, 1, 'half-written snapshots are ignored');
  backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-03T03:30:00Z') });
  assert.ok(!fs.existsSync(path.join(stick, ROOT, 'bar-tv', 'snapshots', '2026-11-02T03-30-00Z.part')), 'and tidied up');
});

test('restore: a fresh Pi gets the content, media, password and guest list back', () => {
  const data = dataDir();
  const stick = tmp('pt-stick-');
  const m = backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv', now: new Date('2026-11-04T03:30:00Z') });
  const fresh = tmp('pt-fresh-');
  fs.writeFileSync(path.join(fresh, 'db.json'), JSON.stringify({ settings: { clubName: '', adminHash: '' } }));
  restore({ stickDir: stick, host: 'bar-tv', id: m.id, dataDir: fresh });
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, 'db.json'), 'utf8')).settings.adminHash, 'hash');
  assert.equal(fs.readFileSync(path.join(fresh, 'media', 'b2.mp4'), 'utf8'), 'video-two');
  assert.match(fs.readFileSync(path.join(fresh, 'portal-guests.jsonl'), 'utf8'), /jo@example.com/);
  assert.throws(() => restore({ stickDir: stick, host: '../etc', id: m.id, dataDir: fresh }), /No such backup/);
  fs.rmSync(path.join(stick, ROOT, 'bar-tv', 'media', 'a1.jpg'));
  assert.throws(() => restore({ stickDir: stick, host: 'bar-tv', id: m.id, dataDir: fresh }), /missing 1 photo/);
});

test('tar: round trip, and readable by the system tar', async () => {
  const dir = tmp('pt-tar-');
  fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(70_000, 7));
  fs.writeFileSync(path.join(dir, 'empty.txt'), '');
  const out = path.join(dir, 'b.tar.gz');
  await pipeline(Readable.from(tarChunks([
    { name: 'db.json', buffer: Buffer.from('{"a":1}') },
    { name: 'media/big.bin', file: path.join(dir, 'big.bin') },
    { name: 'media/empty.txt', file: path.join(dir, 'empty.txt') },
  ])), zlib.createGzip(), fs.createWriteStream(out));
  assert.deepEqual(execFileSync('tar', ['-tzf', out], { encoding: 'utf8' }).trim().split('\n'), ['db.json', 'media/big.bin', 'media/empty.txt']);

  const into = tmp('pt-untar-');
  const seen = [];
  await readTar(fs.createReadStream(out).pipe(zlib.createGunzip()), (name, size) => {
    seen.push([name, size]);
    return path.join(into, name.replace('/', '_'));
  });
  assert.deepEqual(seen, [['db.json', 7], ['media/big.bin', 70_000], ['media/empty.txt', 0]]);
  assert.ok(fs.readFileSync(path.join(into, 'media_big.bin')).equals(Buffer.alloc(70_000, 7)));

  // An archive made by the system tar reads too, and a truncated one is refused.
  const sys = path.join(dir, 'sys.tar');
  execFileSync('tar', ['-cf', sys, '-C', dir, 'big.bin']);
  const names = [];
  await readTar(fs.createReadStream(sys), (name) => { names.push(name); return null; });
  assert.deepEqual(names, ['big.bin']);
  const cut = fs.readFileSync(sys).subarray(0, 20_000);
  await assert.rejects(readTar([cut], () => null), /incomplete/);
});

/** Pretends to be lsblk/mount/umount/systemctl/chown, with sticks as folders. */
function fakeSystem(sticks) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'lsblk') {
      return JSON.stringify({ blockdevices: [
        { name: 'mmcblk0', type: 'disk', tran: null, children: [{ name: 'mmcblk0p2', type: 'part', fstype: 'ext4', uuid: 'root', mountpoints: ['/'] }] },
        ...sticks.map((s, i) => ({ name: `sd${'ab'[i]}`, path: `/dev/sd${'ab'[i]}`, type: 'disk', tran: 'usb', children: [
          { name: `sd${'ab'[i]}1`, path: `/dev/sd${'ab'[i]}1`, type: 'part', fstype: s.fstype || 'vfat', uuid: s.uuid, label: s.label, size: '32000000000', mountpoints: [null] },
        ] })),
      ] });
    }
    if (cmd === 'mount') {
      const dev = args[2];
      const target = args[3];
      const s = sticks.find((x, i) => `/dev/sd${'ab'[i]}1` === dev);
      fs.rmSync(target, { recursive: true, force: true });
      fs.symlinkSync(s.dir, target);
    }
    if (cmd === 'umount') fs.rmSync(args[0], { force: true });
    return '';
  };
  return { exec, calls };
}

function helperOpts(sys, data) {
  const run = tmp('pt-run-');
  return { dataDir: data, mountDir: path.join(run, 'mnt'), hostname: 'bar-tv', version: '0.1.0', now: () => new Date('2026-11-04T03:30:00Z'), exec: sys.exec, serviceUser: 'pitchtribe' };
}

test('helper: finds USB sticks but never the boot disk', () => {
  const sys = fakeSystem([{ uuid: 'AAAA-1111', label: 'CLUB', dir: tmp('pt-stick-') }]);
  assert.deepEqual(helper.listSticks(sys.exec).map((s) => [s.uuid, s.label, s.fstype]), [['AAAA-1111', 'CLUB', 'vfat']]);
  const bootFromUsb = () => JSON.stringify({ blockdevices: [{ name: 'sda', type: 'disk', tran: 'usb', children: [{ name: 'sda2', type: 'part', fstype: 'ext4', uuid: 'r', mountpoints: ['/'] }] }] });
  assert.deepEqual(helper.listSticks(bootFromUsb), []);
});

test('helper: choose a stick, back up nightly, then restore onto a fresh card', () => {
  const stickDir = tmp('pt-stick-');
  const sys = fakeSystem([{ uuid: 'AAAA-1111', label: 'CLUB', dir: stickDir }]);
  const data = dataDir();
  const o = helperOpts(sys, data);

  let s = helper.main('scan', o);
  assert.equal(s.sticks.length, 1);
  assert.equal(s.config, null);
  assert.ok(
    sys.calls.some((c) => c.startsWith('mount -o ro,noatime,nosuid,nodev,noexec /dev/sda1')),
    'scans mount read-only, and nosuid/nodev/noexec: the stick belongs to whoever walked up to the Pi, '
      + 'and read-only does not suppress the setuid bit'
  );
  assert.equal(fs.existsSync(o.mountDir), false, 'and unmount afterwards');

  // encrypt: false — the plain stick this file is about. Encrypted sticks, and
  // the fact that new installs encrypt by default, are in backup-crypto.test.js.
  fs.writeFileSync(path.join(data, 'backup-request.json'), JSON.stringify({ id: 'r1', action: 'use', uuid: 'AAAA-1111', encrypt: false }));
  s = helper.main('request', o);
  assert.deepEqual(s.config, { uuid: 'AAAA-1111', label: 'CLUB', encrypt: false });
  assert.equal(s.last.ok, true, s.last.message);
  assert.equal(s.sticks[0].backups[0].host, 'bar-tv');
  const again = helper.main('request', o);
  assert.equal(again.sticks[0].backups[0].snapshots.length, 1, 'the same request is only done once');

  // The card dies. A fresh one is flashed and the stick plugged back in.
  const fresh = tmp('pt-fresh-');
  fs.writeFileSync(path.join(fresh, 'db.json'), JSON.stringify({ settings: { adminHash: '' } }));
  const o2 = { ...helperOpts(sys, fresh) };
  s = helper.main('scan', o2);
  const snap = s.sticks[0].backups[0].snapshots[0];
  assert.equal(snap.club, 'Riverside FC');
  fs.writeFileSync(path.join(fresh, 'backup-request.json'), JSON.stringify({ id: 'r2', action: 'restore', uuid: 'AAAA-1111', host: 'bar-tv', snapshot: snap.id }));
  s = helper.main('request', o2);
  assert.equal(s.last.ok, true, s.last.message);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, 'db.json'), 'utf8')).settings.clubName, 'Riverside FC');
  assert.ok(sys.calls.includes('systemctl stop pitchtribe.service'));
  assert.ok(sys.calls.includes(`chown -R pitchtribe:pitchtribe ${fresh}`));
  assert.equal(sys.calls.filter((c) => c === 'systemctl start pitchtribe.service').length, 1);
  assert.deepEqual(s.config, { uuid: 'AAAA-1111', label: 'CLUB', encrypt: false }, 'keeps backing up to the same stick');
});

test('helper: a missing or full stick is reported in plain English', () => {
  const stickDir = tmp('pt-stick-');
  const sticks = [{ uuid: 'AAAA-1111', label: 'CLUB', dir: stickDir }];
  const sys = fakeSystem(sticks);
  const data = dataDir();
  const o = helperOpts(sys, data);
  fs.writeFileSync(path.join(data, 'backup-request.json'), JSON.stringify({ id: 'r1', action: 'use', uuid: 'AAAA-1111' }));
  helper.main('request', o);
  sticks.length = 0; // unplugged
  const s = helper.main('nightly', o);
  assert.equal(s.last.ok, false);
  assert.match(s.last.message, /“CLUB” isn’t plugged in/);
  fs.writeFileSync(path.join(data, 'backup-request.json'), JSON.stringify({ id: 'r2', action: 'restore', uuid: 'AAAA-1111', host: 'bar-tv', snapshot: '../../x' }));
  assert.match(helper.main('request', o).last.message, /No such backup/);
});

test('backup: a full stick is refused before anything is written', (t) => {
  const data = dataDir();
  const stick = tmp('pt-stick-');
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 1, bsize: 1024 }));
  assert.throws(() => backup({ dataDir: data, stickDir: stick, hostname: 'bar-tv' }), /USB stick is full/);
  assert.deepEqual(fs.readdirSync(path.join(stick, ROOT, 'bar-tv', 'snapshots')), []);
  assert.deepEqual(fs.readdirSync(path.join(stick, ROOT, 'bar-tv', 'media')), []);
});
