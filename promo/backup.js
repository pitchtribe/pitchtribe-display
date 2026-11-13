#!/usr/bin/env node
'use strict';
/* Exports the seeded instance as a PitchTribe backup, the same file the
   dashboard's Settings → Backups → Download backup produces.

   Usage:
     cd promo && node backup.js          (instance from seed.js still running)

   Env: BASE, PASSWORD and OUT as for seed.js and capture.js.
   Writes out/<club-slug>-promo-backup.tar.gz (see club.js). */

const fs = require('node:fs');
const path = require('node:path');
const { BACKUP_FILE } = require('./club');

const BASE = (process.env.BASE || 'http://127.0.0.1:8090').replace(/\/$/, '');
const PASSWORD = process.env.PASSWORD || 'promo-reel-2026';
const OUT_DIR = process.env.OUT || path.join(__dirname, 'out');

async function main() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pitchtribe': '1' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`Login failed: ${login.status} ${await login.text()}`);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('No session cookie after sign-in');

  const res = await fetch(`${BASE}/api/backup/download`, { headers: { cookie, 'x-pitchtribe': '1' } });
  if (!res.ok) throw new Error(`Backup download failed: ${res.status} ${await res.text()}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Backup is not gzip data');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, BACKUP_FILE);
  fs.writeFileSync(file, bytes);
  console.log(`Wrote ${path.relative(process.cwd(), file)} (${bytes.length} bytes)`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
