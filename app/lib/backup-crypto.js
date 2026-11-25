'use strict';
/* Encryption for the backups on a USB stick.
 *
 * A stick in a drawer behind the bar holds the club's password hash, every
 * guest email address it has ever collected and every photo it has ever
 * uploaded. Nothing on the Pi protects any of that once the stick walks.
 *
 * Two jobs pull in opposite directions, and that is the whole reason this file
 * looks the way it does:
 *
 *   - The nightly backup runs at about 03:30 with nobody present, so the Pi has
 *     to be able to encrypt on its own — it needs a key it holds itself.
 *   - A restore happens *after the memory card has died*, so the key cannot
 *     live only on that card. Somebody has to be holding one too.
 *
 * So there are two keys, and one key underneath both of them:
 *
 *   stick master key (SMK)   32 random bytes, made once per stick. Every file
 *                            on the stick is encrypted under a key derived
 *                            from it. It is never written down bare.
 *   machine key              32 random bytes in <dataDir>/backup-key, 0600 and
 *                            owned by root. Wraps the SMK so 03:30 works. It is
 *                            deliberately left out of every backup — a key
 *                            carried on the stick it protects is not a key.
 *   recovery code            24 characters, generated (never club-chosen),
 *                            printed, and also wraps the SMK. This is what
 *                            opens a stick on a freshly flashed card.
 *
 * `keys.json` on the stick holds those two wraps and nothing else. Lose it and
 * every snapshot on that stick is gone, so it is written temp-then-renamed like
 * everything else here.
 *
 * What this does not protect against, stated plainly: somebody who takes the
 * Pi *and* the stick gets both. The machine key is on the Pi by design, and the
 * recovery code is kept beside it (0600) so a signed-in admin can be shown it
 * again. A club that loses the card and the printed code loses the backup —
 * which is why the code is generated, printable, and re-displayable.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Thrown for anything a club could plausibly act on: a wrong code, a damaged file. */
class CryptoError extends Error {}

const MAGIC = Buffer.from('PTENC1', 'ascii'); // 6 bytes, so an encrypted file is recognisable
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 2 + NONCE_BYTES; // magic, version, reserved, nonce
const OVERHEAD = HEADER_BYTES + TAG_BYTES;
const CHUNK = 1024 * 1024; // a club's videos do not fit in a Pi's memory

const KEY_FILE = 'backup-key';
const RECOVERY_FILE = 'backup-recovery.json';
const STICK_KEYS = 'keys.json';

/* The recovery code is read off a printed card by a volunteer, so the alphabet
   is Crockford's base32: no I, L, O or U, and 1/l and 0/O fold together on the
   way back in. 24 characters is 120 bits — far past anything worth attacking,
   which is also why the scrypt cost below is insurance rather than the defence. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 24;
const SCRYPT = { N: 1 << 17, r: 8, p: 1 }; // ~128 MiB, about a second on a Pi 4
const SCRYPT_MAXMEM = 192 * 1024 * 1024;

const b64 = (buf) => buf.toString('base64');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64');

/** A key for one file, so no two files on the stick share one. */
function fileKey(smk, label) {
  return Buffer.from(crypto.hkdfSync('sha256', smk, Buffer.alloc(0), `pitchtribe-backup-v1:${label}`, 32));
}

const newMasterKey = () => crypto.randomBytes(32);

// ------------------------------------------------------------------ per file

function header(nonce) {
  const h = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(h, 0);
  h[MAGIC.length] = VERSION;
  h[MAGIC.length + 1] = 0;
  nonce.copy(h, MAGIC.length + 2);
  return h;
}

