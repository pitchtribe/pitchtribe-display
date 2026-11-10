#!/usr/bin/env node
'use strict';
/* Sets a new dashboard password and signs everyone out.
 *
 * Run by /usr/local/bin/pitchtribe-reset-password (deploy/reset-password.sh),
 * which stops the server first: the server keeps the database in memory and
 * would write the old password back on its next change.
 *
 *   PT_PASSWORD=… node bin/reset-password.js /var/lib/pitchtribe/db.json
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('../lib/auth');

const file = process.argv[2];
const password = process.env.PT_PASSWORD || '';
if (!file) {
  console.error('usage: PT_PASSWORD=… reset-password.js <path to db.json>');
  process.exit(2);
}
if (password.length < 8) {
  console.error('The password must be at least 8 characters.');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`${file} not found — has the dashboard been set up yet? If not, just open it and choose a password.`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
data.settings = data.settings || {};
data.settings.adminHash = auth.hashPassword(password);
// A new secret invalidates every existing session, so whoever had the old
// password is signed out too.
data.settings.sessionSecret = crypto.randomBytes(32).toString('hex');

const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
// 0600, set explicitly: this runs as root, where the umask would leave the file
// holding the new password hash, the signing secret and every API key readable
// by anyone else with an account on the Pi. The service itself writes it 0600.
fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
fs.chmodSync(tmp, 0o600);
fs.renameSync(tmp, file);
console.log('Password changed. Everyone signed in to the dashboard has been signed out.');
