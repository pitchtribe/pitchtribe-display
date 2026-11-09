#!/usr/bin/env node
'use strict';
/* What encrypting backups costs, on the machine you run this on.
 *
 *   node bin/backup-bench.js [megabytes] [folder]
 *
 * Encryption was costed on the assumption that a Pi's ARMv8 crypto extensions
 * make AES-GCM nearly free next to a USB stick's write speed. That is the sort
 * of assumption worth checking on the actual hardware rather than believing,
 * so: run this on the Pi, and run it with the folder on a stick to get the
 * number that matters (the second block), not just the CPU's.
 *
 *   node bin/backup-bench.js 256 /run/pitchtribe-backup
 *
 * It writes and deletes temporary files in the folder, and touches nothing
 * PitchTribe owns. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const enc = require('../lib/backup-crypto');

const MB = 1024 * 1024;
const rate = (bytes, ms) => `${(bytes / MB / (ms / 1000)).toFixed(0)} MB/s`;

function time(fn) {
  const at = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - at) / 1e6;
}

function main(megabytes = 64, where = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(where, 'pt-bench-'));
  try {
    const bytes = megabytes * MB;
    const smk = enc.newMasterKey();
    const chunk = Buffer.alloc(MB, 7);
    const plain = path.join(dir, 'video.mp4');
    const sealed = path.join(dir, 'video.enc');
    const back = path.join(dir, 'back.mp4');

    const write = time(() => {
      const fd = fs.openSync(plain, 'w');
      for (let i = 0; i < megabytes; i++) fs.writeSync(fd, chunk);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    });
    const copy = time(() => { fs.copyFileSync(plain, path.join(dir, 'copy.mp4')); });
    const seal = time(() => enc.encryptFile(plain, sealed, smk, 'media/video.mp4'));
    const open = time(() => enc.decryptFile(sealed, back, smk, 'media/video.mp4'));
    const code = enc.newRecoveryCode();
    const wrap = time(() => enc.wrapMaster({ smk, machineKey: enc.newMasterKey(), recoveryCode: code }));
    const keys = enc.wrapMaster({ smk, machineKey: enc.newMasterKey(), recoveryCode: code });
    const unwrap = time(() => enc.unwrapMaster(keys, { recoveryCode: code }));

    console.log(`${os.cpus()[0].model} · ${os.cpus().length} cores · node ${process.version} · openssl ${process.versions.openssl}`);
    console.log(`${megabytes} MB in ${dir}`);
    console.log(`  plain write    ${write.toFixed(0)} ms  ${rate(bytes, write)}`);
    console.log(`  plain copy     ${copy.toFixed(0)} ms  ${rate(bytes, copy)}`);
    console.log(`  encrypt        ${seal.toFixed(0)} ms  ${rate(bytes, seal)}`);
    console.log(`  decrypt        ${open.toFixed(0)} ms  ${rate(bytes, open)}`);
    console.log(`  overhead per file: ${enc.OVERHEAD} bytes`);
    console.log(`  recovery code wrap   ${wrap.toFixed(0)} ms (scrypt N=${enc.SCRYPT.N}, r=${enc.SCRYPT.r})`);
    console.log(`  recovery code unwrap ${unwrap.toFixed(0)} ms — paid once, on a restore`);
    const slowdown = seal / Math.max(copy, 1);
    console.log(`\nEncrypting costs ${slowdown.toFixed(2)}× a plain copy here.`);
    console.log('Media is copied once per upload, not nightly; only db.json and the guest list are rewritten every night.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) main(Number(process.argv[2]) || 64, process.argv[3] || os.tmpdir());
module.exports = { main };
