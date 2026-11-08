#!/usr/bin/env node
'use strict';
/* PitchTribe USB backup helper. Runs as root (pitchtribe-backup@.service),
   because the dashboard's server is not allowed to mount disks.

     backup.js scan      find USB sticks and the backups on them (boot, plug-in)
     backup.js nightly   back up to the chosen stick (pitchtribe-backup.timer)
     backup.js request   do what the dashboard asked in backup-request.json
                         (pitchtribe-backup.path): use a stick, stop using it,
                         back up now, or restore a backup

   It talks to the dashboard through files in DATA_DIR:
     backup-request.json   written by the server: { id, action, uuid?, host?, snapshot? }
     backup-config.json    the stick backups go to: { uuid, label }
     backup-status.json    sticks found, their backups, the last result

   A stick is mounted only while it is being read or written, so pulling it
   out, or a power cut, is unlikely to damage it. Sticks formatted FAT32, exFAT
   or ext4 work; the disk the Pi boots from is never touched. */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backup, restore, listBackups, BackupError, SAFE_NAME, SNAPSHOT_ID } = require('../lib/backup');

const FILESYSTEMS = ['vfat', 'exfat', 'ext4'];
const SYSTEM_MOUNTS = ['/', '/boot', '/boot/firmware'];

function defaults() {
  let version = '';
  try { version = require('../package.json').version; } catch { /* dev */ }
  return {
    dataDir: process.env.DATA_DIR || '/var/lib/pitchtribe',
    mountDir: process.env.BACKUP_MOUNT_DIR || '/run/pitchtribe-backup',
    hostname: os.hostname(),
    version,
    now: () => new Date(),
    exec: (cmd, args) => childProcess.execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    serviceUser: 'pitchtribe',
  };
}

/** USB storage the Pi could back up to: [{ uuid, label, fstype, size, path, mountpoint }]. */
function listSticks(exec) {
  const out = exec('lsblk', ['-J', '-b', '-o', 'NAME,PATH,TYPE,TRAN,FSTYPE,UUID,LABEL,SIZE,MOUNTPOINTS']);
  const devices = JSON.parse(out).blockdevices || [];
  const sticks = [];
  const walk = (d, fn) => { fn(d); for (const c of d.children || []) walk(c, fn); };
  for (const disk of devices) {
    if (disk.type !== 'disk' || disk.tran !== 'usb') continue;
    let system = false;
    walk(disk, (d) => { if ((d.mountpoints || []).some((m) => SYSTEM_MOUNTS.includes(m))) system = true; });
    if (system) continue; // the Pi boots from this USB drive: never touch it
    walk(disk, (d) => {
      if (!FILESYSTEMS.includes(d.fstype) || !d.uuid) return;
      sticks.push({
        uuid: d.uuid,
        label: d.label || '',
        fstype: d.fstype,
        size: Number(d.size) || 0,
        path: d.path,
        mountpoint: (d.mountpoints || []).find(Boolean) || null,
      });
    });
  }
  return sticks;
}

/** Mounts the stick for the duration of fn(dir), unless something already has it mounted. */
function withMount(o, stick, { readOnly }, fn) {
  if (stick.mountpoint) return fn(stick.mountpoint);
  fs.mkdirSync(o.mountDir, { recursive: true });
  // nosuid,nodev,noexec: plugging a stick in is enough to get it mounted here,
  // by root, and the stick belongs to whoever walked up to the Pi. A read-only
  // mount does not suppress the setuid bit, so without nosuid a setuid-root
  // binary on the stick would be live for as long as it is mounted. We only
  // ever read and write files on these, never run them.
  o.exec('mount', ['-o', `${readOnly ? 'ro,' : ''}noatime,nosuid,nodev,noexec`, stick.path, o.mountDir]);
  try {
    return fn(o.mountDir);
  } finally {
    try { o.exec('sync', []); } catch { /* best effort */ }
    o.exec('umount', [o.mountDir]);
  }
}