/** True if this file was written by encryptFile/encryptBuffer. */
function looksEncrypted(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(MAGIC.length + 1);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return read === head.length && head.subarray(0, MAGIC.length).equals(MAGIC) && head[MAGIC.length] === VERSION;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** What an encrypted file holds, in plain bytes. */
const plainSize = (file) => Math.max(0, fs.statSync(file).size - OVERHEAD);

function cipherFor(smk, label, nonce) {
  const c = crypto.createCipheriv('aes-256-gcm', fileKey(smk, label), nonce);
  c.setAAD(Buffer.from(label, 'utf8'));
  return c;
}

/* `label` is the file's place on the stick — `media/a1.jpg`, or
   `snapshots/<id>/db.json`. It picks the key and is authenticated, so a file
   cannot be moved between snapshots, or swapped for another one, unnoticed. */
function writeEncrypted(to, label, smk, read, { mode } = {}) {
  const tmp = `${to}.part`;
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = cipherFor(smk, label, nonce);
  const out = fs.openSync(tmp, 'w', mode === undefined ? 0o666 : mode);
  try {
    if (mode !== undefined) fs.fchmodSync(out, mode); // root's umask would otherwise widen it
    fs.writeSync(out, header(nonce));
    for (let chunk = read(); chunk !== null; chunk = read()) {
      const part = cipher.update(chunk);
      if (part.length) fs.writeSync(out, part);
    }
    const tail = cipher.final();
    if (tail.length) fs.writeSync(out, tail);
    fs.writeSync(out, cipher.getAuthTag());
  } finally {
    fs.closeSync(out);
  }
  fs.renameSync(tmp, to);
}

/** Encrypts `from` to `to`. Bounded memory: a 2 GB video is read a chunk at a time. */
function encryptFile(from, to, smk, label, opts) {
  const fd = fs.openSync(from, 'r');
  const buf = Buffer.alloc(CHUNK);
  try {
    writeEncrypted(to, label, smk, () => {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      return n > 0 ? buf.subarray(0, n) : null;
    }, opts);
  } finally {
    fs.closeSync(fd);
  }
}

/** Encrypts bytes already in memory — db.json, which is built rather than copied. */
function encryptBuffer(buffer, to, smk, label, opts) {
  let done = false;
  writeEncrypted(to, label, smk, () => {
    if (done) return null;
    done = true;
    return buffer;
  }, opts);
}

function openEncrypted(from, smk, label) {
  // Size the descriptor we are about to read, not the path. If the file were
  // swapped between a statSync and the open, the tag would be read at the
  // wrong offset and a perfectly good backup would come back "damaged".
  const fd = fs.openSync(from, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < OVERHEAD) throw new CryptoError('That backup file is damaged');
    const head = Buffer.alloc(HEADER_BYTES);
    fs.readSync(fd, head, 0, HEADER_BYTES, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new CryptoError('That backup file is damaged');
    if (head[MAGIC.length] !== VERSION) throw new CryptoError('That backup was written by a newer version of PitchTribe');
    const nonce = head.subarray(MAGIC.length + 2);
    const tag = Buffer.alloc(TAG_BYTES);
    fs.readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
    const d = crypto.createDecipheriv('aes-256-gcm', fileKey(smk, label), nonce);
    d.setAAD(Buffer.from(label, 'utf8'));
    d.setAuthTag(tag); // GCM only tells us at final(), so nothing is renamed before then
    return { fd, decipher: d, body: size - OVERHEAD, close: () => fs.closeSync(fd) };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

const damaged = () => new CryptoError('That backup is damaged, or the USB stick has been tampered with');

/** Decrypts into memory. For db.json and friends, which are small and get parsed. */
function decryptToBuffer(from, smk, label) {
  const { fd, decipher, body, close } = openEncrypted(from, smk, label);
  try {
    const parts = [];
    const buf = Buffer.alloc(CHUNK);
    for (let left = body, at = HEADER_BYTES; left > 0;) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, left), at);
      if (n <= 0) throw damaged();
      parts.push(Buffer.from(decipher.update(buf.subarray(0, n))));
      left -= n;
      at += n;
    }
    try { parts.push(decipher.final()); } catch { throw damaged(); }
    return Buffer.concat(parts);
  } finally {
    close();
  }
}

/**
 * Decrypts `from` to `to`, and only puts it in place once the tag checks out:
 * a tampered stick must fail closed rather than restore somebody else's data.
 */
function decryptFile(from, to, smk, label, { mode } = {}) {
  const { fd, decipher, body, close } = openEncrypted(from, smk, label);
  const tmp = `${to}.part`;
  let out;
  try {
    out = fs.openSync(tmp, 'w', mode === undefined ? 0o666 : mode);
    if (mode !== undefined) fs.fchmodSync(out, mode);
    const buf = Buffer.alloc(CHUNK);
    for (let left = body, at = HEADER_BYTES; left > 0;) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, left), at);
      if (n <= 0) throw damaged();
      const part = decipher.update(buf.subarray(0, n));
      if (part.length) fs.writeSync(out, part);
      left -= n;
      at += n;
    }
    let tail;
    try { tail = decipher.final(); } catch { throw damaged(); }
    if (tail.length) fs.writeSync(out, tail);
    fs.closeSync(out);
    out = undefined;
    fs.renameSync(tmp, to);
  } catch (err) {
    if (out !== undefined) fs.closeSync(out);
    fs.rmSync(tmp, { force: true });
    throw err;
  } finally {
    close();
  }
}

// ------------------------------------------------------------ recovery code

