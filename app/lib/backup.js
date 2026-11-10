'use strict';
/* Backups of a PitchTribe data folder (DATA_DIR) to another folder — in
   practice the root of a USB stick, mounted by bin/backup.js.

   On the stick:
     PitchTribe-backups/<hostname>/
       keys.json                 this stick's encryption key, wrapped (see backup-crypto.js)
       media/                    every photo and video, copied once (uploads never change)
       snapshots/<id>/           one per backup; the newest KEEP are kept
         db.json                 content, playlists, screens, settings, password
         portal-network.json     guest Wi-Fi network settings
         portal-guests.jsonl     guest Wi-Fi email sign-ups
         manifest.json           when, which club, which media files it needs

   Snapshot ids are UTC times with dashes, not colons, so FAT and exFAT sticks
   accept them. Every file is written under a temporary name and renamed, so a
   stick pulled out mid-backup leaves the previous snapshots intact.

   With a stick master key (`smk`), everything on the stick except manifest.json
   is encrypted — the password hash, the guest emails and the photos, which are
   the three things that matter if the stick walks. manifest.json stays readable
   so the first-run screen can still offer "Barnton FC — Saturday 03:30" before
   anybody has signed in, and carries `encrypted: true` to say what it is.
   Backups written before a club switched encryption on stay readable; which
   files are encrypted is decided per file, by looking, not from the flag. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const enc = require('./backup-crypto');

const ROOT = 'PitchTribe-backups';
const KEEP = 30;
const DATA_FILES = ['db.json', 'portal-network.json', 'portal-guests.jsonl'];
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,120}$/;
const SNAPSHOT_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

class BackupError extends Error {}

const snapshotId = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');

/** Where one Pi's backups live on a stick. */
const hostDirFor = (stickDir, hostname) => path.join(stickDir, ROOT, hostname);

/* A wrong recovery code or a tampered file is something a club can act on, so
   it reads as a backup problem rather than a crash. */
function plainly(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof enc.CryptoError) throw new BackupError(err.message);
    throw err;
  }
}

function copyAtomic(from, to) {
  const tmp = `${to}.part`;
  fs.copyFileSync(from, tmp);
  fs.renameSync(tmp, to);
}

/**
 * Writes db.json for a backup or a restore — never a straight file copy, and
 * never with the session signing secret in it.
 *
 * Sessions are signed cookies with a 30-day life and no way to revoke one, so
 * a secret that survives a round trip through a backup brings every cookie
 * minted under it back to life, including ones a password change was meant to
 * have killed. Leaving it out also keeps it off the USB stick in the drawer.
 * `fresh` writes a new one, for the copy that becomes the live database.
 *
 * Mode 0600 explicitly: both callers run as root, where the umask would leave
 * the password hash and every API key readable by anyone with an account here.
 */
function dbBytes(db, { fresh = true } = {}) {
  const settings = { ...(db.settings || {}) };
  if (fresh) settings.sessionSecret = crypto.randomBytes(32).toString('hex');
  else delete settings.sessionSecret;
  return Buffer.from(`${JSON.stringify({ ...db, settings }, null, 2)}\n`);
}

function writeDb(db, to, { fresh = true } = {}) {
  const tmp = `${to}.part`;
  fs.writeFileSync(tmp, dbBytes(db, { fresh }), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, to);
}

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

const mediaFiles = (dataDir) => {
  try {
    return fs.readdirSync(path.join(dataDir, 'media')).filter((f) => SAFE_NAME.test(f) && !f.endsWith('.part'));
  } catch {
    return [];
  }
};

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The snapshots for one Pi, newest first (complete ones only). */
function snapshotsIn(hostDir) {
  const dir = path.join(hostDir, 'snapshots');
  let ids = [];
  try { ids = fs.readdirSync(dir).filter((d) => SNAPSHOT_ID.test(d)); } catch { return []; }
  return ids.sort().reverse()
    .map((id) => readJson(path.join(dir, id, 'manifest.json')))
    .filter((m) => m && SNAPSHOT_ID.test(m.id));
}

/** Every PitchTribe backup on a stick: [{ host, snapshots: [manifest…] }]. */
function listBackups(stickDir) {
  const root = path.join(stickDir, ROOT);
  let hosts = [];
  try { hosts = fs.readdirSync(root).filter((h) => SAFE_NAME.test(h)); } catch { return []; }
  return hosts.sort()
    .map((host) => ({ host, snapshots: snapshotsIn(path.join(root, host)) }))
    .filter((b) => b.snapshots.length);
}