const file = (o, name) => path.join(o.dataDir, name);
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJson(f, value) {
  fs.writeFileSync(`${f}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(`${f}.tmp`, f);
}
const readStatus = (o) => readJson(file(o, 'backup-status.json')) || {};
const writeStatus = (o, s) => writeJson(file(o, 'backup-status.json'), { ...s, updatedAt: o.now().toISOString() });
const readConfig = (o) => readJson(file(o, 'backup-config.json'));

/** Looks at every stick: free space and the backups already on it. */
function scan(o, status = readStatus(o)) {
  const sticks = [];
  for (const s of listSticks(o.exec)) {
    try {
      withMount(o, s, { readOnly: true }, (dir) => {
        let free = 0;
        try { const st = fs.statfsSync(dir); free = st.bavail * st.bsize; } catch { /* unknown */ }
        const backups = listBackups(dir).map((b) => ({
          host: b.host,
          snapshots: b.snapshots.map(({ id, at, club, version, counts, bytes }) => ({ id, at, club, version, counts, bytes })),
        }));
        sticks.push({ uuid: s.uuid, label: s.label, fstype: s.fstype, size: s.size, free, backups });
      });
    } catch (err) {
      sticks.push({ uuid: s.uuid, label: s.label, fstype: s.fstype, size: s.size, free: 0, backups: [], error: 'Could not read this stick' });
      console.error(`could not read ${s.path}: ${err.message}`);
    }
  }
  const next = { ...status, running: null, config: readConfig(o), sticks };
  writeStatus(o, next);
  return next;
}

function findStick(o, uuid) {
  return listSticks(o.exec).find((s) => s.uuid === uuid) || null;
}

/** Backs up to the chosen stick and records the result. */
function runBackup(o, status) {
  const config = readConfig(o);
  let last;
  if (!config) {
    last = { action: 'backup', at: o.now().toISOString(), ok: false, message: 'No backup stick chosen' };
  } else {
    const stick = findStick(o, config.uuid);
    if (!stick) {
      last = { action: 'backup', at: o.now().toISOString(), ok: false, message: `The backup stick${config.label ? ` “${config.label}”` : ''} isn’t plugged in` };
    } else {
      writeStatus(o, { ...status, running: 'backup' });
      try {
        const m = withMount(o, stick, { readOnly: false }, (dir) =>
          backup({ dataDir: o.dataDir, stickDir: dir, hostname: o.hostname, version: o.version, now: o.now() }));
        last = { action: 'backup', at: m.at, ok: true, message: 'Backed up', snapshot: m.id };
      } catch (err) {
        last = { action: 'backup', at: o.now().toISOString(), ok: false, message: err instanceof BackupError ? err.message : `Backup failed: ${err.message}` };
      }
    }
  }
  return scan(o, { ...status, last });
}

function runRestore(o, status, req) {
  const at = o.now().toISOString();
  if (!SAFE_NAME.test(String(req.host)) || !SNAPSHOT_ID.test(String(req.snapshot))) {
    return scan(o, { ...status, last: { action: 'restore', at, ok: false, message: 'No such backup' } });
  }
  const stick = findStick(o, req.uuid);
  if (!stick) return scan(o, { ...status, last: { action: 'restore', at, ok: false, message: 'The USB stick isn’t plugged in any more' } });
  writeStatus(o, { ...status, running: 'restore' });
  let last;
  o.exec('systemctl', ['stop', 'pitchtribe.service']);
  try {
    const m = withMount(o, stick, { readOnly: true }, (dir) =>
      restore({ stickDir: dir, host: req.host, id: req.snapshot, dataDir: o.dataDir }));
    o.exec('chown', ['-R', `${o.serviceUser}:${o.serviceUser}`, o.dataDir]);
    // Keep backing up to the stick the club restored from.
    writeJson(file(o, 'backup-config.json'), { uuid: stick.uuid, label: stick.label });
    last = { action: 'restore', at, ok: true, message: `Restored the backup from ${new Date(m.at).toUTCString()}`, snapshot: m.id };
  } catch (err) {
    last = { action: 'restore', at, ok: false, message: err instanceof BackupError ? err.message : `Restore failed: ${err.message}` };
  } finally {
    o.exec('systemctl', ['start', 'pitchtribe.service']);
  }
  return scan(o, { ...status, last });
}

/** Does what the dashboard asked, once per request id. */
function handleRequest(o) {
  const req = readJson(file(o, 'backup-request.json'));
  const status = readStatus(o);
  if (!req || !req.id || req.id === status.lastRequestId) return status;
  const base = { ...status, lastRequestId: req.id };
  writeStatus(o, base);
  switch (req.action) {
    case 'use': {
      const stick = findStick(o, req.uuid);
      if (!stick) return scan(o, { ...base, last: { action: 'use', at: o.now().toISOString(), ok: false, message: 'That USB stick isn’t plugged in any more' } });
      writeJson(file(o, 'backup-config.json'), { uuid: stick.uuid, label: stick.label });
      return runBackup(o, base);
    }
    case 'stop':
      fs.rmSync(file(o, 'backup-config.json'), { force: true });
      return scan(o, { ...base, last: { action: 'stop', at: o.now().toISOString(), ok: true, message: 'Backups to the USB stick are switched off' } });
    case 'now':
      return runBackup(o, base);
    case 'restore':
      return runRestore(o, base, req);
    default:
      return scan(o, base);
  }
}

/** One job at a time: a scan triggered by plugging a stick in must not mount
    it while a backup is writing to it. Waits up to ten minutes for the lock. */
function withLock(o, fn) {
  const lock = `${o.mountDir}.lock`;
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; ; waited++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(lock, 'utf8')) || 0;
      let alive = false;
      try { process.kill(pid, 0); alive = pid > 0; } catch { /* gone */ }
      if (!alive) { fs.rmSync(lock, { force: true }); continue; }
      if (waited > 600) throw new Error('another backup job is still running');
      Atomics.wait(sleep, 0, 0, 1000);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

function main(command, o = defaults()) {
  if (!['scan', 'nightly', 'request'].includes(command)) throw new Error('usage: backup.js scan|nightly|request');
  return withLock(o, () => {
    if (command === 'scan') return scan(o);
    if (command === 'nightly') return readConfig(o) ? runBackup(o, readStatus(o)) : scan(o);
    return handleRequest(o);
  });
}

module.exports = { listSticks, scan, runBackup, handleRequest, main, defaults };

if (require.main === module) {
  try {
    const s = main(process.argv[2]);
    if (s.last) console.log(`${s.last.action}: ${s.last.ok ? 'ok' : 'failed'} — ${s.last.message}`);
    process.exitCode = s.last && !s.last.ok && process.argv[2] !== 'scan' ? 1 : 0;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