/** A fresh code: 24 Crockford base32 characters. 256/32 is exact, so no bias. */
function newRecoveryCode() {
  const bytes = crypto.randomBytes(CODE_CHARS);
  let code = '';
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
  return code;
}

/** `ABCD-EFGH-…`, which is how it is printed and how it reads back to someone typing. */
const formatCode = (code) => (code || '').match(/.{1,4}/g).join('-');

/**
 * Takes what a volunteer typed and gives back the canonical code.
 * Spaces, dashes and lower case are all fine; so are 1/l and 0/O, which is
 * most of why the alphabet leaves those letters out in the first place.
 */
function normalizeCode(text) {
  const cleaned = String(text || '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/[^0-9A-Z]/g, '')
    .split('')
    .filter((c) => ALPHABET.includes(c))
    .join('');
  if (cleaned.length !== CODE_CHARS) {
    throw new CryptoError(`A recovery code is ${CODE_CHARS} letters and numbers — check the printed card.`);
  }
  return cleaned;
}

// -------------------------------------------------------------- key storage

const machineKeyPath = (dataDir) => path.join(dataDir, KEY_FILE);
const recoveryPath = (dataDir) => path.join(dataDir, RECOVERY_FILE);
const stickKeysPath = (hostDir) => path.join(hostDir, STICK_KEYS);

function readMachineKey(dataDir) {
  try {
    const key = fs.readFileSync(machineKeyPath(dataDir));
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function writeAtomic(to, body, mode) {
  const tmp = `${to}.part`;
  fs.writeFileSync(tmp, body, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, to);
}

/** The machine key, making one if this Pi has not got one yet. Root only, 0600. */
function ensureMachineKey(dataDir) {
  const existing = readMachineKey(dataDir);
  if (existing) return existing;
  const key = newMasterKey();
  writeAtomic(machineKeyPath(dataDir), key, 0o600);
  return key;
}

function readRecoveryCode(dataDir) {
  try {
    const { code } = JSON.parse(fs.readFileSync(recoveryPath(dataDir), 'utf8'));
    return normalizeCode(code);
  } catch {
    return null;
  }
}

/* Kept on the Pi so a signed-in admin can be shown it again — a club that is
   told "write this down, once" and then cannot find the paper has no backup.
   0600, and the service user owns it so the dashboard can read it: anyone who
   can read it can already read db.json and every photo. */
function writeRecoveryCode(dataDir, code, at = new Date()) {
  const normalized = normalizeCode(code);
  writeAtomic(recoveryPath(dataDir), `${JSON.stringify({ code: normalized, at: at.toISOString() }, null, 2)}\n`, 0o600);
  return normalized;
}

/** This club's recovery code, generating and storing one the first time. */
function ensureRecoveryCode(dataDir, at = new Date()) {
  return readRecoveryCode(dataDir) || writeRecoveryCode(dataDir, newRecoveryCode(), at);
}

// ------------------------------------------------------- wrapping the SMK

function wrapTo(smk, kek) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', kek, nonce);
  const ct = Buffer.concat([c.update(smk), c.final()]);
  return { nonce: b64(nonce), ct: b64(ct), tag: b64(c.getAuthTag()) };
}

function unwrapFrom(wrap, kek) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', kek, unb64(wrap.nonce));
    d.setAuthTag(unb64(wrap.tag));
    const smk = Buffer.concat([d.update(unb64(wrap.ct)), d.final()]);
    return smk.length === 32 ? smk : null;
  } catch {
    return null; // wrong key, or a damaged keys.json
  }
}

const machineKek = (machineKey) => Buffer.from(crypto.hkdfSync('sha256', machineKey, Buffer.alloc(0), 'pitchtribe-stick-wrap-v1', 32));

/* The parameters come off the stick, and the stick belongs to whoever is
   holding it, so they are clamped: an attacker's keys.json asking for N=2^30
   would otherwise be a way to make a Pi try to allocate a terabyte. */
function recoveryKek(code, salt, params = SCRYPT) {
  const N = Number(params.N);
  const r = Number(params.r);
  const p = Number(params.p);
  if (!Number.isInteger(N) || N < 16384 || N > (1 << 20) || (N & (N - 1)) !== 0) throw new CryptoError('That USB stick’s keys.json is damaged');
  if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) throw new CryptoError('That USB stick’s keys.json is damaged');
  return crypto.scryptSync(normalizeCode(code), salt, 32, { N, r, p, maxmem: Math.max(SCRYPT_MAXMEM, 256 * N * r) });
}