/**
 * Backs dataDir up to stickDir. Returns the new snapshot's manifest.
 * Throws BackupError with a plain-English message if the stick is too full.
 *
 * `smk` is this stick's master key (see backup-crypto.js). With it, every file
 * written here but manifest.json is encrypted. Without it, the stick is written
 * exactly as it was before encryption existed.
 */
function backup({ dataDir, stickDir, hostname, version = '', now = new Date(), keep = KEEP, smk = null }) {
  if (!SAFE_NAME.test(hostname)) throw new BackupError(`Unusual hostname “${hostname}”`);
  const db = readJson(path.join(dataDir, 'db.json'));
  if (!db || !db.settings) throw new BackupError('There is nothing to back up yet');
  // Encryption adds a nonce and a tag per file, which the "is it already on the
  // stick?" size check below has to allow for, or every file is copied nightly.
  const onStick = (plain) => plain + (smk ? enc.OVERHEAD : 0);
  const hostDir = hostDirFor(stickDir, hostname);
  const mediaDir = path.join(hostDir, 'media');
  const snapsDir = path.join(hostDir, 'snapshots');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(snapsDir, { recursive: true });

  // Only photos and videos the stick doesn't have yet need copying.
  const media = mediaFiles(dataDir);
  const toCopy = [];
  let needed = 0;
  for (const f of media) {
    const size = onStick(fs.statSync(path.join(dataDir, 'media', f)).size);
    let have = -1;
    try { have = fs.statSync(path.join(mediaDir, f)).size; } catch { /* not there yet */ }
    // Switching encryption on or off changes every size here, so the next
    // nightly run rewrites the media as a side effect. That is the intent.
    if (have !== size) { toCopy.push(f); needed += size; }
  }
  for (const f of DATA_FILES) {
    try { needed += onStick(fs.statSync(path.join(dataDir, f)).size); } catch { /* optional */ }
  }
  const free = freeBytes(hostDir);
  if (needed + 5 * 1024 * 1024 > free) {
    const mb = (n) => `${Math.ceil(n / 1024 / 1024)} MB`;
    throw new BackupError(`The USB stick is full: this backup needs ${mb(needed)} and only ${mb(free)} is free. Use a bigger stick, or delete old files from it.`);
  }
  for (const f of toCopy) {
    const from = path.join(dataDir, 'media', f);
    const to = path.join(mediaDir, f);
    // media/<name>, not snapshots/<id>/media/<name>: one copy is shared by every
    // snapshot that still needs it, so its key cannot depend on a snapshot id.
    if (smk) plainly(() => enc.encryptFile(from, to, smk, `media/${f}`));
    else copyAtomic(from, to);
  }

  let id = snapshotId(now);
  for (let k = 1; fs.existsSync(path.join(snapsDir, id)); k++) id = snapshotId(new Date(now.getTime() + k * 1000));
  const work = path.join(snapsDir, `${id}.part`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work);
  let bytes = 0;
  for (const f of DATA_FILES) {
    const from = path.join(dataDir, f);
    if (!fs.existsSync(from)) continue;
    const to = path.join(work, f);
    const label = `snapshots/${id}/${f}`;
    if (smk && f === 'db.json') plainly(() => enc.encryptBuffer(dbBytes(db, { fresh: false }), to, smk, label, { mode: 0o600 }));
    else if (smk) plainly(() => enc.encryptFile(from, to, smk, label, { mode: 0o600 }));
    else if (f === 'db.json') writeDb(db, to, { fresh: false });
    else fs.copyFileSync(from, to);
    bytes += fs.statSync(to).size;
  }
  for (const f of media) bytes += fs.statSync(path.join(mediaDir, f)).size;
  const manifest = {
    format: 1,
    id,
    at: now.toISOString(),
    hostname,
    version,
    club: String(db.settings.clubName || ''),
    counts: { assets: (db.assets || []).length, playlists: (db.playlists || []).length, screens: (db.screens || []).length },
    media,
    bytes,
    encrypted: Boolean(smk),
  };
  fs.writeFileSync(path.join(work, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(work, path.join(snapsDir, id));

  prune(hostDir, keep);
  return manifest;
}

/** Keeps the newest `keep` snapshots, and only the media they still need. */
function prune(hostDir, keep = KEEP) {
  const snapsDir = path.join(hostDir, 'snapshots');
  for (const d of fs.readdirSync(snapsDir)) {
    if (d.endsWith('.part')) fs.rmSync(path.join(snapsDir, d), { recursive: true, force: true });
  }
  const snaps = snapshotsIn(hostDir);
  for (const m of snaps.slice(keep)) fs.rmSync(path.join(snapsDir, m.id), { recursive: true, force: true });
  const needed = new Set(snaps.slice(0, keep).flatMap((m) => m.media || []));
  const mediaDir = path.join(hostDir, 'media');
  for (const f of fs.readdirSync(mediaDir)) {
    if (!needed.has(f)) fs.rmSync(path.join(mediaDir, f), { force: true });
  }
}

/**
 * Restores one snapshot into dataDir. The server must be stopped while this
 * runs, or it will write its in-memory database back over the restored one.
 *
 * `smk` is this stick's master key, needed only if the backup is encrypted.
 * Whether a file is encrypted is decided by looking at the file, not by the
 * manifest's flag: media is shared between snapshots, so a club that switched
 * encryption on last week has old snapshots whose manifests say otherwise.
 *
 * Every GCM tag is checked before anything is renamed into place, so a stick
 * somebody has edited fails the restore instead of installing their data.
 */
function restore({ stickDir, host, id, dataDir, smk = null }) {
  if (!SAFE_NAME.test(host) || !SNAPSHOT_ID.test(id)) throw new BackupError('No such backup');
  const hostDir = hostDirFor(stickDir, host);
  const snapDir = path.join(hostDir, 'snapshots', id);
  const manifest = readJson(path.join(snapDir, 'manifest.json'));
  if (!manifest) throw new BackupError('That backup is missing or damaged');

  /** Is this file encrypted, and can we open it? */
  const sealed = (file) => {
    if (!enc.looksEncrypted(file)) return false;
    if (!smk) throw new BackupError('This backup is encrypted. Type the recovery code that was printed when backups were switched on.');
    return true;
  };
  const sizeOf = (file, enciphered) => (enciphered ? enc.plainSize(file) : fs.statSync(file).size);

  const dbFile = path.join(snapDir, 'db.json');
  if (!fs.existsSync(dbFile)) throw new BackupError('That backup’s database is damaged');
  let db;
  if (sealed(dbFile)) {
    const bytes = plainly(() => enc.decryptToBuffer(dbFile, smk, `snapshots/${id}/db.json`));
    try { db = JSON.parse(bytes.toString('utf8')); } catch { db = null; }
  } else {
    db = readJson(dbFile);
  }
  if (!db || !db.settings) throw new BackupError('That backup’s database is damaged');
  const missing = (manifest.media || []).filter((f) => !SAFE_NAME.test(f) || !fs.existsSync(path.join(hostDir, 'media', f)));
  if (missing.length) throw new BackupError(`That backup is missing ${missing.length} photo or video file(s)`);

  fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });
  for (const f of manifest.media || []) {
    const to = path.join(dataDir, 'media', f);
    const from = path.join(hostDir, 'media', f);
    const enciphered = sealed(from);
    if (fs.existsSync(to) && fs.statSync(to).size === sizeOf(from, enciphered)) continue;
    if (enciphered) plainly(() => enc.decryptFile(from, to, smk, `media/${f}`));
    else copyAtomic(from, to);
  }
  for (const f of DATA_FILES) {
    const from = path.join(snapDir, f);
    if (!fs.existsSync(from)) {
      if (f !== 'db.json') fs.rmSync(path.join(dataDir, f), { force: true });
      continue;
    }
    if (f === 'db.json') writeDb(db, path.join(dataDir, f));
    else if (sealed(from)) plainly(() => enc.decryptFile(from, path.join(dataDir, f), smk, `snapshots/${id}/${f}`));
    else copyAtomic(from, path.join(dataDir, f));
  }
  return manifest;
}

module.exports = { ROOT, KEEP, DATA_FILES, SAFE_NAME, SNAPSHOT_ID, BackupError, snapshotId, hostDirFor, listBackups, backup, prune, restore, mediaFiles };