/** The two wraps that go on the stick as keys.json. Neither holds the SMK bare. */
function wrapMaster({ smk, machineKey, recoveryCode }) {
  const salt = crypto.randomBytes(16);
  return {
    format: 1,
    note: 'PitchTribe keeps this stick’s encryption key here, locked to this Pi and to your printed recovery code. Do not delete it: the backups on this stick cannot be read without it.',
    machine: machineKey ? wrapTo(smk, machineKek(machineKey)) : null,
    recovery: {
      kdf: 'scrypt',
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      salt: b64(salt),
      ...wrapTo(smk, recoveryKek(recoveryCode, salt)),
    },
  };
}

/**
 * Opens keys.json. The machine key is tried first because it costs nothing;
 * the recovery code costs a second of scrypt and is the dead-card path.
 * Returns { smk, via } or null when neither key fits.
 */
function unwrapMaster(keys, { machineKey = null, recoveryCode = null } = {}) {
  if (!keys || typeof keys !== 'object') return null;
  if (machineKey && keys.machine) {
    const smk = unwrapFrom(keys.machine, machineKek(machineKey));
    if (smk) return { smk, via: 'machine' };
  }
  if (recoveryCode && keys.recovery && keys.recovery.salt) {
    const r = keys.recovery;
    let smk = null;
    try {
      smk = unwrapFrom(r, recoveryKek(recoveryCode, unb64(r.salt), { N: Number(r.N) || SCRYPT.N, r: Number(r.r) || SCRYPT.r, p: Number(r.p) || SCRYPT.p }));
    } catch {
      smk = null; // an unusable kdf block reads the same as a wrong code
    }
    if (smk) return { smk, via: 'recovery' };
  }
  return null;
}

function readStickKeys(hostDir) {
  try { return JSON.parse(fs.readFileSync(stickKeysPath(hostDir), 'utf8')); } catch { return null; }
}

/* Temp-then-rename, like every other file on the stick: keys.json is the one
   file whose loss costs the club every snapshot on that stick. */
function writeStickKeys(hostDir, keys) {
  writeAtomic(stickKeysPath(hostDir), `${JSON.stringify(keys, null, 2)}\n`, 0o600);
}

/**
 * The key for writing to this stick: opens keys.json, or starts it.
 *
 * It also repairs the machine wrap. After a restore onto a fresh card the Pi
 * has a brand-new machine key, so the stick's own machine wrap no longer fits
 * and only the recovery code opened it. Writing the wrap back here means the
 * club types the code once, not every night.
 */
function ensureStickKeys({ hostDir, machineKey, recoveryCode }) {
  fs.mkdirSync(hostDir, { recursive: true });
  const existing = readStickKeys(hostDir);
  const opened = existing ? unwrapMaster(existing, { machineKey, recoveryCode }) : null;
  if (existing && !opened) {
    throw new CryptoError('This USB stick already holds encrypted backups that this Pi cannot open. Use a different stick, or restore from it first.');
  }
  const smk = opened ? opened.smk : newMasterKey();
  if (!opened || opened.via !== 'machine') writeStickKeys(hostDir, wrapMaster({ smk, machineKey, recoveryCode }));
  return { smk, created: !existing, rewrapped: Boolean(opened) && opened.via !== 'machine' };
}

/**
 * The key for reading this stick, or null when it holds plain backups.
 * Throws when the stick is encrypted and neither key fits, because "no key"
 * and "wrong code" need different things from the club.
 */
function openStick({ hostDir, machineKey = null, recoveryCode = null }) {
  const keys = readStickKeys(hostDir);
  if (!keys) return null;
  const opened = unwrapMaster(keys, { machineKey, recoveryCode });
  if (opened) return opened;
  if (recoveryCode) throw new CryptoError('That recovery code does not match this USB stick. Check the printed card.');
  throw new CryptoError('These backups are encrypted. Type the recovery code that was printed when backups were switched on.');
}

module.exports = {
  CryptoError,
  OVERHEAD,
  HEADER_BYTES,
  TAG_BYTES,
  CODE_CHARS,
  KEY_FILE,
  RECOVERY_FILE,
  STICK_KEYS,
  SCRYPT,
  newMasterKey,
  fileKey,
  looksEncrypted,
  plainSize,
  encryptFile,
  encryptBuffer,
  decryptFile,
  decryptToBuffer,
  newRecoveryCode,
  formatCode,
  normalizeCode,
  machineKeyPath,
  recoveryPath,
  stickKeysPath,
  readMachineKey,
  ensureMachineKey,
  readRecoveryCode,
  writeRecoveryCode,
  ensureRecoveryCode,
  wrapMaster,
  unwrapMaster,
  readStickKeys,
  writeStickKeys,
  ensureStickKeys,
  openStick,
};
